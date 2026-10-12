# Billy — Environment Report (P0)

Generated from direct probes on the target Mac. Values below are observed, not inferred.
Raw probe output is appended at the end.

## Host envelope (candidate qualification target)
| Item | Observed |
|---|---|
| OS | macOS 26.5.2 (25F84) |
| CPU / arch | Apple M4, arm64, 10 cores |
| Memory | 16 GiB |
| Internal disk free | ~26 GiB (runtime data location: `~/Library/Application Support/Billy`) |
| Workspace volume | `/Volumes/Zeno` — external USB APFS SSD, 95% used, ~51 GiB free. Source only; **no live runtime SQLite here** (handoff §9.1). |
| Display | One external 3440×1440 UWQHD display, non-Retina (scale 1). Multi-display/Retina **not qualified**. |
| Timezone | Africa/Cairo |
| Interactive session | console user present; display sleep disabled; system sleep currently prevented by running apps |

## Toolchains
| Tool | Status |
|---|---|
| Xcode | **Absent** — only Command Line Tools (`/Library/Developer/CommandLineTools`). `xcodebuild` unavailable. |
| Swift | 6.2.3 via CLT. Verified: SwiftUI, Observation macros, SQLite3, Speech, ServiceManagement, ScreenCaptureKit, Network, CryptoKit compile and run with `swift build`. |
| Swift tests | **XCTest and swift-testing NOT available** under CLT (`no such module`). Swift code needs a self-hosted test runner executable. |
| Node | v26.8.2 official nodejs.org build (signed team HX7739G8FX) — binary located in another project's directory; Billy must bundle its own verified copy. Verified: `node:sqlite` (SQLite 3.53.4) incl. `backup()`, native TypeScript type stripping, `node:test`, global `WebSocket` client. |
| Python | 3.13.5 (development tooling only) |
| git / gh | 2.50.1 / 2.101.0. GitHub MCP connector failed to connect this session (auth header error). |
| Containers/VMs | Docker, colima, tart: **absent**. `sandbox-exec` (Seatbelt) present. |
| Remote transport tools | tailscale, cloudflared: **absent** |

## Native control provider
| Item | Observed |
|---|---|
| CuaDriver.app | `/Applications/CuaDriver.app`, cua-driver 0.26.1, universal binary, signed `com.trycua.driver` team YCK386LBJ7, binary sha256 `51b7515e5b124c179f0be56ef87ae5ede226e4a702e0d335b04ed2edd91c03c6` |
| Daemon | not running |
| TCC (Accessibility / Screen Recording) | **unknown** — only readable via the driver's own daemon; no grant performed |

## AI providers available to Billy (the product)
No Billy-specific provider credential exists. The environment contains Claude Code's *own* session
credentials (env var names only were listed; values not read). These belong to the development runtime and
are **not** treated as authorization for Billy's product runtime (handoff §1.2, §10.5).

## Development runtime and continuation (REQ-02)
See `docs/build-continuation.md`.
## Raw probes (2026-10-11T18:28:02Z)
```
ProductName:		macOS
ProductVersion:		26.5.2
BuildVersion:		25F84
arm64
Apple M4
mem_bytes 17179869184 cpus 10
Filesystem        Size    Used   Avail Capacity iused ifree %iused  Mounted on
/dev/disk3s1s1   228Gi    12Gi    26Gi    32%    459k  272M    0%   /
/dev/disk5s1     931Gi   880Gi    51Gi    95%    3.9M  539M    1%   /Volumes/Zeno
/Library/Developer/CommandLineTools
swift-driver version: 1.127.14.1 Apple Swift version 6.2.3 (swiftlang-6.2.3.3.21 clang-1700.6.3.2)
v26.8.2
Python 3.13.5
git version 2.50.1 (Apple Git-155)
3.51.0 2025-06-12 13:14:41 f0c
cua-driver 0.26.1
          Resolution: 3440 x 1440 (UWQHD - Ultra-Wide Quad HD)
          Main Display: Yes
console_user ahri
 networkoversleep     0
 disksleep            10
 sleep                1 (sleep prevented by Claude, bluetoothd, powerd, runningboardd, sharingd)
 displaysleep         0
tz Africa/Cairo
```
