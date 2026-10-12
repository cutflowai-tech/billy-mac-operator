# Foundation audit: Cua Driver 0.26.1

Audit date: 2026-10-11. Scope: what is installed now, read-only. The daemon was never started, no desktop action was run, no permission was granted, and no global config was changed.

## 0. Provenance and method

| Item | Value | How established |
|---|---|---|
| App bundle | `/Applications/CuaDriver.app`, `CFBundleIdentifier=com.trycua.driver`, `CFBundleShortVersionString=0.26.1`, `LSUIElement=true`, `LSMinimumSystemVersion=13.0` | `plutil -p Info.plist` |
| Main binary | `Contents/MacOS/cua-driver`, universal (x86_64, arm64), sha256 `51b7515e5b124c179f0be56ef87ae5ede226e4a702e0d335b04ed2edd91c03c6` | `shasum -a 256` |
| Helper binary | `Contents/MacOS/cua-cursor-theme`, sha256 `f234ef95b11be3b78ef2b1c1b4dcb8566cb678fd5c4e97b5688d3b3987f5dd2f` | `shasum -a 256` |
| Signature | Developer ID Application: Cua AI, Inc. (YCK386LBJ7), hardened runtime, notarization ticket stapled, timestamp 2026-09-10 | `codesign -dvv` |
| Entitlements | `com.apple.security.automation.apple-events`, `com.apple.security.device.screen-capture`, `keychain-access-groups=[YCK386LBJ7.com.trycua.driver]`, application-identifier. Not sandboxed. | `codesign -d --entitlements -` |
| Usage strings | NSAppleEventsUsageDescription, NSScreenCaptureUsageDescription | Info.plist |
| CLI | `~/.local/bin/cua-driver` symlinks to `/Applications/CuaDriver.app/Contents/MacOS/cua-driver` | `readlink` |
| Upstream source | `https://github.com/trycua/cua`, tag `cua-driver-rs-v0.26.1` (lightweight tag), commit **`cc54254464c0c9aebfd6547fe7e4a0ceaf0456d7`**. Sparse blobless checkout at `upstream/src/cua` (gitignored), paths `libs/cua-driver/`, `LICENSE.md`, `README.md`. `libs/cua-driver/rust/VERSION` = `0.26.1`. | `git rev-parse`, `git describe --exact-match` |
| Binary vs. source | **Not proven identical.** The build is not reproducible here, and upstream code was not built. The version strings match (CLI banner, Info.plist, Cargo workspace `version = "0.26.1"`). | — |

Read-only CLI commands I ran, each with `CUA_DRIVER_RS_TELEMETRY_ENABLED=0`: `--help`, `list-tools`, `describe <each tool>`, `manifest -p`, `telemetry status --json`, `status`, `permissions status --json`, `check-update --json`. I did not run `config`, `doctor` or `diagnose`. `config` requires a running daemon (`cli.rs::run_config_cmd` exits if no socket). The help text for `doctor` and `diagnose` does not say they are read-only.

Observed runtime state:
- `status` printed "Cua Driver daemon is not running" (exit 1).
- `permissions status --json` returned `{"status":"unknown","daemon_running":false}`, so TCC status is still **unknown**.
- `check-update --json` reports that 0.34.1 is the latest stable release and `update_available: true`. **Installed 0.26.1 is 8 minor versions behind.** All findings below apply to 0.26.1 only.
- `telemetry status --json` (with the env override) shows `enabled:false, source:"environment"`, `installation_id_present:true`, `registration_recorded:true`. This means an install/registration event was already sent when the driver was installed on 2026-09-10. `~/.cua-driver/` already contains `.telemetry_id`, `.installation_recorded`, `skills/` and `version_check.json`. It does not contain `config.json`, so the persisted telemetry preference is unset and the default is **on**.

Artifacts written:
- `upstream/cua-driver-0.26.1-tools.json`: all 56 tools as `{name, description, input_schema}`, parsed verbatim from `cua-driver describe <name>`.
- `upstream/cua-driver-0.26.1-cli-manifest.json`: output of `cua-driver manifest -p`.
- `upstream/cua.lock.json`.

Classification legend:
- **SOURCE**: read in the upstream code or docs at the commit above.
- **CLI-OBSERVED**: seen from a read-only command against the installed binary.
- **UNVERIFIED**: not runtime-proven. Every desktop-acting capability below is UNVERIFIED.

---

## 1. Licensing

| Component | License | Evidence |
|---|---|---|
| Cua monorepo | MIT, "Copyright (c) 2025 Cua AI, Inc." | `LICENSE.md` at root |
| cua-driver Rust workspace (all 13 crates, incl. `cua-driver`, `-core`, `-sdk`, `-contract`, `platform-macos`, `cursor-overlay`, `cursor-theme-cli`, `pip-preview`) | MIT (`[workspace.package] license = "MIT"`) | `libs/cua-driver/rust/Cargo.toml` |
| `@trycua/cua-driver` npm SDK 0.26.1 | MIT (package.json) | `libs/cua-driver/typescript/package.json` |
| Its native `cua_driver_node_runtime.node` | **MPL-2.0**, derived from `uniffi-bindgen-react-native` 0.31.0-3 | `libs/cua-driver/scripts/node-runtime-NOTICE.md` |
| Python SDK | MIT | `libs/cua-driver/python/pyproject.toml` |
| Third-party Rust crates linked into the binary | Mostly permissive. `Cargo.lock` lists 604 packages, including MPL-2.0 crates (`uniffi`/`uniffi_core` 0.31.0 via `cua-driver-sdk`, `option-ext` 0.2.0), `webpki-roots` 1.0.7 (CDLA-Permissive-2.0), `ring` 0.17.14 (Apache-2.0 AND ISC), `regorus` 0.10.1 (MIT/Apache, optional `rego` feature, on by default), `zstd-sys` (BSD), `openssl` (Apache-2.0; probably Linux-only). Which of these are actually linked into the macOS binary is **UNVERIFIED**. | `rust/Cargo.lock`, crate `Cargo.toml`s |
| AGPL / GPL | None found in the driver workspace manifests. `strings` on the binary found no GPL/AGPL/LGPL/MPL/Apache license text. | grep, `strings` |

The **app bundle contains no LICENSE, NOTICE or third-party attribution file**. It holds only Info.plist, the two binaries, AppIcon.icns, the provisioning profile and signatures.

Notices Billy should ship:
- If Billy only *invokes* the user-installed CuaDriver.app: nothing is redistributed, so no notice is strictly required. Credit it in docs anyway.
- If Billy ever *redistributes* the binary or the npm SDK, it must include:
  - the MIT text from `LICENSE.md` (Cua AI, Inc.);
  - the MPL-2.0 notice and source pointer for `cua_driver_node_runtime.node` (npm SDK only);
  - a generated third-party notice for the Rust dependency graph at commit `cc54254`, for example from `cargo about` or `cargo deny list`. This has not been produced yet; it is open item O-1.

## 2. Transports

### 2.1 Daemon socket (`serve`): SOURCE, socket path CLI-OBSERVED

- **Path (release install)**: `~/Library/Caches/cua-driver/cua-driver.sock`. PID file: `~/Library/Caches/cua-driver/cua-driver.pid`. A source-built "local" install uses the `cua-driver-local` namespace instead. `--socket <path>` overrides the socket path.
  - Source: `cua-driver-core/src/daemon.rs::socket_path_for_namespace`, `cua-driver/src/serve.rs::default_pid_file_path`, `bundle.rs::state_namespace`.
- **Wire protocol**: one line of JSON per message (NDJSON) over a Unix domain socket.
  - Request: `{"method":"call","name":"<tool>","args":{...},"session_id":"<transport id>","client_kind":"cli"|...}`.
  - Other methods: `list`, `describe`, `metadata`, `authorization_status`, `revoke_authorization`, `session_end`, `shutdown`, `shutdown_if_pid`, `trusted_session_begin`/`resume` (embedded mode only), `mcp_envelope_stream`, and history control.
  - Response: `{"ok":true,"result":<MCP tool result: content[], structuredContent, isError?>}` or `{"ok":false,"error":"...","exit_code":N}`.
  - Client timeouts: 5 s write, 10 s per read, 120 s overall deadline.
  - Source: `serve.rs` header comment and connection loop; `daemon.rs::DaemonRequest`/`DaemonResponse`/`send_request`.
- **Client authentication (the "authenticated transport lease")**: this is OS-level only.
  - The daemon chmods the socket to `0600` (`serve.rs::secure_local_socket`).
  - On every accept it checks that the peer's UID (`peer_cred`) equals the daemon's effective UID (`authenticate_unix_peer`).
  - There is no token or code-signature check. **Any process running as the same user can call any tool, and can also send `shutdown`.**
  - "Lease" means the per-connection transport identity (`session_id`). The CLI mints `cli-<uuid>` per call. The MCP proxy mints one ID per proxy process and holds a control connection; when that connection closes (EOF, including kill -9), the daemon reaps the session.
  - Lifecycle state (cursor, recording, config overrides, idle TTL of 5 minutes by default) hangs off this identity or off an explicit public `session` label.
  - A **session label is never an authority or credential** (`Skills/cua-driver/SKILL.md` "Keep authorization separate from sessions").
  - Embedded mode adds a stronger check: `trusted_session_*` methods require the peer PID to equal the daemon's parent PID (`authenticate_embedded_host_connection`).
- **Permission gate**: until the TCC helper probe completes, every `call` returns `permissions_pending ...` with exit_code 75 (`serve.rs::permission_gate_response_for_state`).

### 2.2 `cua-driver call <tool> [json]`: SOURCE (`cli.rs::run_call`)

- **Does not start a daemon.** If the socket is absent it prints "Cua Driver daemon is not running ..." and exits 1. It first checks daemon/CLI contract compatibility (`require_compatible_daemon`).
- Arguments come from one positional JSON argument, or from stdin if that argument is omitted. An unknown first subcommand is treated as a tool name, so `cua-driver click '{...}'` equals `cua-driver call click '{...}'`. `--screenshot-out-file <path>` writes the image content to a file.
- Each call uses a disposable lease `cli-<uuid>` and is followed by a `session_end` request. If the args contain `session:"<label>"`, it uses the shared `cli-explicit` namespace instead and does not clean up.
- **Output format**:
  - Prints `structuredContent` as pretty JSON on stdout.
  - Any image content is merged into that JSON as `screenshot_png_b64` / `screenshot_mime_type`, unless `--screenshot-out-file` is used.
  - If there is no `structuredContent`, it prints the text content items instead.
  - Transport or daemon errors (`ok:false`) go to stderr and the process exits with the daemon's `exit_code`: 64 unknown tool, 65 bad JSON, 75 permissions pending, 77 authorization, otherwise 1.
- **Risk: tool-level failures may exit 0.**
  - The daemon returns `ok:true` with `result.isError:true` for tool errors and refusals (`serve.rs::invoke_daemon_tool`, `sdk_adapter.rs::invoke_raw`).
  - `run_call` never reads `isError`. It prints `structuredContent` (for example `{"status":"refused","refusal":{...}}`) and exits **0**.
  - A broker using `call` must parse the payload, for example `effect`, `status`, `refusal`. The exit code alone is not reliable.
  - This is source-inferred and UNVERIFIED at runtime.

### 2.3 MCP stdio (`cua-driver mcp`): SOURCE

- On macOS, `mcp` without `--direct` is a **proxy**: JSON-RPC over stdin/stdout, forwarded to the daemon socket.
- If no daemon is listening, the proxy **auto-launches** one with `/usr/bin/open -n -g -a CuaDriver --args serve [--socket p] [--permission-mode m] [--capability-manifest f --approve-capability-manifest] [--grant ...]` and waits up to 10 s. Source: `cli.rs::run_mcp_via_daemon_proxy`, `launch_daemon_with_state_and_wait`, `daemon_launch_arguments`.
- An existing daemon keeps whatever mode it was launched with. `--grant` against a running daemon is refused.
- `mcp --direct`: the runtime lives inside the MCP process, with **TCC attributed to the invoking host**. There is no overlay unless a UI adapter is present.
- `mcp --embedded --socket p`: connects to a host-owned `serve --embedded` daemon and never auto-launches.
- One proxy process is one MCP session. `isError` is preserved in standard MCP form.

### 2.4 SDKs: SOURCE

- `@trycua/cua-driver` (Node; MIT plus an MPL-2.0 native module):
  - `CuaDriver.create()` runs the driver in-process, with TCC attributed to the Node host and no overlay.
  - `CuaDriver.connect(socketPath)` connects to a daemon.
  - `EmbeddedCuaDriverHost` spawns and owns a private daemon.
  - Source: `Skills/cua-driver/EMBEDDING.md`.
- There is no Swift SDK at this tag. UniFFI bindgen exists in `cua-driver-bindgen` but no Swift package ships.

### 2.5 Recommendation for Billy's broker (one-shot invocations)

1. **Preferred for Node/TS or Swift: talk NDJSON directly to the daemon socket.**
   - Open a connection, send one `call` line, read one response line, then optionally send `session_end` for the same `session_id`, and close.
   - This keeps the full MCP result (`isError`, `content`, `structuredContent`) and adds no process spawn per action.
   - Element snapshot/token state lives in the daemon, so it survives across connections (§5).
   - Implementing it is about 50 lines in either language.
   - Billy must mint its own `session_id` (`billy-<uuid>`) and send `client_kind` (or omit it).
   - Because socket authentication is same-UID only, Billy should run its **own private daemon on a private `--socket` path** under a directory it owns (mode 0700) and pin the version with the `metadata` method.
2. **Acceptable fallback: `cua-driver call`.** It is simple, but it spawns a process per action and has the exit-code ambiguity in §2.2. Billy must always parse stdout JSON for `effect`/`status`/`refusal`.
3. **MCP stdio** fits if Billy's model loop speaks MCP natively. It is a poor fit for a broker that wants one-shot, policy-checked calls, and on macOS it can silently auto-launch the shared default daemon.

Classification: all transport facts are SOURCE (socket path and CLI shape also CLI-OBSERVED); actual round-trips are UNVERIFIED.

## 3. Permission and capability model: SOURCE

**Permission mode.** The mode is fixed at daemon startup and cannot change for the daemon's lifetime or through any tool call. Source: `cua-driver-core/src/authorization.rs`, `--help`.

| Mode | Behavior |
|---|---|
| `standard` (default) | Promptless routine automation. Only residual boundaries need explicit host authorization, mainly attaching to an existing logged-in browser profile, which needs `--grant existing-profile` at launch or an embedding authorization host. |
| `bounded` (alias `autonomous`) | **Requires** `--capability-manifest <path> --approve-capability-manifest`. There is no runtime approval path; anything outside the manifest is denied. |
| `unrestricted` | Needs `--dangerously-bypass-approvals`, or the env pair `CUA_DRIVER_PERMISSION_MODE=unrestricted` + `CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS=1`. `CUA_DRIVER_DISABLE_UNRESTRICTED` exists to forbid it. |

**Risk classes.** Each tool is tagged R0 to R3 (`authorization.rs::advertised_risk_for`):
- R0: metadata, e.g. `get_screen_size`, `health_report`.
- R1: local reversible input, e.g. `click`, `type_text`, `press_key`, `hotkey`, `set_value`, `invoke_menu`, `launch_app`, sessions.
- R2: reveals or controls sensitive state, e.g. `list_windows`, `verify_state`, `get_browser_state`, `browser_navigate`/`click`/`type`, `clipboard_read`.
- R3: external, file or compound side effects, e.g. `get_window_state`, `get_desktop_state`, `kill_app`, `page`, `browser_download`, `browser_set_input_files`.
- Unknown tools are `Unclassified` and fail closed.

**Policy layers.** Hard invariants, then a managed policy (`CUA_DRIVER_MANAGED_POLICY_FILE`), then a user policy (`CUA_DRIVER_POLICY_FILE`; YAML, or a Rego directory). Each layer can only narrow. Source: `policy.rs`.

**Capability manifest.**
- Format: **YAML**, parsed with `deny_unknown_fields`. Source: `cua-driver-core/src/session_manifest.rs::RawManifest`.
- Location: there is no default location. The trusted launcher passes it with `serve|mcp --capability-manifest <path> --approve-capability-manifest`, or with env `CUA_DRIVER_CAPABILITY_MANIFEST_FILE` + `CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED=1`. The deprecated `--session-policy` / `CUA_DRIVER_SESSION_POLICY_FILE` names are still accepted.
- The manifest is loaded once and is immutable. Its sha256 is computed over a domain separator plus the file bytes.
- It is a **narrow-only, deny-by-default ceiling** in every mode, and mandatory in `bounded`.

Version 3 schema:

```yaml
version: 3                 # 1|2 legacy (require mode: bounded + both lifetimes); v3 forbids `mode` and `ask`
expires_after: 8h          # optional in standard/unrestricted, REQUIRED in bounded; s|m|h, >0, <=24h
idle_timeout: 30m          # optional/REQUIRED likewise; <= expires_after
allow: { tools: [get_window_state, click, type_text, ...] }   # non-empty
deny:  { tools: [kill_app, ...] }                             # disjoint from allow
resources:
  apps:                    # v2+: exactly one of bundle_id | executable (canonical absolute path)
    - { bundle_id: com.apple.TextEdit, launch: true, windows: all, terminate: deny }  # terminate: deny|driver_launched|any
  desktop:
    applications: [1234]               # pids
    windows: [{ pid: 1234, window_id: 5678 }]
    display: false
  browser:
    profiles: [{ kind: isolated }]      # v2+: isolated | isolated_new | existing_profile
    existing_profiles: [{ pid: 4242, window_id: 991 }]
    origins: ["https://example.com"]   # exact canonical origins; if non-empty, allow may NOT include
                                       # page/click/type_text/press_key/hotkey/set_value/scroll/drag/
                                       # get_window_state/verify_state/get_desktop_state/... (bypass tools)
  files:
    read:  ["/abs/file", { dir: "/abs/dir", recursive: true }]
    write: [...]
  processes: { terminate: [1234] }
  driver_configuration: { changes: [{ key: <config key>, value: <json> }] }
  computer_history: { operations: [status, query] }    # v3 only
```

**Resource matching.**
- `authorize_call` checks the tool decision (deny, then allow; anything undeclared is denied in bounded mode).
- It then checks adapter-attested resources against the manifest: an exact `(pid, window_id)` window, a pid, an app identity, a canonical origin, an exact path or a directory root.
- An allow entry for a tool never implies access to undeclared resources.

**Expiry.** `expires_after` becomes an absolute deadline at load time. `idle_timeout` is measured from the last authorized dispatch.

**Revocation.**
- `cua-driver revoke --session <id>` or `revoke --all` sends `revoke_authorization` over the socket. It is deny-only and needs no token.
- `stop` shuts the daemon down.
- The mode and manifest cannot be widened at runtime; changing them requires restarting the daemon.

**Implications for Billy.**
- The manifest mixes pids and window IDs, which are ephemeral, with stable identities (`bundle_id`, origin). Window-scoped grants therefore need a daemon restart per task, unless Billy uses `apps:` grants.
- Plan for Billy's own broker policy to be the primary gate, with the Cua manifest as defense in depth (bounded mode plus a per-task generated manifest).

Classification: SOURCE. Enforcement is UNVERIFIED at runtime.

## 4. Input schemas for the requested tools: CLI-OBSERVED (`describe`)

The full verbatim schemas are in `upstream/cua-driver-0.26.1-tools.json`. All schemas below have `additionalProperties:false` except the browser and session tools, which use `additionalProperties:true`. Common optional fields:
- `session` (string label).
- `target`: `{kind:"window",pid,window_id}` or `{kind:"desktop",display_id:"primary"}`. Do not combine it with the legacy flat `pid`/`window_id`/`scope`.
- `delivery_mode` (`background` default | `foreground`).
- `element_token`, or `element_index` + `snapshot_id`.
- `x`, `y` in window-local screenshot pixels.

| Tool | Required | Other properties |
|---|---|---|
| get_window_state | pid, window_id | include_screenshot (default true), include_accessibility_tree, max_depth, max_elements, max_dimension, query, screenshot_out_file, session, capture_mode (deprecated/ignored: ax/vision) |
| click | — | element_token \| element_index+snapshot_id \| x,y; pid, window_id, target(oneOf), scope(window/desktop), button(left/right/middle), count, action(press/show_menu/pick/confirm/cancel/open), modifier[], delivery_mode, from_zoom, debug_image_out, session |
| type_text | text | element_token/element_index+snapshot_id/x,y, pid, window_id, target, scope, delay_ms, delivery_mode, session |
| set_value | pid, value | element_token/element_index+snapshot_id, window_id, session |
| press_key | key | modifiers[], element_*, pid, window_id, target, scope, x, y, delivery_mode, session |
| hotkey | keys[] | element_*, pid, window_id, target, scope, x, y, delivery_mode, session |
| scroll | direction(up/down/left/right) | amount, by(line/page), element_*, pid, window_id, target, scope, x, y, delivery_mode, session |
| list_windows | — | pid, on_screen_only |
| launch_app | — (bundle_id or name) | urls[], additional_arguments[], creates_new_application_instance, webkit_inspector_port |
| verify_state | pid, window_id, expect[1..8] | each item: `{window?:{exists?, bounds?{x,y,width,height,tolerance_px<=100}}, element?:{selector{role?,label_contains?}, exists:true only, enabled?, selected?, value_equals?}}`; stable_samples, timeout_ms, include_screenshot, session |
| invoke_menu | pid, window_id, path[1..16] (strings ≤200) | session |
| get_screen_size | — | session |
| health_report | — | include[], skip[] |
| browser_prepare | — | pid, window_id, allow_launch, profile{mode: isolated_new\|isolated_named, name?}, strategy{kind: existing_profile}, session |
| browser_navigate | target_id, tab_id, url | session (http/https/about only) |
| browser_click | target_id, tab_id | ref \| x,y; input_route(trusted/dom_event); session |
| browser_type | target_id, tab_id, ref, text | mode(insert_text/keystrokes), replace, session |
| get_browser_state | — | pid+window_id (bind) or target_id+tab_id (snapshot); snapshot_format(dom_refs_v1/semantic_v2), query, scope_ref, continuation, include_screenshot, session |
| start_session | — | session, cursor_theme(object\|null), capture_scope (deprecated) |
| end_session | — | session |

Action result shape (SOURCE, `docs/action-result-contract.md`): `structuredContent = {effect: confirmed|partial|unverifiable|suspected_noop|refused, route, delivery{mode}, evidence[], escalation?{target,reason}}`. Postconditions belong in `verify_state`, which returns `satisfied`, `unsatisfied` or `unknown`; `unknown` never means success.

## 5. Element addressing and staleness: SOURCE

- Yes, addressing is bound to a snapshot. `get_window_state` registers a snapshot and returns per-element `element_index` plus an opaque **`element_token` = `s{8-hex snapshot_id}:{element_index}`**, and a `snapshot_id`. Source: `cua-driver-core/src/element_token.rs`.
- Validity:
  - Only the **newest snapshot per `(pid, window_id)`** is valid.
  - An LRU keeps up to 8 snapshots per pid, scoped per runtime generation.
  - A bare `element_index` without `snapshot_id` is refused (`snapshot_id_required`).
  - A token combined with other fields must agree on snapshot, window and element, or the call fails closed.
- Stale handling:
  - Refusal codes are `stale_element_token` ("element_token is stale; call get_window_state again to refresh"), `generation_mismatch` (daemon restarted) and `invalid_element_token`.
  - There is **never a silent fallback** to the integer index. These come back as `isError` results with `structuredContent.status:"refused"`.
- The window is also checked: `window_id_not_found`, `window_owner_pid_mismatch` (which names the real owner_pid), and `degraded_reason: ax_window_unresolved` (empty tree, screenshot only).
- Because snapshot state is held by the daemon, it persists across separate socket connections and `call` processes. It is lost on daemon restart, which surfaces as `generation_mismatch`.
- The browser path uses separate session-scoped `target_id`/`tab_id`/`ref` capabilities from `get_browser_state`. Remembered refs are invalid after re-snapshot.

Classification: SOURCE; UNVERIFIED at runtime.

## 6. Focus, background delivery, agent cursor: SOURCE

- **Default is background, targeted by pid, with no focus steal.** Source: `Skills/cua-driver/MACOS.md`, "The no-foreground contract" and "delivery_mode".
  - AX element actions (`element_token`/`element_index`) work on backgrounded, minimized, hidden or off-Space windows.
  - Pixel actions are posted per-pid through SkyLight (`SLEventPostToPid`, a private API) without raising the window or warping the real cursor.
  - Pixel actions still need a visible on-screen window to anchor the coordinate conversion.
- `delivery_mode:"foreground"` briefly brings the app to the front, acts, then restores the previously frontmost app.
  - It is **required for modified clicks** (Cmd/Shift-click); background plus modifier is refused.
  - It needs `window_id`.
- `target:{kind:"desktop"}` uses screen coordinates with foreground delivery.
- There is no background path for OpenGL, Metal, Qt or game viewports. They need a frontmost HID-tap path, which visibly moves the real cursor.
- `launch_app` launches in the background and attempts to suppress self-activation (`self_activation_suppressed`).
- `type_text` uses `AXSetAttribute(kAXSelectedText)`. For Chromium/Electron it falls back to synthesized CGEvent characters. For web content it reports `effect:"unverifiable"` rather than a false confirmation.
- **Agent cursor**: an overlay drawn by the daemon (`serve` only), **on by default**, one per session.
  - It shows where the agent acts without moving the real pointer, and is removed when the session ends.
  - It can be disabled for the daemon with `serve --no-overlay`. `--cursor-theme` and `--cursor-reduced-motion` tune it.
  - It is not available with `mcp --direct` or the in-process SDK unless a UI adapter is installed.
  - Source: `--help`, `main.rs` Serve arm.

Classification: SOURCE/CLI-OBSERVED (help text); all behavior UNVERIFIED.

## 7. Browser automation: SOURCE (`Skills/cua-driver/BROWSER.md`, `browser_prepare` description)

- **Engine**: Chromium family through **CDP**, on a DevTools endpoint owned by the driver and bound to a loopback port.
  - Typed mutation works on macOS Chrome and Edge (and Chromium when an explicit pid is given).
  - Safari and Firefox get native-window state only; typed page mutation is not supported.
  - WebKit/Tauri apps can use `launch_app.webkit_inspector_port`.
  - On macOS, a "trusted" standalone `browser_click` is refused to keep background posture; use `input_route:"dom_event"`.
- **Profile**:
  - The **isolated, driver-owned profile is preferred**: `browser_prepare {allow_launch:true, profile:{mode:"isolated_new"|"isolated_named",name}}`.
    - Without a pid, it uses only a vendor-signed system Google Chrome, then Microsoft Edge.
    - It launches a separate browser and never copies, modifies or terminates the user's profile.
    - It returns `prepared_pid`.
  - Attaching to an existing logged-in profile needs explicit trusted launch authorization: `--grant existing-profile` in standard mode, a manifest `existing_profiles`/`profiles:[{kind: existing_profile}]` entry in bounded mode, or unrestricted mode.
    - It may toggle Chrome's per-instance remote-debugging checkbox in a temporary tab.
    - The docs warn that CDP gives broad authority over cookies and storage, and that loopback does not protect against other processes running as the same user.
- `get_browser_state` is strictly read-only. It returns `browser_requires_setup` / `browser_consent_required` rather than acting.
- **For Billy**: use only an isolated named profile. Never use `--grant existing-profile`.

Classification: SOURCE; UNVERIFIED.

## 8. TCC attribution: SOURCE (`EMBEDDING.md`, `responsibility.rs`, `bundle.rs`, `cli.rs`)

- TCC attributes Accessibility and Screen Recording to the **responsible process** in the launch chain, not to the executable path.
- **Standalone design.** The daemon is meant to be launched through LaunchServices (`open -n -g -a CuaDriver --args serve`, as `mcp` auto-launch and `permissions grant` do). TCC is then attributed to **`com.trycua.driver`**, and the grants belong to CuaDriver.app.
  - `permissions status` intentionally answers only through a running daemon. With no daemon it reports `unknown` (CLI-OBSERVED).
- **Socket clients do not need TCC.** `call`, raw-socket and MCP-proxy clients are not TCC-checked; the daemon is.
  - If Billy calls a LaunchServices-launched daemon over the socket, either as a child `call` process or over raw NDJSON, Billy needs **no** Accessibility or Screen Recording grant of its own.
  - The trust boundary then becomes "any same-UID process can use CuaDriver's grants" (§2.1).
- **If Billy spawns `cua-driver serve` itself as a child process (`posix_spawn`/`Process`):**
  - The binary resolves inside `CuaDriver.app/Contents/MacOS/`, so `reexec_disclaimed_if_needed` **skips** the responsibility disclaim (`should_skip_disclaim(... inside_bundle=true)`).
  - The daemon therefore stays in **Billy's** responsibility chain. TCC checks and prompts would be attributed to Billy, or to Terminal or whatever launched Billy, **not** to com.trycua.driver.
  - Inference: grants given to CuaDriver.app would not apply. This is UNVERIFIED and must be runtime-checked with `log stream --predicate 'subsystem == "com.apple.TCC"'`.
  - A copy *outside* the bundle would disclaim and become its own responsible process.
- `mcp --direct`, the in-process SDK (`CuaDriver.create`) and embedded mode (`CUA_DRIVER_EMBEDDED=1 ... serve --embedded --socket p`) all **deliberately** attribute TCC to the host. That is the right model if Billy becomes a signed .app that owns the grants. Embedded mode never auto-launches CuaDriver.app.
- **Recommended options for Billy**:
  - (a) Short term: launch a private daemon through LaunchServices so CuaDriver.app's grants apply. Example: `open -n -g -a CuaDriver --env ... --args serve --socket <billy-private-path> --permission-mode bounded --capability-manifest <f> --approve-capability-manifest --no-overlay?`. Then talk NDJSON to it.
  - (b) Long term: a signed Billy.app embedding the driver with `--embedded`.

Classification: SOURCE plus inference; UNVERIFIED.

## 9. Telemetry: SOURCE (`cua-driver/src/telemetry.rs`), CLI-OBSERVED status

- **On by default.** Precedence is env override, then persisted `~/.cua-driver/config.json` `telemetry_enabled`, then default `true`.
  - Events go to PostHog EU (`https://eu.i.posthog.com/capture/`) with a hard-coded project key.
  - The installation ID is stored in `~/.cua-driver/.telemetry_id`.
- The module doc says events are content-free: fixed event names and bounded properties only, with no prompts, arguments, typed text, screenshots, AX trees, app or window names, URLs or paths.
- Every finite CLI command is **re-executed as a wrapped child** so a completion event (command, tool name, exit code, duration) can be emitted (`main.rs::maybe_wrap_finite_command`). `serve` emits lifecycle, permission-gate and per-tool-completion events, rate-limited to 1000 per hour.
- **Disabling without touching global config**:
  - Set env `CUA_DRIVER_RS_TELEMETRY_ENABLED=0`; `CUA_TELEMETRY_ENABLED=0` is the compat alias. Accepted values are `0|false|no|off`.
  - With it set, `spawn_first_run_registration_worker` and `spawn_cli_completion_worker` return early (CLI-OBSERVED: `telemetry status` reports `enabled:false, source:"environment"`).
  - `CUA_DRIVER_TELEMETRY_HOME=<dir>` can additionally redirect telemetry state files.
  - Also set `CUA_DRIVER_RS_UPDATE_CHECK=false` to stop the GitHub update check that `serve`/`mcp` run at startup (`version_check.rs`).
- **Caveat: a LaunchServices-launched daemon (`open -a`) does not inherit the caller's environment.**
  - A daemon auto-launched by `mcp` will run with telemetry **on** unless the persisted config disables it.
  - If Billy launches the daemon itself, it must pass `open --env CUA_DRIVER_RS_TELEMETRY_ENABLED=0 --env CUA_DRIVER_RS_UPDATE_CHECK=false ...`. Source-inferred and UNVERIFIED.
  - The alternative is the global `cua-driver telemetry disable`, which is a user decision and was not run here.
- Install-time registration has already been sent (`registration_recorded:true`).

## 10. Capability classification summary

| Capability | Status |
|---|---|
| Version, signature, entitlements, hashes | CLI-OBSERVED |
| Tool list (56) and input schemas | CLI-OBSERVED |
| Telemetry env opt-out on CLI process | CLI-OBSERVED |
| Daemon not running, TCC unknown | CLI-OBSERVED |
| Socket path, NDJSON protocol, same-UID auth, `call` semantics and output | SOURCE, UNVERIFIED |
| `call` exits 0 on tool-level `isError` | SOURCE-inferred, UNVERIFIED |
| Permission modes, manifest format, expiry, revocation | SOURCE, UNVERIFIED |
| Element token/snapshot binding and stale refusal | SOURCE, UNVERIFIED |
| Background pid-targeted input, no focus steal | SOURCE, UNVERIFIED |
| Agent cursor overlay | SOURCE, UNVERIFIED |
| Browser CDP with isolated profile | SOURCE, UNVERIFIED |
| TCC attribution, LaunchServices vs child spawn | SOURCE + inference, UNVERIFIED |
| Telemetry off in a LaunchServices daemon via `open --env` | inference, UNVERIFIED |
| click / type_text / set_value / press_key / hotkey / scroll / launch_app / invoke_menu / verify_state / browser_* actually work on this Mac | UNVERIFIED (not exercised) |

## 11. Open items

- **O-1** Generate a third-party license inventory for the Rust graph at `cc54254`, for example with `cargo about`, if Billy ever redistributes the binary.
- **O-2** Decide whether to upgrade before building on this. 0.34.1 is available, and the 0.26.1 surface may differ; re-run this audit on the chosen version.
- **O-3** Runtime-prove the TCC attribution of a private daemon launched through LaunchServices vs. one spawned as a child, after the user grants permissions with `cua-driver permissions grant` (user action).
- **O-4** Runtime-prove the `call` exit-code behavior on a refusal, and the NDJSON round-trip, against a private-socket daemon.
- **O-5** Decide on the global telemetry setting (user decision), or always launch the daemon with `open --env`.
- **O-6** Billy's broker must treat the same-UID socket as untrusted shared authority: use a private socket directory (0700), `bounded` mode with a per-task manifest, and `revoke --all` / `stop` on task end.
