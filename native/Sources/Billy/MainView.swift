import AppKit
import BillyKit
import SwiftUI

/// Main window: task list (sidebar), task detail, and the command composer.
struct MainView: View {
    @Environment(AppModel.self) private var model
    @Environment(AppStore.self) private var store

    var body: some View {
        @Bindable var model = model
        NavigationSplitView {
            TaskSidebar()
                .navigationSplitViewColumnWidth(min: 260, ideal: 300)
        } detail: {
            VStack(spacing: 0) {
                Banners()
                if let id = store.selectedTaskID {
                    TaskDetailView(taskID: id)
                } else {
                    EmptyDetail()
                }
                Divider()
                Composer().padding(12)
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button(role: .destructive) { model.emergencyStop() } label: {
                    Label("Stop Billy", systemImage: "stop.fill").labelStyle(.titleAndIcon)
                }
                .buttonStyle(.borderedProminent)
                .tint(.red)
                .help("Stop Billy (emergency) — ⌘⇧.")
                .accessibilityLabel("Stop Billy (emergency stop)")
            }
            ToolbarItem(placement: .status) {
                HStack(spacing: 6) {
                    if store.ownsDesktop {
                        Circle().fill(.orange).frame(width: 9, height: 9)
                            .accessibilityLabel("Billy is controlling the desktop")
                    }
                    ConnectionBadge()
                }
            }
        }
        .sheet(isPresented: $model.showOnboarding) {
            OnboardingView().environment(model).environment(store)
        }
        .onChange(of: store.doctor) { model.evaluateOnboarding() }
        .onAppear { model.evaluateOnboarding() }
    }
}

struct ConnectionBadge: View {
    @Environment(AppStore.self) private var store
    var body: some View {
        let (text, color): (String, Color) = switch store.connection {
        case .connecting: ("Connecting", .gray)
        case .connected: store.isStopped ? ("Stopped", .red) : ("Connected", .green)
        case .notRunning: ("Core not running", .orange)
        case .error: ("Error", .red)
        }
        HStack(spacing: 4) {
            Circle().fill(color).frame(width: 8, height: 8)
            Text(text).font(.caption)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Core status: \(text)")
    }
}

/// Stop latch, connection and error notices.
struct Banners: View {
    @Environment(AppModel.self) private var model
    @Environment(AppStore.self) private var store

    var body: some View {
        VStack(spacing: 0) {
            if store.isStopped {
                Notice(color: .red, icon: "stop.circle.fill",
                       text: "Billy is stopped. No new actions will run. Tasks stay paused until you resume them.") {
                    Button("Clear Stop") { Task { await store.clearStop() } }
                        .accessibilityLabel("Clear the emergency stop; tasks stay paused")
                    Button("Resume All") { Task { await store.resumeAll() } }
                        .accessibilityLabel("Clear the stop and resume paused tasks")
                }
            }
            if case .notRunning(let m) = store.connection {
                Notice(color: .orange, icon: "bolt.slash", text: "\(m). \(model.serviceState.label).") {
                    if model.serviceState == .notRegistered || model.serviceState == .requiresApproval {
                        Button("Start Background Service") { model.startBackgroundService() }
                    }
                }
            }
            if let e = store.lastError, store.isConnected {
                Notice(color: .yellow, icon: "exclamationmark.triangle", text: e) {
                    Button("Dismiss") { store.lastError = nil }.accessibilityLabel("Dismiss error")
                }
            }
        }
    }
}

struct Notice<Actions: View>: View {
    let color: Color, icon: String, text: String
    @ViewBuilder var actions: Actions
    var body: some View {
        HStack {
            Image(systemName: icon).foregroundStyle(color).accessibilityHidden(true)
            Text(text).font(.callout).textSelection(.enabled).lineLimit(3)
            Spacer()
            actions
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(color.opacity(0.12))
    }
}

struct EmptyDetail: View {
    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "list.bullet.rectangle").font(.system(size: 40)).foregroundStyle(.secondary)
                .accessibilityHidden(true)
            Text("Select a task, or tell Billy what to do below.").foregroundStyle(.secondary)
            Text("Closing this window does not stop Billy; it keeps working from the menu bar.")
                .font(.caption).foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: sidebar

struct TaskSidebar: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        @Bindable var store = store
        VStack(spacing: 0) {
            Picker("Filter", selection: $store.filter) {
                ForEach(TaskFilter.allCases) { f in Text(f.title).tag(f) }
            }
            .pickerStyle(.menu)
            .padding(8)
            .accessibilityLabel("Filter tasks by status")

            List(selection: Binding(get: { store.selectedTaskID }, set: { id in Task { await store.select(id) } })) {
                ForEach(store.filteredTasks) { t in
                    TaskRow(task: t).tag(t.task_id)
                }
            }
            .accessibilityLabel("Tasks")
            .overlay {
                if store.filteredTasks.isEmpty {
                    Text(store.tasks.isEmpty ? "No tasks yet" : "No tasks match this filter")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Tasks")
    }
}

struct TaskRow: View {
    let task: TaskSummary
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(task.goal).lineLimit(2)
            HStack {
                StatusBadge(status: task.status)
                Spacer()
                Text(RelativeTime.text(task.updated_at)).font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(task.goal), \(StatusBadge.spoken(task.status))")
    }
}

struct StatusBadge: View {
    let status: String
    var body: some View {
        Text(status.replacingOccurrences(of: "_", with: " ").capitalized)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Self.color(status).opacity(0.18), in: Capsule())
            .foregroundStyle(Self.color(status))
            .accessibilityLabel(Self.spoken(status))
    }
    static func color(_ s: String) -> Color {
        switch TaskGroup.of(s) {
        case .active: return .blue
        case .waiting: return .orange
        case .paused: return .purple
        case .blocked: return .red
        case .completed: return .green
        case .ended: return .gray
        }
    }
    static func spoken(_ s: String) -> String { "status " + s.replacingOccurrences(of: "_", with: " ").lowercased() }
}

enum RelativeTime {
    static func text(_ iso: String) -> String {
        guard let d = ISODate.parse(iso) else { return iso }
        return d.formatted(.relative(presentation: .named))
    }
    static func absolute(_ iso: String) -> String {
        guard let d = ISODate.parse(iso) else { return iso }
        return d.formatted(date: .abbreviated, time: .standard)
    }
}

// MARK: composer

/// Text command field with Send, plus push-to-talk.
struct Composer: View {
    @Environment(AppStore.self) private var store
    @Environment(VoiceController.self) private var voice
    @State private var text = ""
    @State private var sending = false
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if voice.state != .idle { VoiceStrip() }
            HStack(spacing: 8) {
                TextField("Tell Billy what to do…", text: $text, axis: .vertical)
                    .lineLimit(1...4)
                    .textFieldStyle(.roundedBorder)
                    .focused($focused)
                    .onSubmit(send)
                    .accessibilityLabel("New task")
                    .disabled(voice.isRecording)
                Button(action: send) { Label("Send", systemImage: "paperplane.fill") }
                    .keyboardShortcut(.return, modifiers: [.command])
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending)
                    .accessibilityLabel("Send task to Billy")
                MicButton()
            }
        }
        .onAppear { focused = true }
    }

    private func send() {
        let goal = text
        guard !goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        sending = true
        Task {
            if let id = await store.submitTask(goal: goal, source: .localApp) {
                text = ""
                await store.select(id)
            }
            sending = false
        }
    }
}
