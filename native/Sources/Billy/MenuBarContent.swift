import AppKit
import BillyKit
import SwiftUI

/// Menu-bar popover: status, the emergency stop, and the lifecycle actions.
struct MenuBarContent: View {
    @Environment(AppModel.self) private var model
    @Environment(AppStore.self) private var store
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            if store.ownsDesktop { DesktopOwnerBanner() }
            counts

            Button(role: .destructive) { model.emergencyStop() } label: {
                Label("Stop Billy", systemImage: "stop.fill")
                    .font(.headline)
                    .frame(maxWidth: .infinity, minHeight: 30)
            }
            .buttonStyle(.borderedProminent)
            .tint(.red)
            .keyboardShortcut(".", modifiers: [.command, .shift])
            .accessibilityLabel("Stop Billy (emergency stop)")
            .accessibilityHint("Immediately pauses all of Billy's work. Shortcut Command Shift Period.")

            HStack {
                if store.isStopped || store.counts.paused > 0 {
                    Button("Resume") { Task { await store.resumeAll() } }
                        .accessibilityLabel("Resume Billy and owner-paused tasks")
                } else {
                    Button("Pause All") { Task { await store.pauseAll() } }
                        .accessibilityLabel("Pause all running tasks")
                }
                Spacer()
                Button("Open Billy") {
                    openWindow(id: "main")
                    NSApp.activate()
                }
                .keyboardShortcut("o")
                .accessibilityLabel("Open the Billy window")
            }

            Divider()
            Text(model.serviceState.label).font(.caption).foregroundStyle(.secondary)
            HStack {
                Button("Settings…") { openSettings(); NSApp.activate() }
                    .accessibilityLabel("Open Billy settings")
                Spacer()
                Menu("More") {
                    Button("Stop Background Service…") { model.stopBackgroundService() }
                    Button("Quit Billy App (core keeps running)") { NSApp.terminate(nil) }
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .accessibilityLabel("More actions: stop background service or quit the app")
            }
        }
        .padding(14)
        .frame(width: 300)
        .onAppear { model.refreshService() }
    }

    private var header: some View {
        HStack {
            Image(systemName: "b.circle.fill").font(.title2).foregroundStyle(.tint)
                .accessibilityHidden(true)
            VStack(alignment: .leading) {
                Text("Billy").font(.headline)
                Text(connectionText).font(.caption).foregroundStyle(store.isStopped ? .red : .secondary)
            }
            Spacer()
        }
        .accessibilityElement(children: .combine)
    }

    private var connectionText: String {
        switch store.connection {
        case .connecting: return "Connecting…"
        case .connected: return store.isStopped ? "STOPPED — new work is blocked" : "Running"
        case .notRunning(let m): return m
        case .error(let m): return m
        }
    }

    private var counts: some View {
        let c = store.counts
        return HStack(spacing: 14) {
            CountChip(value: c.running, label: "running", color: .green)
            CountChip(value: c.paused, label: "paused", color: .orange)
            CountChip(value: c.needsAttention, label: "blocked", color: .red)
        }
    }
}

struct CountChip: View {
    let value: Int, label: String, color: Color
    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text("\(value) \(label)").font(.callout).monospacedDigit()
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(value) \(label)")
    }
}

/// Visible control indicator while Billy owns interactive input (handoff §12.4).
struct DesktopOwnerBanner: View {
    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(.orange).frame(width: 9, height: 9)
            Text("Billy is controlling the desktop. Move the mouse or press Stop to take over.")
                .font(.caption)
        }
        .padding(6)
        .background(.orange.opacity(0.15), in: RoundedRectangle(cornerRadius: 6))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Billy is controlling the desktop")
    }
}
