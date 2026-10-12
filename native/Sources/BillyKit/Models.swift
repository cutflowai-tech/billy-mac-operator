import Foundation

// Codable mirrors of the core daemon's owner API (core/src/daemon/routes.ts).
// Property names match the wire format (snake_case) so decoding needs no key
// strategy and the shapes are easy to diff against the TypeScript source.

public struct StopLatch: Codable, Sendable, Equatable {
    public var generation: Int
    public var stopped: Bool
    public var reason: String?
}

/// GET /v1/status
public struct StatusResponse: Codable, Sendable, Equatable {
    public var pid: Int
    public var started_at: String
    public var stop: StopLatch
    public var tasks: [String: Int]
    public var provider: String
    public var timezone: String
    public var schema: Int
    public var device_id: String
    /// Not yet provided by the core (see report): when present and truthy, Billy
    /// currently owns interactive desktop input and the UI shows an indicator.
    public var desktop_owner: JSONValue?

    public var ownsDesktop: Bool { desktop_owner?.isTruthy ?? false }
}

public enum CheckStatus: String, Codable, Sendable { case ok, warn, fail, unknown }

public struct DoctorCheck: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var capability: String
    public var status: CheckStatus
    public var detail: String
    public var fix: String?
    public var blocks: [String]?
}

/// GET /v1/doctor
public struct DoctorReport: Codable, Sendable, Equatable {
    public var ok: Bool
    public var checks: [DoctorCheck]

    public func check(_ id: String) -> DoctorCheck? { checks.first { $0.id == id } }
    /// Onboarding is needed until a standing grant exists.
    public var needsOnboarding: Bool { check("policy.default_grant")?.status == .fail }
}

/// Element of GET /v1/tasks (and the `task` field of command responses).
public struct TaskSummary: Codable, Sendable, Equatable, Identifiable {
    public var task_id: String
    public var status: String
    public var goal: String
    public var revision: Int
    public var project_scope: String?
    public var created_at: String
    public var updated_at: String
    public var wait_reason: String?
    public var parent_task_id: String?
    public var result: JSONValue?
    public var id: String { task_id }
}

public struct Attempt: Codable, Sendable, Equatable, Identifiable {
    public var attempt_id: String
    public var attempt_no: Int
    public var tool_id: String
    public var status: String
    public var error: String?
    public var uncertainty: String?
    public var created_at: String
    public var dispatched_at: String?
    public var step_key: String?
    public var target: String?
    public var id: String { attempt_id }
}

public struct TaskEvent: Codable, Sendable, Equatable, Identifiable {
    public var seq: Int
    public var kind: String
    public var at: String
    public var payload: JSONValue?
    public var id: Int { seq }
}

/// GET /v1/tasks/:id
public struct TaskDetail: Codable, Sendable, Equatable, Identifiable {
    public var task_id: String
    public var status: String
    public var goal: String
    public var revision: Int
    public var project_scope: String?
    public var created_at: String
    public var updated_at: String
    public var wait_reason: String?
    public var parent_task_id: String?
    public var result: JSONValue?
    public var success_criteria: JSONValue?
    public var attempts: [Attempt]
    public var events: [TaskEvent]
    public var id: String { task_id }
}

/// Element of GET /v1/events?after=
public struct EventRow: Codable, Sendable, Equatable {
    public var seq: Int
    public var domain: String
    public var entity_id: String
    public var kind: String
    public var at: String
    public init(seq: Int, domain: String, entity_id: String, kind: String, at: String) {
        self.seq = seq; self.domain = domain; self.entity_id = entity_id; self.kind = kind; self.at = at
    }
}

/// POST /v1/tasks and POST /v1/tasks/:id/revise
public struct CommandResponse: Codable, Sendable, Equatable {
    public var duplicate: Bool?
    public var disposition: String?
    public var task_id: String?
    public var revision: Int?
    public var task: TaskSummary?
}

/// POST /v1/stop
public struct StopAck: Codable, Sendable, Equatable {
    public var generation: Int
    public var acknowledged_at: String
    public var ack_ms: Double
    public var tasks_paused: [String]
    public var in_flight: [InFlight]
    public struct InFlight: Codable, Sendable, Equatable {
        public var attempt_id: String
        public var task_id: String
        public var tool_id: String
        public var status: String
    }
}

public enum EffectClass: String, Codable, Sendable, CaseIterable {
    case READ_ONLY, IDEMPOTENT_WRITE, NON_IDEMPOTENT_EFFECT
    public var label: String {
        switch self {
        case .READ_ONLY: return "Read only"
        case .IDEMPOTENT_WRITE: return "Repeatable writes (files, settings)"
        case .NON_IDEMPOTENT_EFFECT: return "One-shot effects (messages, purchases)"
        }
    }
}

public struct Delegation: Codable, Sendable, Equatable {
    public var allowed: Bool
    public var max_depth: Int
}

/// Mirrors GrantScope / GRANT_SCOPE_SCHEMA in core/src/policy/policy.ts. All keys are required.
public struct GrantScope: Codable, Sendable, Equatable {
    public var apps: [String]
    public var file_roots: [String]
    public var browser_profiles: [String]
    public var domains: [String]
    public var account_ids: [String]
    public var tool_classes: [String]
    public var allowed_effects: [EffectClass]
    public var secret_references: [String]
    public var network_destinations: [String]
    public var foreground: String
    public var spend_scopes: [String]
    public var protected_actions: [String]
    public var delegation: Delegation
    public var model_egress: [String]
    /// Owner-approved message recipients ("endpoint:account:to"); "*" means any. nil/absent means none.
    public var recipients: [String]? = nil
}

/// GET /v1/policy (null when no standing grant exists) and PUT /v1/policy response.
public struct Grant: Codable, Sendable, Equatable {
    public var grant_id: String
    public var revision: Int
    public var owner_id: String
    public var scope: GrantScope
    public var scope_digest: String
    public var expires_at: String
    public var revoked_at: String?
    public var source: String
}

public struct PolicyUpdate: Codable, Sendable, Equatable {
    public var scope: GrantScope
    public var expires_at: String
}

/// Element of GET /v1/budget
public struct BudgetRow: Codable, Sendable, Equatable, Identifiable {
    public var scope: String
    public var ceiling_micros: Int
    public var period: String
    public var updated_at: String?
    public var remaining_micros: Int?
    public var id: String { scope }
}

public struct BudgetUpdate: Codable, Sendable, Equatable {
    public var scope: String
    public var ceiling_usd: Double
    public var period: String
    public init(scope: String, ceiling_usd: Double, period: String) {
        self.scope = scope; self.ceiling_usd = ceiling_usd; self.period = period
    }
}

public struct BudgetUpdateResponse: Codable, Sendable, Equatable {
    public var scope: String
    public var remaining_micros: Int?
}

public enum TaskSource: String, Codable, Sendable { case localApp = "local-app", voice }

public struct NewTaskCommand: Codable, Sendable, Equatable {
    public var goal: String
    public var client_message_id: String
    public var source: TaskSource?
}

/// Error body returned by the daemon for non-2xx responses.
public struct APIErrorBody: Codable, Sendable { public var error: String }

/// ISO-8601 with fractional seconds, as emitted by the core (`toISOString()`).
public enum ISODate {
    public static func parse(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }
    public static func format(_ d: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: d)
    }
}
