import Foundation
import ServiceManagement

/// Per-user core service (billyd) managed through SMAppService (handoff §12.5).
/// The LaunchAgent plist ships at Billy.app/Contents/Library/LaunchAgents and
/// runs Contents/Resources/billyd/billyd. Unregistering stops the background
/// service; it never deletes the owner's data.
@MainActor
public final class ServiceController {
    public static let plistName = "com.billy.core.plist"

    public enum State: Equatable, Sendable {
        case notInstalled          // runtime not embedded in this build (dev)
        case notRegistered
        case enabled
        case requiresApproval      // user must allow it in System Settings → Login Items
        case notFound
        case unknown(String)

        public var label: String {
            switch self {
            case .notInstalled: return "Service not installed in this build"
            case .notRegistered: return "Background service off"
            case .enabled: return "Background service on"
            case .requiresApproval: return "Waiting for approval in System Settings → General → Login Items"
            case .notFound: return "Service definition not found in app bundle"
            case .unknown(let s): return "Unknown (\(s))"
            }
        }
    }

    private let bundle: Bundle
    public init(bundle: Bundle = .main) { self.bundle = bundle }

    /// The launcher and Node runtime are copied in by the packaging script.
    public var runtimeEmbedded: Bool {
        let res = bundle.bundleURL.appendingPathComponent("Contents/Resources")
        let fm = FileManager.default
        return fm.isExecutableFile(atPath: res.appendingPathComponent("billyd/billyd").path)
            && fm.isExecutableFile(atPath: res.appendingPathComponent("node/bin/node").path)
            && fm.fileExists(atPath: res.appendingPathComponent("core/src/daemon/main.ts").path)
    }

    private var service: SMAppService { SMAppService.agent(plistName: Self.plistName) }

    public var state: State {
        guard runtimeEmbedded else { return .notInstalled }
        switch service.status {
        case .notRegistered: return .notRegistered
        case .enabled: return .enabled
        case .requiresApproval: return .requiresApproval
        case .notFound: return .notFound
        @unknown default: return .unknown("\(service.status.rawValue)")
        }
    }

    /// Starts the background service (and keeps it running across logins).
    public func register() throws {
        guard runtimeEmbedded else { throw ServiceError.notInstalled }
        try FileManager.default.createDirectory(at: Self.logDir, withIntermediateDirectories: true)
        try service.register()
    }

    /// "Stop background service": launchd stops billyd; tasks resume next start.
    public func unregister() async throws {
        // Keep the non-Sendable service on the main actor. Older macOS SDKs
        // import the async overload as nonisolated, so bridge its completion API.
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            service.unregister { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume() }
            }
        }
    }

    public func openLoginItemsSettings() { SMAppService.openSystemSettingsLoginItems() }

    public static var logDir: URL {
        URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Logs/Billy")
    }

    public enum ServiceError: Error, CustomStringConvertible {
        case notInstalled
        public var description: String { "This build does not embed the core runtime (run scripts/build-app.sh --core … --node …)." }
    }
}
