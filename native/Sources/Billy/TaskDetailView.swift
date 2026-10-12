import BillyKit
import SwiftUI

/// Goal, status, wait reason, owner controls, attempts, event timeline and result.
struct TaskDetailView: View {
    let taskID: String
    @Environment(AppStore.self) private var store
    @State private var revising = false
    @State private var revisedGoal = ""

    var body: some View {
        if let t = store.detail, t.task_id == taskID {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    header(t)
                    controls(t)
                    if let r = t.result, r != .null { section("Result") { JSONText(value: r) } }
                    section("Attempts (\(t.attempts.count))") { AttemptsTable(attempts: t.attempts) }
                    section("Timeline") { Timeline(events: t.events) }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .sheet(isPresented: $revising) { reviseSheet(t) }
        } else {
            ProgressView("Loading task…").frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func header(_ t: TaskDetail) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(t.goal).font(.title3.weight(.semibold)).textSelection(.enabled)
            HStack(spacing: 10) {
                StatusBadge(status: t.status)
                Text("Revision \(t.revision)").font(.caption).foregroundStyle(.secondary)
                Text("Created \(RelativeTime.absolute(t.created_at))").font(.caption).foregroundStyle(.secondary)
            }
            if let w = t.wait_reason, !w.isEmpty {
                Label(w, systemImage: "hourglass").font(.callout).foregroundStyle(.orange)
                    .accessibilityLabel("Waiting because: \(w)")
            }
        }
    }

    private func controls(_ t: TaskDetail) -> some View {
        let group = TaskGroup.of(t.status)
        let terminal = group == .completed || group == .ended
        return HStack {
            if t.status == "PAUSED_BY_OWNER" {
                Button("Resume") { Task { await store.control(t.task_id, .resume) } }
                    .accessibilityLabel("Resume this task")
            } else {
                Button("Pause") { Task { await store.control(t.task_id, .pause) } }
                    .disabled(terminal || t.status == "CANCEL_REQUESTED")
                    .accessibilityLabel("Pause this task")
            }
            Button("Change Goal…") { revisedGoal = t.goal; revising = true }
                .disabled(terminal)
                .accessibilityLabel("Revise this task's goal")
            Button("Cancel Task", role: .destructive) { Task { await store.control(t.task_id, .cancel) } }
                .disabled(terminal || t.status == "CANCEL_REQUESTED")
                .accessibilityLabel("Cancel this task")
        }
    }

    private func reviseSheet(_ t: TaskDetail) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Change goal").font(.headline)
            TextField("New goal", text: $revisedGoal, axis: .vertical).lineLimit(3...8)
                .accessibilityLabel("Revised goal")
            HStack {
                Spacer()
                Button("Cancel") { revising = false }.keyboardShortcut(.cancelAction)
                Button("Revise") {
                    let goal = revisedGoal
                    revising = false
                    Task { await store.revise(t.task_id, goal: goal) }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(revisedGoal.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(20).frame(width: 460)
    }

    private func section<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.headline).accessibilityAddTraits(.isHeader)
            content()
        }
    }
}

struct AttemptsTable: View {
    let attempts: [Attempt]
    var body: some View {
        if attempts.isEmpty {
            Text("No actions attempted yet.").foregroundStyle(.secondary)
        } else {
            Table(attempts) {
                TableColumn("#") { a in Text("\(a.attempt_no)").monospacedDigit() }.width(30)
                TableColumn("Step") { a in Text(a.step_key ?? "—") }
                TableColumn("Tool", value: \.tool_id)
                TableColumn("Target") { a in Text(a.target ?? "—").lineLimit(1).help(a.target ?? "") }
                TableColumn("Status") { a in Text(a.status) }
                TableColumn("Error") { a in Text(a.error ?? a.uncertainty ?? "").lineLimit(2).help(a.error ?? "") }
                TableColumn("Created") { a in Text(RelativeTime.text(a.created_at)) }
            }
            .frame(minHeight: CGFloat(min(attempts.count, 8)) * 26 + 32)
            .accessibilityLabel("Attempts")
        }
    }
}

struct Timeline: View {
    let events: [TaskEvent]
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(events.reversed()) { e in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(RelativeTime.absolute(e.at)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        .frame(width: 170, alignment: .leading)
                    Text(e.kind).font(.caption.weight(.semibold)).frame(width: 90, alignment: .leading)
                    Text(Self.describe(e)).font(.caption).textSelection(.enabled).lineLimit(3)
                }
                .accessibilityElement(children: .combine)
            }
            if events.isEmpty { Text("No events.").foregroundStyle(.secondary) }
        }
    }

    /// Transitions read as "FROM → TO (reason)"; anything else is compact JSON.
    static func describe(_ e: TaskEvent) -> String {
        guard let p = e.payload else { return "" }
        if e.kind == "transition", let from = p["from"]?.stringValue, let to = p["to"]?.stringValue {
            let reason = p["reason"]?.stringValue.map { " (\($0))" } ?? ""
            return "\(from) → \(to)\(reason)"
        }
        return p.compactText
    }
}

struct JSONText: View {
    let value: JSONValue
    var body: some View {
        Text(value.compactText)
            .font(.system(.callout, design: .monospaced))
            .textSelection(.enabled)
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 6))
    }
}
