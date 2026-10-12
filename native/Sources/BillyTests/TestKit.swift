import Foundation

// Tiny self-hosted test framework (XCTest / swift-testing are unavailable with
// Command Line Tools only). Each test is an async throwing closure; the first
// failed expectation throws and fails that test.

struct TestFailure: Error, CustomStringConvertible {
    let message: String
    let location: String
    var description: String { "\(location): \(message)" }
}

func expect(_ condition: @autoclosure () throws -> Bool, _ message: @autoclosure () -> String = "expectation failed",
            file: StaticString = #fileID, line: UInt = #line) throws {
    if !(try condition()) { throw TestFailure(message: message(), location: "\(file):\(line)") }
}

func expectEqual<T: Equatable>(_ a: T, _ b: T, _ message: @autoclosure () -> String = "",
                               file: StaticString = #fileID, line: UInt = #line) throws {
    if a != b {
        let extra = message().isEmpty ? "" : " — \(message())"
        throw TestFailure(message: "expected \(b), got \(a)\(extra)", location: "\(file):\(line)")
    }
}

@MainActor
func expectThrows(_ body: () async throws -> Void, _ check: (Error) -> Bool = { _ in true },
                  file: StaticString = #fileID, line: UInt = #line) async throws {
    do { try await body() } catch {
        if check(error) { return }
        throw TestFailure(message: "threw unexpected error \(error)", location: "\(file):\(line)")
    }
    throw TestFailure(message: "expected an error", location: "\(file):\(line)")
}

func unwrap<T>(_ v: T?, _ message: String = "unexpected nil", file: StaticString = #fileID, line: UInt = #line) throws -> T {
    guard let v else { throw TestFailure(message: message, location: "\(file):\(line)") }
    return v
}

@MainActor
final class TestRunner {
    private var tests: [(name: String, body: @MainActor () async throws -> Void)] = []
    private(set) var skipped: [String] = []

    func test(_ name: String, _ body: @escaping @MainActor () async throws -> Void) { tests.append((name, body)) }
    func skip(_ name: String, reason: String) { skipped.append("\(name) (\(reason))") }

    /// Runs tests whose name contains `filter` (all if nil). Returns the exit code.
    func run(filter: String?) async -> Int32 {
        var passed = 0, failed = 0
        let selected = tests.filter { filter == nil || $0.name.contains(filter!) }
        for t in selected {
            let start = Date()
            do {
                try await t.body()
                passed += 1
                print("PASS \(t.name) (\(Int(Date().timeIntervalSince(start) * 1000)) ms)")
            } catch {
                failed += 1
                print("FAIL \(t.name): \(error)")
            }
        }
        for s in skipped { print("SKIP \(s)") }
        print("\n\(passed) passed, \(failed) failed, \(skipped.count) skipped, \(selected.count) run")
        return failed == 0 && passed > 0 ? 0 : 1
    }
}
