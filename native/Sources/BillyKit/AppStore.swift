import Foundation
import Observation

/// Coarse buckets of the core task state machine (core/src/domain/machines.ts).
public enum TaskGroup: String, Sendable, CaseIterable {
    case active, waiting, paused, blocked, completed, ended

    public static func of(_ status: String) -> TaskGroup {
        switch status {
        case "RECEIVED", "PLANNING", "READY", "RUNNING", "VERIFYING", "RECOVERING", "RECONCILING": return .active
        case "PAUSED_BY_OWNER", "CANCEL_REQUESTED": return .paused
        case "BLOCKED_EXTERNAL": return .blocked
        case "COMPLETED": return .completed
        case "CANCELLED", "FAILED": return .ended
        default: return status.hasPrefix("WAITING_") ? .waiting : .active
        }
    }
}

public enum TaskFilter: String, Sendable, CaseIterable, Identifiable {
    case all, active, waiting, paused, blocked, completed, ended
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .all: return "All"
        case .active: return "Running"
        case .waiting: return "Waiting"
        case .paused: return "Paused"
        case .blocked: return "Blocked"
        case .completed: return "Completed"
        case .ended: return "Failed / Cancelled"
        }
    }
    public func matches(_ status: String) -> Bool {
        self == .all || TaskGroup.of(status).rawValue == rawValue
    }
}

/// Counts shown in the menu bar, derived from /v1/status `tasks` (status → count).
public struct TaskCounts: Sendable, Equatable {
    public var running = 0, paused = 0, blocked = 0, waiting = 0, completed = 0, ended = 0
    public init() {}
    public init(_ byStatus: [String: Int]) {
        for (status, n) in byStatus {
            switch TaskGroup.of(status) {
            case .active: running += n
            case .paused: paused += n
            case .blocked: blocked += n
            case .waiting: waiting += n
            case .completed: completed += n
            case .ended: ended += n
            }
        }
    }
    /// "Blocked" in the menu includes tasks waiting on a prerequisite.
    public var needsAttention: Int { blocked + waiting }
}

public enum ConnectionState: Equatable, Sendable {
    case connecting
    case connected
    case notRunning(String)   // no socket / token: service stopped or not installed
    case error(String)
}

/// Single source of UI state. Authoritative state lives in the core; this is a
/// cache refreshed by polling (status every interval, tasks via the event cursor).
@MainActor @Observable
public final class AppStore {
    public let api: any BillyAPI

    public var connection: ConnectionState = .connecting
    public var status: StatusResponse?
    public var tasks: [TaskSummary] = []
    public var filter: TaskFilter = .all
    public private(set) var selectedTaskID: String?
    public var detail: TaskDetail?
    public var doctor: DoctorReport?
    public var policy: Grant?
    public var budgets: [BudgetRow] = []
    public var lastError: String?
    public var lastStopAck: StopAck?
    public private(set) var eventCursor = 0
    public private(set) var bootstrapped = false

    @ObservationIgnored private var pollTask: Task<Void, Never>?

    public init(api: any BillyAPI) { self.api = api }

    // MARK: derived

    public var filteredTasks: [TaskSummary] { tasks.filter { filter.matches($0.status) } }
    public var counts: TaskCounts { TaskCounts(status?.tasks ?? [:]) }
    public var isStopped: Bool { status?.stop.stopped ?? false }
    public var ownsDesktop: Bool { status?.ownsDesktop ?? false }
    public var isConnected: Bool { connection == .connected }

    // MARK: polling

    /// Polls until `stopPolling()`; network work never runs on the main thread.
    public func startPolling(interval: Duration = .seconds(2)) {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.tick()
                try? await Task.sleep(for: interval)
            }
        }
    }

    public func stopPolling() { pollTask?.cancel(); pollTask = nil }

    /// One polling cycle: status, then incremental task changes.
    public func tick() async {
        await refreshStatus()
        guard connection == .connected else { bootstrapped = false; return }
        if !bootstrapped { await bootstrap() } else { await syncEvents() }
    }

    public func refreshStatus() async {
        do {
            status = try await api.status()
            connection = .connected
        } catch {
            connection = Self.classify(error)
        }
    }

    /// Full load after (re)connecting; fast-forwards the event cursor so later
    /// polls only fetch what changed.
    public func bootstrap() async {
        do {
            tasks = try await api.tasks(limit: 200)
            var page = try await api.events(after: eventCursor)
            while let last = page.last {
                eventCursor = last.seq
                if page.count < 500 { break }
                page = try await api.events(after: eventCursor)
            }
            bootstrapped = true
            if let id = selectedTaskID { detail = try? await api.task(id) }
        } catch { record(error) }
        await refreshSettings()
    }

    /// Applies events after the cursor. Returns true when the task list changed.
    @discardableResult
    public func syncEvents() async -> Bool {
        do {
            var touched = Set<String>()
            var taskDomain = false, settingsDomain = false
            while true {
                let page = try await api.events(after: eventCursor)
                for e in page {
                    eventCursor = max(eventCursor, e.seq)
                    touched.insert(e.entity_id)
                    if e.domain == "task" { taskDomain = true }
                    if e.domain == "grant" || e.domain == "budget" { settingsDomain = true }
                }
                if page.count < 500 { break }
            }
            if taskDomain { tasks = try await api.tasks(limit: 200) }
            if let id = selectedTaskID, touched.contains(id) { detail = try await api.task(id) }
            if settingsDomain { await refreshSettings() }
            return taskDomain
        } catch { record(error); return false }
    }

    public func refreshSettings() async {
        doctor = try? await api.doctor()
        policy = (try? await api.policy()) ?? nil
        budgets = (try? await api.budget()) ?? []
    }

    public func refreshDoctor() async {
        do { doctor = try await api.doctor() } catch { record(error) }
    }

    // MARK: selection

    public func select(_ id: String?) async {
        selectedTaskID = id
        guard let id else { detail = nil; return }
        if detail?.task_id != id { detail = nil }
        do { detail = try await api.task(id) } catch { record(error) }
    }

    // MARK: owner commands

    /// Admits a typed or spoken command. Returns the new task id on success.
    @discardableResult
    public func submitTask(goal: String, source: TaskSource = .localApp, clientMessageID: String = newClientMessageID()) async -> String? {
        let text = goal.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        do {
            let r = try await api.createTask(goal: text, clientMessageID: clientMessageID, source: source)
            await syncEvents()
            if let t = r.task, !tasks.contains(where: { $0.task_id == t.task_id }) { tasks.insert(t, at: 0) }
            lastError = nil
            return r.task_id
        } catch { record(error); return nil }
    }

    /// Emergency stop: independent of any model; one local request to the core.
    public func stop(reason: String = "owner pressed Stop in Billy.app") async {
        do {
            lastStopAck = try await api.stop(reason: reason)
            lastError = nil
        } catch { record(error) }
        await refreshStatus()
        await syncEvents()
    }

    /// Clears the global stop latch. Tasks paused by the stop stay paused until resumed.
    public func clearStop() async {
        do { _ = try await api.clearStop() } catch { record(error) }
        await refreshStatus()
    }

    public func control(_ id: String, _ op: TaskControl) async {
        do { _ = try await api.control(id, op) } catch { record(error) }
        await syncEvents()
        if selectedTaskID == id { detail = try? await api.task(id) }
    }

    public func revise(_ id: String, goal: String) async {
        do { _ = try await api.revise(id, goal: goal, clientMessageID: newClientMessageID(prefix: "rev")) } catch { record(error) }
        await syncEvents()
    }

    /// Menu "Pause all": pauses every active or waiting task (explicit owner pause).
    public func pauseAll() async {
        for t in tasks where [.active, .waiting].contains(TaskGroup.of(t.status)) {
            do { _ = try await api.control(t.task_id, .pause) } catch { record(error) }
        }
        await syncEvents()
    }

    /// Menu "Resume": clears a global stop if set, then resumes owner-paused tasks.
    public func resumeAll() async {
        if isStopped { await clearStop() }
        for t in tasks where t.status == "PAUSED_BY_OWNER" {
            do { _ = try await api.control(t.task_id, .resume) } catch { record(error) }
        }
        await syncEvents()
    }

    public func savePolicy(_ draft: GrantDraft) async -> Bool {
        do {
            policy = try await api.putPolicy(draft.update(base: policy?.scope))
            await refreshDoctor()
            lastError = nil
            return true
        } catch { record(error); return false }
    }

    public func saveBudget(scope: String, ceilingUSD: Double, period: String) async -> Bool {
        do {
            _ = try await api.putBudget(BudgetUpdate(scope: scope, ceiling_usd: ceilingUSD, period: period))
            budgets = (try? await api.budget()) ?? budgets
            await refreshDoctor()
            lastError = nil
            return true
        } catch { record(error); return false }
    }

    // MARK: errors

    private func record(_ error: Error) {
        let c = Self.classify(error)
        if case .notRunning = c { connection = c; bootstrapped = false }
        lastError = String(describing: error)
    }

    static func classify(_ error: Error) -> ConnectionState {
        if let t = error as? TransportError, t.isNotRunning { return .notRunning("Billy's core service is not running") }
        if let c = error as? ClientError, case .noToken = c { return .notRunning(c.description) }
        return .error(String(describing: error))
    }
}
