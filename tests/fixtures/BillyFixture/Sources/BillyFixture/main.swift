// Billy NATIVE_LIVE fixture. Arguments:
//   --save-dir <dir>   initial directory of the save panel
//   --content <text>   initial document content
//   --rows <n>         rows in the list (default 300)
//   --title <text>     window title (unique per test run)
// (each also readable from the config file as save-dir/content/rows/title)
import AppKit

// Settings come from argv or, when launched through LaunchServices (no argv), from
// ~/Library/Caches/<bundle id>/config.json written by the test beforehand (one file per fixture app).
let args = CommandLine.arguments
let config: [String: String] = {
    let id = Bundle.main.bundleIdentifier ?? "com.billy.fixture"
    let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Caches/\(id)/config.json")
    guard let d = try? Data(contentsOf: url), let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return [:] }
    return j.compactMapValues { "\($0)" }
}()
func arg(_ name: String) -> String? {
    if let v = args.firstIndex(of: name).flatMap({ $0 + 1 < args.count ? args[$0 + 1] : nil }) { return v }
    return config[String(name.dropFirst(2))]
}

@MainActor final class Fixture: NSObject, NSApplicationDelegate, NSTableViewDataSource, NSTableViewDelegate {
    let window = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 520, height: 560), styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
    let content = NSTextField(string: arg("--content") ?? "")
    let status = NSTextField(labelWithString: "Not saved")
    let selected = NSTextField(labelWithString: "Selected: none")
    let table = NSTableView()
    let rows = Int(arg("--rows") ?? "300") ?? 300

    func applicationDidFinishLaunching(_ n: Notification) {
        let menu = NSMenu()
        let appItem = NSMenuItem(); menu.addItem(appItem)
        let appMenu = NSMenu(); appMenu.addItem(withTitle: "Quit BillyFixture", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"); appItem.submenu = appMenu
        let fileItem = NSMenuItem(); menu.addItem(fileItem)
        let fileMenu = NSMenu(title: "File"); fileMenu.addItem(withTitle: "Save Report…", action: #selector(save), keyEquivalent: "s"); fileItem.submenu = fileMenu
        NSApp.mainMenu = menu

        window.title = arg("--title") ?? "Billy Fixture"
        content.setAccessibilityLabel("Report content")
        let button = NSButton(title: "Save Report…", target: self, action: #selector(save))
        status.setAccessibilityLabel("Save status")
        selected.setAccessibilityLabel("Selection status")
        let col = NSTableColumn(identifier: .init("item")); col.title = "Item"; col.width = 460
        table.addTableColumn(col); table.dataSource = self; table.delegate = self; table.setAccessibilityLabel("Items")
        let scroll = NSScrollView(); scroll.documentView = table; scroll.hasVerticalScroller = true
        let stack = NSStackView(views: [content, button, status, scroll, selected])
        stack.orientation = .vertical; stack.alignment = .leading; stack.edgeInsets = NSEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
        scroll.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([scroll.heightAnchor.constraint(equalToConstant: 360), scroll.widthAnchor.constraint(equalToConstant: 480), content.widthAnchor.constraint(equalToConstant: 480)])
        window.contentView = stack
        window.makeKeyAndOrderFront(nil)
    }

    func numberOfRows(in tableView: NSTableView) -> Int { rows }
    func tableView(_ t: NSTableView, viewFor c: NSTableColumn?, row: Int) -> NSView? {
        // Each row is an actionable control (like many native lists): pressing it selects the row.
        let title = String(format: "Item %03d", row + 1)
        let id = NSUserInterfaceItemIdentifier("row")
        let b = (t.makeView(withIdentifier: id, owner: self) as? NSButton) ?? {
            let n = NSButton(title: "", target: self, action: #selector(pick(_:))); n.identifier = id; n.isBordered = false; n.alignment = .left; return n
        }()
        b.title = title; b.tag = row; b.setAccessibilityLabel(title); return b
    }
    @objc func pick(_ sender: NSButton) { table.selectRowIndexes([sender.tag], byExtendingSelection: false) }
    func tableViewSelectionDidChange(_ n: Notification) {
        selected.stringValue = table.selectedRow >= 0 ? String(format: "Selected: Item %03d", table.selectedRow + 1) : "Selected: none"
    }

    @objc func save() {
        let panel = NSSavePanel()
        panel.title = "Save Report"
        if let d = arg("--save-dir") { panel.directoryURL = URL(fileURLWithPath: d, isDirectory: true) }
        panel.nameFieldStringValue = "report.txt"
        panel.canCreateDirectories = false
        panel.showsTagField = false
        // Wide enough that the column browser shows the current folder's contents without horizontal scrolling.
        panel.setContentSize(NSSize(width: 1500, height: 560))
        guard panel.runModal() == .OK, let url = panel.url else { status.stringValue = "Save cancelled"; return }
        do {
            try Data(content.stringValue.utf8).write(to: url, options: .atomic)
            status.stringValue = "Saved: \(url.path)"
        } catch { status.stringValue = "Save failed: \(error.localizedDescription)" }
    }
}

let app = NSApplication.shared
let delegate = Fixture()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
