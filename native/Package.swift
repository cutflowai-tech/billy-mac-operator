// swift-tools-version: 6.0
// Billy native app. Builds with Command Line Tools only (no Xcode):
//   swift build -c release            # library + app + test runner
//   swift run BillyTests              # self-hosted test runner (XCTest is unavailable)
//   scripts/build-app.sh              # assemble artifacts/build/Billy.app
import PackageDescription

let package = Package(
    name: "Billy",
    platforms: [.macOS(.v15)],
    products: [
        .library(name: "BillyKit", targets: ["BillyKit"]),
        .executable(name: "Billy", targets: ["Billy"]),
        .executable(name: "BillyTests", targets: ["BillyTests"]),
        .executable(name: "billy-ocr", targets: ["BillyOCR"]),
        .executable(name: "billy-session", targets: ["BillySession"]),
    ],
    targets: [
        // Daemon client, models, state store and voice state machine. No UI.
        .target(name: "BillyKit"),
        // SwiftUI app (menu bar + main window + settings).
        .executableTarget(name: "Billy", dependencies: ["BillyKit"]),
        // Executable test runner: prints PASS/FAIL per test, exits nonzero on failure.
        .executableTarget(name: "BillyTests", dependencies: ["BillyKit"]),
        .executableTarget(name: "BillyOCR"),
        .executableTarget(name: "BillySession"),
    ]
)
