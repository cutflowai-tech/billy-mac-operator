import BillyKit
import Foundation

/// In-memory BillyAPI that records calls, for view-model tests.
final class RecordingAPI: BillyAPI, @unchecked Sendable {
    private let lock = NSLock()
    private var _calls: [String] = []
    var calls: [String] { lock.withLock { _calls } }
    private(set) var created: [(goal: String, source: TaskSource)] = []

    var statusValue = try! decode(StatusResponse.self, Samples.status)
    var taskList: [TaskSummary] = try! decode([TaskSummary].self, Samples.tasks)
    /// All events the "daemon" has; `events(after:)` pages them 500 at a time like the core.
    var allEvents: [EventRow] = []
    var failWith: Error?

    private func log(_ s: String) throws {
        lock.withLock { _calls.append(s) }
        if let failWith { throw failWith }
    }

    func status() async throws -> StatusResponse { try log("GET /v1/status"); return statusValue }
    func doctor() async throws -> DoctorReport { try log("GET /v1/doctor"); return try decode(DoctorReport.self, Samples.doctor) }
    func tasks(limit: Int) async throws -> [TaskSummary] { try log("GET /v1/tasks"); return taskList }
    func task(_ id: String) async throws -> TaskDetail { try log("GET /v1/tasks/\(id)"); return try decode(TaskDetail.self, Samples.taskDetail) }
    func events(after: Int) async throws -> [EventRow] {
        try log("GET /v1/events?after=\(after)")
        return Array(allEvents.filter { $0.seq > after }.prefix(500))
    }
    func createTask(goal: String, clientMessageID: String, source: TaskSource) async throws -> CommandResponse {
        try log("POST /v1/tasks \(source.rawValue)")
        lock.withLock { created.append((goal, source)) }
        return try decode(CommandResponse.self, Samples.createTask)
    }
    func control(_ id: String, _ op: TaskControl) async throws -> TaskSummary {
        try log("POST /v1/tasks/\(id)/\(op.rawValue)")
        return taskList.first { $0.task_id == id } ?? taskList[0]
    }
    func revise(_ id: String, goal: String, clientMessageID: String) async throws -> CommandResponse {
        try log("POST /v1/tasks/\(id)/revise"); return try decode(CommandResponse.self, Samples.createTask)
    }
    func stop(reason: String) async throws -> StopAck { try log("POST /v1/stop"); return try decode(StopAck.self, Samples.stopAck) }
    func clearStop() async throws -> StopLatch { try log("POST /v1/stop/clear"); return try decode(StopLatch.self, Samples.stopClear) }
    func policy() async throws -> Grant? { try log("GET /v1/policy"); return nil }
    func putPolicy(_ update: PolicyUpdate) async throws -> Grant { try log("PUT /v1/policy"); return try decode(Grant.self, Samples.policy) }
    func budget() async throws -> [BudgetRow] { try log("GET /v1/budget"); return [] }
    func putBudget(_ update: BudgetUpdate) async throws -> BudgetUpdateResponse {
        try log("PUT /v1/budget"); return try decode(BudgetUpdateResponse.self, Samples.budgetPut)
    }

    static func event(_ seq: Int, domain: String = "task", entity: String = "t") -> EventRow {
        EventRow(seq: seq, domain: domain, entity_id: entity, kind: "transition", at: "2026-10-11T00:00:00.000Z")
    }
}

/// Scripted recognizer: tracks whether the "microphone" is on.
@MainActor
final class FakeRecognizer: SpeechRecognizing {
    var authorized = true
    var startError: Error?
    private(set) var isCapturing = false
    private(set) var starts = 0, finishes = 0, cancels = 0
    private var onTranscript: (@MainActor (String) -> Void)?
    var finalText: String?

    func authorize() async -> Bool { authorized }
    func start(localeID: String, onTranscript: @escaping @MainActor (String) -> Void,
               onError: @escaping @MainActor (String) -> Void) throws {
        if let startError { throw startError }
        starts += 1
        isCapturing = true
        self.onTranscript = onTranscript
    }
    /// Simulates a partial result arriving from the recognizer.
    func hear(_ text: String) { onTranscript?(text) }
    func finish() async -> String? { finishes += 1; isCapturing = false; return finalText }
    func cancel() { cancels += 1; isCapturing = false }
}

func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}
