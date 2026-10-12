import AppKit
import BillyKit
import SwiftUI

/// App-wide objects shared by every scene.
@MainActor @Observable
final class AppModel {
    let paths = BillyPaths.resolve()
    let store: AppStore
    let voice: VoiceController
    let service = ServiceController()
    var serviceState: ServiceController.State = .notInstalled
    var onboardingDismissed = UserDefaults.standard.bool(forKey: "onboardingDismissed") {
        didSet { UserDefaults.standard.set(onboardingDismissed, forKey: "onboardingDismissed") }
    }
    var showOnboarding = false

    static var appVersion: String {
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
        let b = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "0"
        return "\(v) (\(b))"
    }

    init() {
        let store = AppStore(api: BillyClient(paths: paths))
        self.store = store
        self.voice = VoiceController(recognizer: SystemSpeechRecognizer()) { text in
            await store.submitTask(goal: text, source: .voice, clientMessageID: newClientMessageID(prefix: "voice"))
        }
        refreshService()
        store.startPolling()
        if let dir = ProcessInfo.processInfo.environment["BILLY_SNAPSHOT_DIR"] { Snapshotter.schedule(into: dir, store: store) }
    }

    func refreshService() { serviceState = service.state }

    /// Shows onboarding on first launch while the standing grant is missing.
    func evaluateOnboarding() {
        if store.doctor?.needsOnboarding == true, !onboardingDismissed { showOnboarding = true }
    }

    func emergencyStop() { Task { await store.stop() } }

    /// Confirms, then unregisters the LaunchAgent. Owner data is untouched.
    func stopBackgroundService() {
        let alert = NSAlert()
        alert.messageText = "Stop Billy's background service?"
        alert.informativeText = "Billy will stop working on tasks until you start the service again. Your tasks, history and settings are kept. This is different from Stop Billy (emergency), which pauses work but keeps the service running."
        alert.addButton(withTitle: "Stop Service")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        Task {
            do { try await service.unregister() } catch { store.lastError = "\(error)" }
            refreshService()
        }
    }

    func startBackgroundService() {
        do { try service.register() } catch { store.lastError = "\(error)" }
        refreshService()
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    /// Closing the window never quits: Billy keeps working from the menu bar.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

@main
struct BillyApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel()

    var body: some Scene {
        Window("Billy", id: "main") {
            MainView()
                .environment(model)
                .environment(model.store)
                .environment(model.voice)
                .frame(minWidth: 860, minHeight: 540)
        }
        .defaultSize(width: 1060, height: 680)
        .commands { BillyCommands(model: model) }

        Settings {
            SettingsView()
                .environment(model)
                .environment(model.store)
        }

        MenuBarExtra {
            MenuBarContent()
                .environment(model)
                .environment(model.store)
        } label: {
            MenuBarLabel(store: model.store)
        }
        .menuBarExtraStyle(.window)
    }
}

/// Menu-bar icon: changes when stopped or when Billy owns the desktop.
struct MenuBarLabel: View {
    let store: AppStore
    var body: some View {
        if store.ownsDesktop {
            Label("Billy is using the desktop", systemImage: "cursorarrow.motionlines.click")
        } else if store.isStopped {
            Label("Billy stopped", systemImage: "stop.circle")
        } else {
            Label("Billy", systemImage: "b.circle")
        }
    }
}

/// App menu-bar commands: these keep the four "off" actions clearly distinct.
struct BillyCommands: Commands {
    let model: AppModel
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        CommandGroup(replacing: .appTermination) {
            Button("Quit Billy App (core service keeps running)") { NSApp.terminate(nil) }
                .keyboardShortcut("q")
        }
        CommandGroup(replacing: .newItem) {
            Button("Open Billy Window") { openWindow(id: "main") }
                .keyboardShortcut("0")
        }
        CommandMenu("Control") {
            Button("Stop Billy (emergency)") { model.emergencyStop() }
                .keyboardShortcut(".", modifiers: [.command, .shift])
            Divider()
            Button("Pause All Tasks") { Task { await model.store.pauseAll() } }
            Button("Resume Billy") { Task { await model.store.resumeAll() } }
            Divider()
            Button(model.voice.isRecording ? "Send Voice Command" : "Start Voice Command") {
                Task { await model.voice.toggle() }
            }
            .keyboardShortcut("v", modifiers: [.command, .shift])
            Button("Cancel Voice Command") { model.voice.cancel() }
                .disabled(!model.voice.isRecording)
            Divider()
            Button("Stop Background Service…") { model.stopBackgroundService() }
        }
    }
}
