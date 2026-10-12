import Foundation

/// Editable subset of the standing grant shown in Settings → Permissions and
/// onboarding. Fields the UI does not edit are carried over from the current
/// grant (or conservative defaults) so saving never silently widens them.
public struct GrantDraft: Sendable, Equatable {
    public var fileRoots: [String]
    public var apps: [String]                 // bundle identifiers
    public var effects: Set<EffectClass>
    public var toolClasses: [String]
    public var expiresAt: Date
    public var allowFilePanelInput: Bool = false
    public static let filePanelServiceBundle = "com.apple.appkit.xpc.openAndSavePanelService"

    public init(fileRoots: [String], apps: [String], effects: Set<EffectClass>, toolClasses: [String], expiresAt: Date) {
        self.fileRoots = fileRoots; self.apps = apps; self.effects = effects
        self.toolClasses = toolClasses; self.expiresAt = expiresAt
    }

    public static let workspaceFolderName = "Billy Workspace"

    /// Onboarding proposal: one workspace folder, three everyday apps, 90 days.
    public static func proposal(home: String = NSHomeDirectory(), now: Date = Date()) -> GrantDraft {
        GrantDraft(
            fileRoots: [(home as NSString).appendingPathComponent(workspaceFolderName)],
            apps: ["com.apple.calculator", "com.apple.TextEdit", "com.apple.finder"],
            effects: [.READ_ONLY, .IDEMPOTENT_WRITE, .NON_IDEMPOTENT_EFFECT],
            toolClasses: ["file", "desktop", "app", "api.message"],
            expiresAt: now.addingTimeInterval(90 * 24 * 3600))
    }

    public init(grant: Grant) {
        self.init(fileRoots: grant.scope.file_roots, apps: grant.scope.apps, effects: Set(grant.scope.allowed_effects),
                  toolClasses: grant.scope.tool_classes, expiresAt: ISODate.parse(grant.expires_at) ?? Date())
        allowFilePanelInput = grant.scope.protected_actions.contains("file_panel_input")
    }

    /// Defaults for the fields this UI does not expose.
    public static let baseScope = GrantScope(
        apps: [], file_roots: [], browser_profiles: [], domains: [], account_ids: [], tool_classes: [],
        allowed_effects: [], secret_references: [], network_destinations: [], foreground: "when_idle",
        spend_scopes: ["provider-total"], protected_actions: [], delegation: Delegation(allowed: true, max_depth: 1),
        model_egress: ["anthropic"], recipients: [])

    public func scope(base: GrantScope? = nil) -> GrantScope {
        var s = base ?? Self.baseScope
        s.file_roots = Self.unique(fileRoots.map { ($0 as NSString).standardizingPath })
        s.apps = Self.unique(apps.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty })
        if allowFilePanelInput {
            s.apps = Self.unique(s.apps + [Self.filePanelServiceBundle])
            s.protected_actions = Self.unique(s.protected_actions + ["file_panel_input"])
        } else {
            s.protected_actions.removeAll { $0 == "file_panel_input" }
        }
        // Stable order matching the schema enum.
        s.allowed_effects = EffectClass.allCases.filter { effects.contains($0) }
        s.tool_classes = Self.unique(toolClasses.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty })
        return s
    }

    public func update(base: GrantScope? = nil) -> PolicyUpdate {
        PolicyUpdate(scope: scope(base: base), expires_at: ISODate.format(expiresAt))
    }

    /// Validation mirroring GRANT_SCOPE_SCHEMA plus the future-expiry rule in PUT /v1/policy.
    public func problems(now: Date = Date()) -> [String] {
        var p: [String] = []
        if expiresAt <= now { p.append("Expiry must be in the future.") }
        if fileRoots.contains(where: { !$0.hasPrefix("/") }) { p.append("File roots must be absolute paths.") }
        if fileRoots.count > 32 { p.append("At most 32 file roots.") }
        if apps.count > 64 { p.append("At most 64 apps.") }
        if effects.isEmpty { p.append("Choose at least one effect class.") }
        return p
    }

    private static func unique(_ xs: [String]) -> [String] {
        var seen = Set<String>()
        return xs.filter { seen.insert($0).inserted }
    }
}
