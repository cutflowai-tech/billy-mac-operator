# Foundation audit: OpenClaw v2026.10.1

Status: PARTIAL. Source has been inspected. Nothing here has been proven at runtime.
Revision: tag `v2026.10.1` (tag object 250c0e30dcb1c4fb661b55af912236773b58f1b8), commit `e178c39e9aae3fa440735217f9aef9574f286677`. Checked out 2026-10-11T18:26:34Z into `upstream/src/openclaw` (gitignored), shallow clone. No install, build or upstream code was run. Lock: `upstream/openclaw.lock.json`.

Nothing in this audit is VERIFIED_REUSE, because no runtime proofs exist yet.

## 1. License and third-party components
- `LICENSE`: MIT, "Copyright (c) 2026 OpenClaw Foundation", sha256 `9efd316e…9c82a4`.
- `THIRD_PARTY_NOTICES.md`: Pi / pi-mono (MIT, Mario Zechner; portions adapted, plus `@earendil-works/pi-tui`) and GitHub Octicons (MIT).
- macOS SwiftPM pins (`apps/macos/Package.resolved`): Sparkle 2.10.0, openclaw/Peekaboo 4.7.0, openclaw/AXorcist 0.1.11, GRDB 7.11.1, KeyboardShortcuts 3.1.0, swift-subprocess 1.0.0, swift-log, swift-markdown/cmark, SwiftMath, ElevenLabsKit, Commander.
- Cua: `extensions/cua-computer/package.json` pins `@trycua/cua-driver` 0.28.2. The macOS universal archive sha256 is `386db225…6daa`. It is downloaded from `trycua/cua` releases tag `cua-driver-rs-v0.28.2` by `scripts/stage-cua-driver-macos.sh`.
- The licenses of the Cua driver and its optional perception parts are not in this repo. They must be inventoried from the trycua/cua release. Status: UNVERIFIED.

## 2. Layout and stack
- This is a TypeScript ESM monorepo, run with `openclaw.mjs` as the bin.
  - Directories: `src/` (gateway, agents, cron, sessions, plugins, …), `packages/*` (plugin-sdk, gateway-protocol, agent-core, …), `extensions/*` (161 plugin packages: channels, providers, memory, browser, cua-computer, …), `ui/` (Vite Control UI), `apps/` (macos, ios, android, linux, shared Swift kits), `crates/` (Rust gateway-client and node-host).
- Node engine: `>=24.16.0 <25 || >=26.1.0`. Host Node v26.8.2 satisfies this.
- Package manager: `pnpm@12.5.1`. `pnpm-workspace.yaml` sets minimumReleaseAge to 7 days and blockExoticSubdeps.
- Dependency tree: `pnpm-lock.yaml` has 18,342 lines (lockfile v9), about 1,710 resolved packages and 189 workspace importers. The root package.json has 65 deps and 63 devDeps.
- Checkout size is 914 MB, 52,451 files.

## 3. macOS app
- Location: `apps/macos`. It is a pure SwiftPM project (`Package.swift`) with no `.xcodeproj`. Packaging is `scripts/package-mac-app.sh`, which calls `scripts/build-mac-swift.mts`.
- **The app cannot be built on this host.** Classification: CORE_GAP for Billy's toolchain.
  - `Package.swift`, OpenClawKit, swabble and the MLX protocol all declare `swift-tools-version: 6.3`. The host has Swift 6.2.3 from Command Line Tools.
  - `docs/platforms/mac/dev-setup.md` requires Xcode 26.4+.
  - Packaging calls `xcrun actool` (`package-mac-app.sh:468`), which is not present under CLT. I confirmed this with `xcrun -f actool`.
  - Packaging also runs `pnpm install` and stages a Node runtime.
- Bundle id: `ai.openclaw.mac` in `Sources/OpenClaw/Resources/Info.plist`. Packaging defaults to `BUNDLE_ID=ai.openclaw.mac.debug`, and it can be overridden by env. There are about 122 `ai.openclaw` string references in the mac Sources (log subsystems, keychain services, LaunchAgent labels).
- Sparkle: `SPARKLE_FEED_URL` and `SPARKLE_PUBLIC_ED_KEY` are overridable env vars in `package-mac-app.sh`. Sparkle is disabled for `*.debug` ids. The appcast at this tag lists mac app 2026.9.8, so the app releases lag the npm release.
- Cua bundling: the driver is staged at `Contents/Resources/cua-driver`. `CuaDriverHostCoordinator.swift:makeProcessLaunch` spawns it as a direct app child so that it inherits the app's TCC grants. The arguments are:
  ```
  cua-driver serve --embedded --parent-liveness-stdio --no-permissions-gate --socket <0700 dir>/cua.sock --host-bundle-id <id> --permission-mode unrestricted --dangerously-bypass-approvals
  ```
- Rebranding: the env overrides make it feasible, but the app still needs Xcode 26.4+ to build. A renamed or re-signed app needs fresh TCC grants. Classification: CONFIGURATION_GAP plus a toolchain blocker.

## 4. Computer-use surface
- There is one built-in model tool, `computer` (`src/agents/tools/computer-tool.ts`). It produces node commands `computer.act` and `screen.snapshot`. Action names are listed in `src/plugins/computer-use-contract.ts:COMPUTER_USE_V2_ACTION_NAMES`:
  - `screenshot`, `left_click`, …, `type`, `key`, `list_apps`, `list_windows`, `get_accessibility_tree`, `launch_app`, `kill_app`, `set_value`, `browser_*`, and recording actions.
- On macOS:
  - The node worker sets env `OPENCLAW_CUA_DRIVER_ENDPOINT={v:1,socketPath,binaryPath}` (`extensions/cua-computer/src/commands.ts:resolveMacOsMcpEndpoint`).
  - It then spawns `cua-driver mcp --embedded --socket <path>` as an MCP stdio proxy to the app-owned daemon (`src/mcp-driver-client.ts:createClient`).
  - Without that endpoint, macOS reports unsupported, so the app is required.
- On Windows and Linux, the in-process SDK is called with `createTrustedSession` and `SessionPermissionMode.Unrestricted` (`src/driver-client.ts:DirectCuaDriverSession`).
- Permission model:
  - Cua bounded mode and its manifest are deliberately NOT used. The driver runs unrestricted with approvals bypassed (`docs/nodes/computer-use.md` lines 106-114).
  - Authorization happens above the driver:
    - tool exposure (tool profiles, `tools.alsoAllow`)
    - device and command pairing approval
    - node-invoke risk classification (`src/node-invoke-policy.ts`)
    - OS permissions
  - The 0600 socket inside a 0700 directory is the only local boundary. It does not protect against other processes running as the same user.
- Minimum Cua driver: exactly 0.28.2, pinned with a sha. Provider selection never falls back per action.
- For Billy:
  - Billy's action boundary must wrap `computer` at the gateway or tool level, and must also mediate other bypass routes (exec, node.invoke, MCP).
  - Possible adapter: a Billy-owned Swift helper built with `swift build` on 6.2. It would spawn cua-driver under Billy's TCC identity and inject `OPENCLAW_CUA_DRIVER_ENDPOINT`. Classification: ADAPTER_GAP, UNVERIFIED.

## 5–10. Plugin hooks, sub-agents/persistence/cron, exec sandbox, remote/channels/pairing, providers/Claude CLI, memory
PENDING. Three parallel source sub-audits were launched and had not returned when this file was written. Every item below is **UNVERIFIED** until a follow-up audit completes it.

What I did observe:
- **Plugin hooks:** the SDK lives in `packages/plugin-sdk` and `src/plugins`. Plugins register through `definePluginEntry({register(api)})`, with `api.registerNodeInvokePolicy` and `registerComputerUseProvider` used in cua-computer.
- **Hook bypass history:** advisory GHSA-68xw-r643-9p5w ("Skill-command dispatch could skip before-tool-call hooks", fixed earlier) shows a before-tool-call hook exists and has had bypass paths. Any "single chokepoint" claim needs a runtime proof against every tool entry path.
- **Trust model (`SECURITY.md`):** OpenClaw is built for trusted operators and is not a multi-tenant boundary. It says "Anyone who can operate an agent can make it do anything that agent can do." Malicious enabled plugins are out of scope.
- **Sandbox:** the gateway's sandbox stack is documented around Docker, Podman and OpenShell (`docs/install/*`). Docker is absent on this host, so a sandbox substrate on macOS is an open question. Classification: UNVERIFIED, likely CORE_GAP for Billy §11.3.

## 11. Security advisories
- Source: `gh api repos/openclaw/openclaw/security-advisories`, fetched 2026-10-11. Raw list saved to `artifacts/foundation/openclaw-ghsa-2026-10-11.tsv`.
- 722 published advisories: 14 critical, 249 high, 390 medium, 69 low.
- Every listed patched version is ≤ 2026.9.3, so none is shown as unpatched in 2026.10.1. Draft or private advisories are not visible through this API.
- Recurring classes:
  - pairing and scope escalation to `operator.admin` or node RCE (several critical)
  - exec-approval and allowlist bypasses
  - sandbox escapes
  - webhook authentication
  - owner-authorization omissions in tools
- Billy must treat OpenClaw's authorization as defense-in-depth, not as its sole policy engine.

## REUSE RECOMMENDATION (provisional)
**Recommendation: a Billy-owned core that reuses specific OpenClaw pieces, not "Billy as an OpenClaw plugin".** This is to be confirmed once sections 5–10 are complete.

Why:
1. **The native app needs Xcode 26.4+ (Swift 6.3, actool), which this host lacks.** Rebranding or rebuilding OpenClaw.app is blocked. The signed upstream app has the wrong identity and update channel for Billy.
2. **The computer-control authority is unrestricted by design.** OpenClaw's authority model (operator-trusted, unrestricted Cua, many bypass-class advisories) conflicts with Billy's single action-broker and no-bypass requirements (§6, §11.2). Making OpenClaw the authority owner would split ownership of retry, scheduling and policy.
3. **The gateway is reusable as a headless runtime.** The npm `openclaw@2026.10.1` gateway runs on the host Node, under MIT. Candidates for reuse via configuration or adapters:
   - Control UI and remote pairing
   - channel adapters (Telegram and similar)
   - provider adapters
   - the `cua-computer` provider code and the pinned-driver verification pattern
   - possibly the before-tool-call hook as a second enforcement layer

Proposed next proofs, with owner in brackets:
- (a) a hook-coverage proof across exec, file, computer, MCP, sub-agent and cron paths [foundation auditor];
- (b) Billy Swift helper (Swift 6.2, CLT) spawns pinned cua-driver 0.28.2 under Billy's bundle id, and the gateway consumes `OPENCLAW_CUA_DRIVER_ENDPOINT` [native builder];
- (c) a remote phone path through Control UI device pairing or Telegram [remote builder].

## Addendum — questions 5–10 (sub-audits, source-read only, 2026-10-11)
All items below are source/doc inspection at e178c39e; none are runtime-proven → classification UNVERIFIED unless stated.

| Area | Finding (source refs) | Bearing on Billy |
|---|---|---|
| Plugin hooks | `before_tool_call` (src/plugins/hook-types.ts; runBeforeToolCall hooks.ts:1015) can block/rewrite/requireApproval; fail-closed on error/15s timeout. | Real per-call hook, but coverage is route-dependent (next rows). |
| Hook coverage gaps | Gemini CLI native tools and ACP-agent native tools bypass it; Codex can block only; claude-cli forced to `--permission-mode bypassPermissions` when exec mode=full (extensions/anthropic/cli-shared.ts:129-141). | Violates REQ-10 "no bypass routes" unless those backends are excluded. |
| Exec / sandbox | Default exec `security:full, ask:off`; sandbox `mode:off`; backends docker/podman/ssh/openshell/crabbox; **no Seatbelt** (src/agents/sandbox/backend.ts:274). | No local containment substrate on this host (no Docker/Podman). Billy must provide its own (Seatbelt) for REQ-10/T-SEC-03. |
| Side-effect ledger | No general per-tool journal; restart safety via replay-safe tool-name list (src/agents/tool-replay-safety.ts) and dropping dangling calls. Narrow ledgers: `worker_session_tool_operations`, cron `delivery-attempt-fence.ts`. | Billy needs its own journal-before-dispatch (REQ-08). Borrow the fence pattern. |
| Sub-agents | `subagent_runs` in SQLite; restarts finalize children as interrupted (not relaunched); cascade kill exists; depth ≤5. | Sound reference model; Billy's child lifecycle must also own effects reconciliation. |
| Sessions/state | node:sqlite + Kysely; state schema v20, agent schema v24. | Confirms node:sqlite viability. |
| Memory | memory-core: provenance `origin_class` owner/agent/untrusted/system; forget = tombstone then purge incl. FTS/vec; transcripts not purged. | Reference design for REQ-21/22; Billy implements a smaller equivalent. |
| Remote | Gateway token/password auth, Origin allowlist (no CSRF token), Ed25519 device pairing; Telegram needs only a BotFather token, numeric-ID allowlist, long polling. | Telegram chosen as Billy's single phone path (ADR-0001). |
| Providers | Keys in plaintext SQLite (no Keychain); cross-provider fallback can be silent in channel conversations; Anthropic server-side fallback is automatic for API-key requests. | Billy must forbid unapproved failover (REQ-15, T-SEC-12) and store keys in Keychain. |

Conclusion unchanged: ADR-0001 (Billy-owned core, Cua driver reused directly).
