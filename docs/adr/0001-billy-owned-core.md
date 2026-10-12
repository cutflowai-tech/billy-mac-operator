# ADR-0001: Billy-owned zero-dependency core; reuse Cua driver directly

Status: Accepted (2026-10-11) · Requirements: REQ-03, REQ-10, REQ-30, REQ-33

## Evidence
- OpenClaw v2026.10.1 (commit e178c39e9aae3fa440735217f9aef9574f286677, MIT) — see foundation-audit-openclaw.md.
- Its macOS app needs Swift 6.3 + Xcode 26.4 + `actool`; host has CLT + Swift 6.2.3 only → cannot rebuild/rebrand (CORE_GAP, environmental).
- It launches cua-driver unrestricted with approvals bypassed and relies on a trusted-operator model; Billy requires a single non-bypassable broker (REQ-10). Its before-tool-call hook has a published bypass history (GHSA-68xw-r643-9p5w).
- Gateway adoption = ~1,710 npm packages; 722 published advisories (14 critical).
- Host probes: node:sqlite (3.53.4, FTS5, backup), node:test, native TS stripping all work with zero npm deps; SwiftUI/Speech/SMAppService build under CLT.

## Decision
- Core (`billyd`): TypeScript on a bundled, checksum-verified official Node runtime. Amended by ADR-0003: one audited runtime dependency (`@anthropic-ai/sdk`).
- Native app: Swift/SwiftUI via SwiftPM under CLT, manual .app assembly; self-hosted Swift test runner (XCTest absent).
- Desktop control: installed CuaDriver.app 0.26.1, pinned by binary sha256 + team ID, invoked only through Billy's broker.
- Phone path: one Telegram bot adapter (long-poll, outbound-only, numeric-ID owner binding).
- OpenClaw is retained as an audited reference, not a runtime dependency.

## Consequences
Billy owns its scheduler/retry/journal outright (no split lifecycle ownership). Any OpenClaw capability not reused is reimplemented narrowly and covered by Billy's own tests.
