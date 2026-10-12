import AppKit
import BillyKit
import SwiftUI
import UniformTypeIdentifiers

struct SettingsView: View {
    /// Remembered tab; `-settingsTab diagnostics` on the command line opens a tab directly.
    @AppStorage("settingsTab") private var tab = "provider"

    var body: some View {
        TabView(selection: $tab) {
            ProviderPane().tabItem { Label("Provider", systemImage: "brain") }.tag("provider")
            BudgetPane().tabItem { Label("Budget", systemImage: "dollarsign.circle") }.tag("budget")
            PolicyPane().tabItem { Label("Permissions", systemImage: "lock.shield") }.tag("permissions")
            RemotePane().tabItem { Label("Remote", systemImage: "iphone") }.tag("remote")
            DiagnosticsPane().tabItem { Label("Diagnostics", systemImage: "stethoscope") }.tag("diagnostics")
            AboutPane().tabItem { Label("About", systemImage: "info.circle") }.tag("about")
        }
        .frame(width: 640, height: 520)
    }
}

/// One doctor check with status icon, detail and the exact fix.
struct CheckRow: View {
    let check: DoctorCheck
    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: Self.icon(check.status)).foregroundStyle(Self.color(check.status))
                .accessibilityLabel(check.status.rawValue)
            VStack(alignment: .leading, spacing: 2) {
                Text(check.capability).font(.callout.weight(.semibold))
                Text(check.detail).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                if let fix = check.fix, check.status != .ok {
                    Text("Fix: \(fix)").font(.caption.monospaced()).textSelection(.enabled)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
    static func icon(_ s: CheckStatus) -> String {
        switch s {
        case .ok: return "checkmark.circle.fill"
        case .warn: return "exclamationmark.triangle.fill"
        case .fail: return "xmark.octagon.fill"
        case .unknown: return "questionmark.circle"
        }
    }
    static func color(_ s: CheckStatus) -> Color {
        switch s { case .ok: return .green; case .warn: return .orange; case .fail: return .red; case .unknown: return .gray }
    }
}

struct CommandBox: View {
    let command: String
    var body: some View {
        HStack {
            Text(command).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
            Spacer()
            Button("Copy") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(command, forType: .string)
            }
            .accessibilityLabel("Copy command to clipboard")
        }
        .padding(8)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 6))
    }
}

// MARK: Provider

struct ProviderPane: View {
    @Environment(AppStore.self) private var store
    @State private var key = ""
    @State private var plannerModel = ""
    @State private var configuring = false
    @State private var message: String?
    private var client: BillyClient? { store.api as? BillyClient }

    var body: some View {
        Form {
            Section("AI provider") {
                if let c = store.doctor?.check("provider.credential") { CheckRow(check: c) }
                else { Text("Provider status unavailable (core not connected).").foregroundStyle(.secondary) }
                if let c = store.doctor?.check("provider.models") { CheckRow(check: c) }
            }
            Section("Store your Anthropic API key in the Keychain") {
                Text("Billy reads the key from the macOS Keychain only. Never paste a key into a task or chat. In Terminal, run this and paste the key when prompted:")
                    .font(.callout)
                CommandBox(command: ProviderKeychain.terminalCommand)
                Text("Or enter it here; it goes straight to the Keychain and is never shown again.").font(.callout)
                HStack {
                    SecureField("sk-ant-…", text: $key)
                        .accessibilityLabel("Anthropic API key (stored in Keychain)")
                    Button("Save to Keychain") {
                        do { try ProviderKeychain.store(key); key = ""; activate() }
                        catch { message = "\(error)" }
                    }
                    .disabled(key.isEmpty || configuring || !store.isConnected)
                }
                if let message { Text(message).font(.caption) }
            }
            Section("Activate the provider") {
                TextField("Planner model (optional; keep configured model)", text: $plannerModel)
                    .accessibilityLabel("Anthropic planner model identifier")
                Text("After storing a key in Terminal, activate it here. Task calls still require a spending ceiling and provider permission.")
                    .font(.caption).foregroundStyle(.secondary)
                Button("Activate Anthropic and Check Models") { activate() }
                    .disabled(configuring || !store.isConnected)
            }
        }
        .formStyle(.grouped)
        .task { await store.refreshDoctor() }
    }

    private func activate() {
        guard let client else { message = "Billy core is not reachable."; return }
        configuring = true
        Task { @MainActor in
            defer { configuring = false }
            do {
                let config = try await client.activateAnthropic(plannerModel: plannerModel)
                let discovery = try await client.discoverProviderModels()
                if let planner = discovery.roles["planner"], planner.ok {
                    message = "Anthropic activated: \(planner.model)."
                } else {
                    let reason = discovery.roles["planner"]?.reason ?? "no validated planner model"
                    message = "Provider activated; \(reason). Available models: \(discovery.available.joined(separator: ", ")). Enter an available model and activate again."
                }
                if let model = config.planner_model { plannerModel = model }
            } catch { message = "Key remains stored; provider setup failed: \(error)" }
            await store.refreshStatus()
            await store.refreshDoctor()
        }
    }
}

// MARK: Budget

struct BudgetPane: View {
    var body: some View { Form { BudgetEditor() }.formStyle(.grouped) }
}

struct BudgetEditor: View {
    @Environment(AppStore.self) private var store
    @State private var amount = 20.0
    @State private var period = "total"
    @State private var saved: String?
    let scope = "provider-total"

    var body: some View {
        Section("Spending ceiling for AI provider calls") {
            if let c = store.doctor?.check("budget.provider") { CheckRow(check: c) }
            ForEach(store.budgets) { b in
                LabeledContent(b.scope) {
                    Text(String(format: "%.2f USD (%@), remaining %.2f", Double(b.ceiling_micros) / 1e6, b.period,
                                Double(b.remaining_micros ?? 0) / 1e6)).monospacedDigit()
                }
            }
            TextField("Ceiling (USD)", value: $amount, format: .number.precision(.fractionLength(2)))
                .accessibilityLabel("Budget ceiling in US dollars")
            Picker("Period", selection: $period) {
                Text("Total").tag("total")
                Text("Daily").tag("daily")
            }
            .accessibilityLabel("Budget period")
            HStack {
                Button("Save Budget") {
                    Task {
                        saved = await store.saveBudget(scope: scope, ceilingUSD: amount, period: period) ? "Budget saved." : store.lastError
                    }
                }
                .disabled(amount < 0 || !store.isConnected)
                if let saved { Text(saved).font(.caption) }
            }
        }
        .onAppear {
            if let b = store.budgets.first(where: { $0.scope == scope }) {
                amount = Double(b.ceiling_micros) / 1e6; period = b.period
            }
        }
    }
}

// MARK: Permissions

struct PolicyPane: View {
    var body: some View { Form { PolicyEditor() }.formStyle(.grouped) }
}

/// Edits the standing grant: file roots, apps, effect classes, tool classes, expiry.
struct PolicyEditor: View {
    @Environment(AppStore.self) private var store
    @State private var draft = GrantDraft.proposal()
    @State private var loaded = false
    @State private var newApp = ""
    @State private var result: String?
    var onSaved: (() -> Void)? = nil

    var body: some View {
        Section("Standing authorization") {
            if let c = store.doctor?.check("policy.default_grant") { CheckRow(check: c) }
            Text("Billy may act without asking inside these limits. Anything outside them needs your approval.")
                .font(.caption).foregroundStyle(.secondary)
        }
        Section("Folders") {
            ForEach(draft.fileRoots, id: \.self) { root in
                HStack {
                    Image(systemName: "folder").accessibilityHidden(true)
                    Text(root).textSelection(.enabled)
                    Spacer()
                    Button("Remove") { draft.fileRoots.removeAll { $0 == root } }
                        .accessibilityLabel("Remove folder \(root)")
                }
            }
            Button("Add Folder…") { if let p = pick(directory: true) { draft.fileRoots.append(p) } }
                .accessibilityLabel("Add a folder Billy may use")
        }
        Section("Apps (bundle identifiers)") {
            ForEach(draft.apps, id: \.self) { app in
                HStack {
                    Text(app)
                    Spacer()
                    Button("Remove") { draft.apps.removeAll { $0 == app } }.accessibilityLabel("Remove app \(app)")
                }
            }
            HStack {
                TextField("com.example.app", text: $newApp).accessibilityLabel("App bundle identifier to add")
                Button("Add") { draft.apps.append(newApp); newApp = "" }.disabled(newApp.isEmpty)
                Button("Choose App…") {
                    if let p = pick(directory: false), let id = Bundle(path: p)?.bundleIdentifier { draft.apps.append(id) }
                }
                .accessibilityLabel("Choose an application to allow")
            }
        }
        Section("Allowed effects") {
            ForEach(EffectClass.allCases, id: \.self) { e in
                Toggle(e.label, isOn: Binding(get: { draft.effects.contains(e) },
                                              set: { on in if on { draft.effects.insert(e) } else { draft.effects.remove(e) } }))
            }
            TextField("Tool classes (comma separated)", text: Binding(
                get: { draft.toolClasses.joined(separator: ", ") },
                set: { draft.toolClasses = $0.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) } }))
            .accessibilityLabel("Tool classes, comma separated")
            DatePicker("Expires", selection: $draft.expiresAt, in: Date()..., displayedComponents: .date)
                .accessibilityLabel("Grant expiry date")
        }
        Section("File dialogs and Finder") {
            Toggle("Allow file-panel input", isOn: $draft.allowFilePanelInput)
                .accessibilityLabel("Allow granted apps to use file dialogs and Finder file browsers")
            Text("Enables Open/Save dialogs and Finder file-browser controls for the apps you grant, including Apple's system panel service. These apps can access files beyond the folders above through their own dialogs. Enable only for apps you trust. Other protected surfaces stay restricted.")
                .font(.caption).foregroundStyle(.secondary)
        }
        Section {
            let problems = draft.problems()
            ForEach(problems, id: \.self) { Text($0).foregroundStyle(.red).font(.caption) }
            HStack {
                Button(store.policy == nil ? "Grant" : "Save Changes") { save() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!problems.isEmpty || !store.isConnected)
                if let result { Text(result).font(.caption) }
            }
        }
        .onAppear {
            if !loaded, let g = store.policy { draft = GrantDraft(grant: g) }
            loaded = true
        }
    }

    private func save() {
        // The proposed workspace folder is created on first grant.
        for root in draft.fileRoots where root.hasSuffix("/" + GrantDraft.workspaceFolderName) {
            try? FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
        }
        Task {
            if await store.savePolicy(draft) { result = "Saved."; onSaved?() } else { result = store.lastError }
        }
    }

    private func pick(directory: Bool) -> String? {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = directory
        panel.canChooseFiles = !directory
        panel.allowsMultipleSelection = false
        if !directory {
            panel.directoryURL = URL(fileURLWithPath: "/Applications")
            panel.allowedContentTypes = [.application]
        }
        return panel.runModal() == .OK ? panel.url?.path : nil
    }
}

// MARK: Remote

struct RemotePane: View {
    @Environment(AppStore.self) private var store
    @State private var code: PairingCode?
    @State private var devices: [RemoteDevice] = []
    @State private var message: String?
    private var client: BillyClient? { store.api as? BillyClient }
    var body: some View {
        Form {
            Section("Phone control (Telegram)") {
                if let c = store.doctor?.check("remote.telegram") { CheckRow(check: c) }
                Text("Store the bot token in your own Terminal: security add-generic-password -U -s com.billy.remote.telegram -a bot -w. Billy never asks for it in chat.")
                    .font(.callout).textSelection(.enabled)
                HStack {
                    Button("Enable Telegram") { run { _ = try await $0.setTelegram(enabled: true); message = "Enabled. Restart the background service to connect." } }
                        .accessibilityLabel("Enable Telegram phone control")
                    Button("Disable") { run { _ = try await $0.setTelegram(enabled: false); message = "Disabled." } }
                }
            }
            Section("Pair a phone") {
                Button("Pair a phone") { run { code = try await $0.pairingCode() } }.accessibilityLabel("Create a one-time pairing code")
                if let code {
                    Text("Send this to your bot from your phone:").font(.callout)
                    Text("/pair \(code.code)").font(.system(.title2, design: .monospaced)).textSelection(.enabled)
                        .accessibilityLabel("Pairing command slash pair \(code.code.map { String($0) }.joined(separator: " "))")
                    Text("Expires \(code.expires_at) (single use).").font(.caption).foregroundStyle(.secondary)
                }
            }
            Section("Paired devices") {
                if devices.isEmpty { Text("No paired devices.").foregroundStyle(.secondary) }
                ForEach(devices) { d in
                    HStack {
                        Text("Telegram user \(d.platform_identity)")
                        Spacer()
                        if let r = d.revoked_at { Text("revoked \(r)").foregroundStyle(.secondary) }
                        else { Button("Revoke") { run { devices = try await $0.revokeDevice(d.platform_identity) } }.accessibilityLabel("Revoke Telegram user \(d.platform_identity)") }
                    }
                }
            }
            if let message { Text(message).font(.callout) }
        }
        .formStyle(.grouped)
        .task { run { devices = try await $0.remoteDevices() } }
    }
    private func run(_ op: @escaping @MainActor (BillyClient) async throws -> Void) {
        guard let client else { message = "Billy core is not reachable."; return }
        Task { @MainActor in
            do { try await op(client) } catch { message = "\(error)" }
        }
    }
}

// MARK: Diagnostics

struct DiagnosticsPane: View {
    @Environment(AppModel.self) private var model
    @Environment(AppStore.self) private var store
    @State private var exported: String?

    var body: some View {
        Form {
            Section("Health checks") {
                if let d = store.doctor {
                    ForEach(d.checks) { CheckRow(check: $0) }
                } else {
                    Text("Doctor unavailable: \(String(describing: store.connection))").foregroundStyle(.secondary)
                }
                HStack {
                    Button("Run Again") { Task { await store.refreshDoctor() } }
                    Button("Export Diagnostics…") { export() }
                        .accessibilityLabel("Export redacted diagnostics to a file")
                    if let exported { Text(exported).font(.caption) }
                }
            }
            Section("Background service") {
                LabeledContent("State", value: model.serviceState.label)
                Text("Close window: Billy keeps working. Quit app: the core service keeps running. Stop Billy (emergency): pauses all work, service stays up. Stop background service: the core stops until started again; data is kept.")
                    .font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button("Start Background Service") { model.startBackgroundService() }
                        .disabled(model.serviceState == .enabled || model.serviceState == .notInstalled)
                    Button("Stop Background Service…") { model.stopBackgroundService() }
                        .disabled(model.serviceState != .enabled && model.serviceState != .requiresApproval)
                    if model.serviceState == .requiresApproval {
                        Button("Open Login Items") { model.service.openLoginItemsSettings() }
                    }
                }
                LabeledContent("Data folder", value: model.paths.dataDir.path)
                LabeledContent("Logs", value: ServiceController.logDir.path)
            }
        }
        .formStyle(.grouped)
        .task { await store.refreshDoctor(); model.refreshService() }
    }

    private func export() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "billy-diagnostics.json"
        panel.allowedContentTypes = [.json]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let data = try DiagnosticsExport.make(status: store.status, doctor: store.doctor, connection: store.connection,
                                                  service: model.serviceState.label, appVersion: AppModel.appVersion)
            try data.write(to: url, options: .atomic)
            exported = "Saved (redacted)."
        } catch { exported = "\(error)" }
    }
}

// MARK: About

struct AboutPane: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Billy").font(.largeTitle.bold())
            Text("Version \(AppModel.appVersion)")
            Text("A personal macOS operator. Your tasks and data stay on this Mac; AI provider calls follow your budget and permissions.")
            Divider()
            Text("Notices").font(.headline)
            Text("Billy.app is built with Swift and Apple system frameworks only (no third-party Swift packages). The embedded core uses Node.js (MIT) and @anthropic-ai/sdk (MIT). Desktop control uses CuaDriver (separately installed, pinned by signature).")
                .font(.callout)
            Spacer()
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
