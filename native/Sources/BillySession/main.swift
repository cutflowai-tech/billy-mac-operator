import AppKit
import CoreGraphics
import Foundation

// Read-only OS session facts. One resident helper replaces shelling out four
// times per poll; it never requests accessibility or injects input.
func emitFacts() {
    let session = CGSessionCopyCurrentDictionary() as? [String: Any]
    let onConsole = (session?["kCGSSessionOnConsoleKey"] as? NSNumber)?.boolValue ?? false
    let locked = (session?["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue ?? false
    let idle = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: UInt32.max)!)
    let validIdle = idle.isFinite && idle >= 0
    let facts: [String: Any] = [
        "idle_ms": validIdle ? min(idle * 1000, Double(Int.max / 2)) : 0,
        "locked": !onConsole || locked || !validIdle,
        "frontmost_bundle": NSWorkspace.shared.frontmostApplication?.bundleIdentifier as Any? ?? NSNull(),
        "at": Date().timeIntervalSince1970 * 1000,
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: facts) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}

emitFacts()
if CommandLine.arguments.contains("--watch") {
    let timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in emitFacts() }
    RunLoop.main.add(timer, forMode: .common)
    RunLoop.main.run()
}
