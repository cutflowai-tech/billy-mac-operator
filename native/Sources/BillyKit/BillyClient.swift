import Foundation

/// Where the core keeps its state. `BILLY_DATA_DIR` overrides the default
/// (~/Library/Application Support/Billy) for development and tests.
public struct BillyPaths: Sendable, Equatable {
    public var dataDir: URL
    public var runDir: URL { dataDir.appendingPathComponent("run") }
    public var socketPath: String { runDir.appendingPathComponent("billyd.sock").path }
    public var tokenPath: String { runDir.appendingPathComponent("api.token").path }

    public init(dataDir: URL) { self.dataDir = dataDir }

    public static func resolve(environment: [String: String] = ProcessInfo.processInfo.environment) -> BillyPaths {
        if let d = environment["BILLY_DATA_DIR"], !d.isEmpty {
            return BillyPaths(dataDir: URL(fileURLWithPath: (d as NSString).expandingTildeInPath))
        }
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return BillyPaths(dataDir: support.appendingPathComponent("Billy"))
    }
}

public enum ClientError: Error, Equatable, CustomStringConvertible {
    case noToken(String)
    case http(Int, String)
    case decode(String)
    public var description: String {
        switch self {
        case .noToken(let p): return "Billy's core service is not set up yet (no API token at \(p))"
        case .http(let s, let m): return "billyd returned \(s): \(m)"
        case .decode(let m): return "unexpected response from billyd: \(m)"
        }
    }
}

/// Everything the UI needs from the daemon. The store depends on this protocol
/// so view-model logic can be tested without a socket.
public protocol BillyAPI: Sendable {
    func status() async throws -> StatusResponse
    func doctor() async throws -> DoctorReport
    func tasks(limit: Int) async throws -> [TaskSummary]
    func task(_ id: String) async throws -> TaskDetail
    func events(after: Int) async throws -> [EventRow]
    func createTask(goal: String, clientMessageID: String, source: TaskSource) async throws -> CommandResponse
    func control(_ id: String, _ op: TaskControl) async throws -> TaskSummary
    func revise(_ id: String, goal: String, clientMessageID: String) async throws -> CommandResponse
    func stop(reason: String) async throws -> StopAck
    func clearStop() async throws -> StopLatch
    func policy() async throws -> Grant?
    func putPolicy(_ update: PolicyUpdate) async throws -> Grant
    func budget() async throws -> [BudgetRow]
    func putBudget(_ update: BudgetUpdate) async throws -> BudgetUpdateResponse
}

public enum TaskControl: String, Sendable { case pause, resume, cancel }

/// HTTP client for billyd over its Unix domain socket. Blocking socket work is
/// moved to a background queue so callers on the main actor never block.
public final class BillyClient: BillyAPI {
    public let paths: BillyPaths
    private let timeout: TimeInterval
    private static let queue = DispatchQueue(label: "com.billy.app.client", qos: .userInitiated, attributes: .concurrent)

    public init(paths: BillyPaths, timeout: TimeInterval = 10) {
        self.paths = paths; self.timeout = timeout
    }

    // MARK: transport

    /// Token is re-read per request so a reinstalled core (new token) is picked up.
    private func token() throws -> String {
        guard let t = try? String(contentsOfFile: paths.tokenPath, encoding: .utf8) else { throw ClientError.noToken(paths.tokenPath) }
        return t.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public func raw(_ method: String, _ path: String, body: Data? = nil) async throws -> HTTPResponse {
        var headers: [(String, String)] = [
            ("Host", "billyd"),
            ("Authorization", "Bearer \(try token())"),
            ("Accept", "application/json"),
            ("Connection", "close"),
        ]
        if body != nil { headers.append(("Content-Type", "application/json")) }
        let request = HTTPRequest(method: method, path: path, headers: headers, body: body)
        let transport = UnixSocketTransport(path: paths.socketPath, timeout: timeout)
        return try await withCheckedThrowingContinuation { cont in
            Self.queue.async {
                do { cont.resume(returning: try transport.roundTrip(request)) }
                catch { cont.resume(throwing: error) }
            }
        }
    }

    private func call<T: Decodable>(_ method: String, _ path: String, as type: T.Type) async throws -> T {
        try await call(method, path, Optional<Int>.none, as: type)
    }

    private func call<T: Decodable, B: Encodable>(_ method: String, _ path: String, _ body: B?, as: T.Type) async throws -> T {
        let data = try body.map { try JSONEncoder().encode($0) }
        let resp = try await raw(method, path, body: data)
        guard (200..<300).contains(resp.status) else {
            let msg = (try? JSONDecoder().decode(APIErrorBody.self, from: resp.body).error) ?? String(decoding: resp.body, as: UTF8.self)
            throw ClientError.http(resp.status, msg)
        }
        do { return try JSONDecoder().decode(T.self, from: resp.body) }
        catch { throw ClientError.decode("\(path): \(error)") }
    }

    // MARK: endpoints

    public func status() async throws -> StatusResponse { try await call("GET", "/v1/status", as: StatusResponse.self) }
    public func doctor() async throws -> DoctorReport { try await call("GET", "/v1/doctor", as: DoctorReport.self) }
    public func tasks(limit: Int = 200) async throws -> [TaskSummary] { try await call("GET", "/v1/tasks?limit=\(limit)", as: [TaskSummary].self) }
    public func task(_ id: String) async throws -> TaskDetail { try await call("GET", "/v1/tasks/\(id)", as: TaskDetail.self) }
    public func events(after: Int) async throws -> [EventRow] { try await call("GET", "/v1/events?after=\(after)", as: [EventRow].self) }

    public func createTask(goal: String, clientMessageID: String, source: TaskSource) async throws -> CommandResponse {
        try await call("POST", "/v1/tasks", NewTaskCommand(goal: goal, client_message_id: clientMessageID, source: source), as: CommandResponse.self)
    }
    public func control(_ id: String, _ op: TaskControl) async throws -> TaskSummary {
        try await call("POST", "/v1/tasks/\(id)/\(op.rawValue)", as: TaskSummary.self)
    }
    public func revise(_ id: String, goal: String, clientMessageID: String) async throws -> CommandResponse {
        try await call("POST", "/v1/tasks/\(id)/revise", NewTaskCommand(goal: goal, client_message_id: clientMessageID, source: nil), as: CommandResponse.self)
    }
    public func stop(reason: String) async throws -> StopAck {
        try await call("POST", "/v1/stop", ["reason": reason], as: StopAck.self)
    }
    public func clearStop() async throws -> StopLatch { try await call("POST", "/v1/stop/clear", as: StopLatch.self) }
    public func policy() async throws -> Grant? { try await call("GET", "/v1/policy", as: Grant?.self) }
    public func putPolicy(_ update: PolicyUpdate) async throws -> Grant { try await call("PUT", "/v1/policy", update, as: Grant.self) }
    public func budget() async throws -> [BudgetRow] { try await call("GET", "/v1/budget", as: [BudgetRow].self) }
    public func putBudget(_ update: BudgetUpdate) async throws -> BudgetUpdateResponse {
        try await call("PUT", "/v1/budget", update, as: BudgetUpdateResponse.self)
    }
}

/// Idempotency key for owner commands: the daemon dedups on client_message_id.
// MARK: remote (Telegram) — used by the Remote settings pane
public struct PairingCode: Codable, Sendable { public let code: String; public let expires_at: String }
public struct RemoteDevice: Codable, Sendable, Identifiable {
    public let device_id: String; public let platform_identity: String; public let label: String?; public let paired_at: String; public let revoked_at: String?
    public var id: String { device_id }
}
public struct RemoteConfig: Codable, Sendable { public let telegram_enabled: Bool }
private struct EnableBody: Encodable { let enabled: Bool }
public struct ProviderConfig: Codable, Sendable {
    public let kind: String
    public let planner_model: String?
    public let fast_model: String?
    public let budget_scope: String
}
private struct ProviderUpdate: Encodable {
    let kind = "anthropic_api"
    let planner_model: String?
}
public struct ProviderDiscovery: Codable, Sendable {
    public struct Role: Codable, Sendable {
        public let model: String
        public let ok: Bool
        public let reason: String?
    }
    public let available: [String]
    public let roles: [String: Role]
}

extension BillyClient {
    private func decode<T: Decodable>(_ resp: HTTPResponse, _ t: T.Type) throws -> T {
        guard (200..<300).contains(resp.status) else {
            throw ClientError.http(resp.status, (try? JSONDecoder().decode(APIErrorBody.self, from: resp.body).error) ?? "")
        }
        return try JSONDecoder().decode(T.self, from: resp.body)
    }
    public func setTelegram(enabled: Bool) async throws -> RemoteConfig {
        try decode(try await raw("PUT", "/v1/remote/telegram", body: try JSONEncoder().encode(EnableBody(enabled: enabled))), RemoteConfig.self)
    }
    /// Activates the credential already stored locally. No secret is sent to the core API.
    /// An omitted model preserves the core's current choice; paid calls still require its budget and grant.
    public func activateAnthropic(plannerModel: String? = nil) async throws -> ProviderConfig {
        let model = plannerModel?.trimmingCharacters(in: .whitespacesAndNewlines)
        let update = ProviderUpdate(planner_model: model?.isEmpty == false ? model : nil)
        return try decode(try await raw("PUT", "/v1/provider", body: try JSONEncoder().encode(update)), ProviderConfig.self)
    }
    public func discoverProviderModels() async throws -> ProviderDiscovery {
        try decode(try await raw("POST", "/v1/provider/discover", body: Data("{}".utf8)), ProviderDiscovery.self)
    }
    public func pairingCode() async throws -> PairingCode { try decode(try await raw("POST", "/v1/remote/telegram/pairing", body: Data("{}".utf8)), PairingCode.self) }
    public func remoteDevices() async throws -> [RemoteDevice] { try decode(try await raw("GET", "/v1/remote/devices"), [RemoteDevice].self) }
    public func revokeDevice(_ telegramUserID: String) async throws -> [RemoteDevice] {
        try decode(try await raw("POST", "/v1/remote/devices/\(telegramUserID)/revoke", body: Data("{}".utf8)), [RemoteDevice].self)
    }
}

public func newClientMessageID(prefix: String = "app") -> String {
    "\(prefix)-\(UUID().uuidString.lowercased())"
}
