// swift-tools-version: 6.0
// NATIVE_LIVE test fixture app (never shipped): an in-process save panel (T-MAC-08)
// and a long scrollable list (T-MAC-06). Built by build.sh into artifacts/fixtures.
import PackageDescription
let package = Package(
    name: "BillyFixture",
    platforms: [.macOS(.v15)],
    targets: [.executableTarget(name: "BillyFixture")]
)
