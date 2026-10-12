import BillyKit
import SwiftUI

/// First-launch setup, shown while the doctor reports no standing grant.
/// Steps: provider key → budget → standing grant → desktop-control permissions.
struct OnboardingView: View {
    @Environment(AppModel.self) private var model
    @Environment(AppStore.self) private var store
    @State private var step = 0
    private let titles = ["AI provider", "Budget", "Permissions", "Desktop control"]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Set up Billy").font(.title2.bold())
                Spacer()
                Text("Step \(step + 1) of \(titles.count): \(titles[step])").foregroundStyle(.secondary)
            }
            .padding()
            Divider()
            Group {
                switch step {
                case 0: ProviderPane()
                case 1: Form { BudgetEditor() }.formStyle(.grouped)
                case 2: Form { PolicyEditor(onSaved: { step = 3 }) }.formStyle(.grouped)
                default: CuaStep()
                }
            }
            .frame(maxHeight: .infinity)
            Divider()
            HStack {
                Button("Later") { model.onboardingDismissed = true; model.showOnboarding = false }
                    .accessibilityLabel("Skip setup for now")
                Spacer()
                Button("Back") { step -= 1 }.disabled(step == 0)
                if step < titles.count - 1 {
                    Button("Next") { step += 1 }.keyboardShortcut(.defaultAction)
                } else {
                    Button("Done") { model.onboardingDismissed = true; model.showOnboarding = false }
                        .keyboardShortcut(.defaultAction)
                }
            }
            .padding()
        }
        .frame(width: 640, height: 600)
    }
}

/// CuaDriver grants are made by the driver itself, from Terminal.
struct CuaStep: View {
    @Environment(AppModel.self) private var model
    @Environment(AppStore.self) private var store

    var body: some View {
        Form {
            Section("Desktop control permissions") {
                Text("Billy controls apps through CuaDriver. Grant it Accessibility and Screen Recording by running this in Terminal, then approve the macOS prompts:")
                    .font(.callout)
                CommandBox(command: "cua-driver permissions grant")
                ForEach(store.doctor?.checks.filter { $0.id.hasPrefix("cua.") } ?? []) { CheckRow(check: $0) }
                Button("Check Again") { Task { await store.refreshDoctor() } }
                    .accessibilityLabel("Re-run the health check")
            }
            Section("Background service") {
                LabeledContent("State", value: model.serviceState.label)
                if model.serviceState == .notRegistered {
                    Button("Start Background Service") { model.startBackgroundService() }
                }
            }
            if let d = store.doctor {
                Section("Remaining issues") {
                    ForEach(d.checks.filter { $0.status == .fail }) { CheckRow(check: $0) }
                    if d.ok { Label("All checks pass", systemImage: "checkmark.seal.fill").foregroundStyle(.green) }
                }
            }
        }
        .formStyle(.grouped)
    }
}
