import AppKit
import BillyKit
import Darwin

/// Evidence hook for UI walkthroughs (BILLY_SNAPSHOT_DIR=<dir>): selects the
/// newest task, optionally opens Settings, then captures each of the app's own
/// visible windows to PNG. BILLY_SNAPSHOT_QUIT=1 exits afterwards.
@MainActor
enum Snapshotter {
    static func schedule(into dir: String, store: AppStore) {
        let env = ProcessInfo.processInfo.environment
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(4))
            if store.selectedTaskID == nil, let first = store.tasks.first { await store.select(first.task_id) }
            if env["BILLY_SNAPSHOT_SETTINGS"] == "1" {
                NSApp.activate()
                // SwiftUI's Settings scene answers the standard "Settings…" menu item.
                if let item = NSApp.mainMenu?.items.first?.submenu?.items.first(where: { $0.keyEquivalent == "," }),
                   let action = item.action {
                    NSApp.sendAction(action, to: item.target, from: item)
                }
            }
            try? await Task.sleep(for: .seconds(3))
            capture(into: dir)
            if env["BILLY_SNAPSHOT_QUIT"] == "1" { exit(0) }
        }
    }

    static func capture(into dir: String) {
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        for (i, window) in NSApp.windows.enumerated() where window.isVisible && window.frame.width > 100 {
            guard let cg = windowImage(window) ?? cachedImage(window) else { continue }
            let name = window.title.isEmpty ? "window-\(i)" : window.title.replacingOccurrences(of: " ", with: "-")
            let path = (dir as NSString).appendingPathComponent("\(name).png")
            try? NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
            print("snapshot \(path)")
        }
        fflush(stdout)
    }

    /// Window-server composite of our own window (includes vibrancy). The API is
    /// obsoleted in the macOS 15 SDK in favour of ScreenCaptureKit, which needs
    /// Screen Recording permission, so it is looked up dynamically.
    private static func windowImage(_ window: NSWindow) -> CGImage? {
        typealias Fn = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?
        guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGWindowListCreateImage") else { return nil }
        let f = unsafeBitCast(sym, to: Fn.self)
        // optionIncludingWindow, boundsIgnoreFraming | bestResolution
        return f(.null, 1 << 3, UInt32(window.windowNumber), (1 << 0) | (1 << 3))?.takeRetainedValue()
    }

    /// Fallback: draw the view hierarchy (materials render flat).
    private static func cachedImage(_ window: NSWindow) -> CGImage? {
        guard let view = window.contentView?.superview ?? window.contentView,
              let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return nil }
        view.cacheDisplay(in: view.bounds, to: rep)
        return rep.cgImage
    }
}
