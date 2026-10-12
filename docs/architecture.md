# Billy architecture (as implemented)

Scope: what the code at `core/src/**`, `native/**` and `tools/package.sh` does today. Intent lives in `BILLY_MASTER_HANDOFF.md` §6. Decisions live in `docs/adr/` (0001–0004).

Related documents (not repeated here):
- Contracts, state machines and the broker sequence: [contracts-and-state-machines.md](contracts-and-state-machines.md)
- Grants, budgets, retries and coexistence: [autonomy-and-policy.md](autonomy-and-policy.md)
- Tests and the release gate: [testing-and-release.md](testing-and-release.md)
- Threats: [threat-and-failure-register.md](threat-and-failure-register.md)
- Operations: [operator-runbook.md](operator-runbook.md), [developer-runbook.md](developer-runbook.md), [remote-access.md](remote-access.md)

Live status: native desktop control, the real model provider and the real phone path are **implemented; live qualification pending (setup packet S1–S5)**. See [SETUP_PACKET.md](SETUP_PACKET.md).

## 1. Component map

```text
Owner interfaces
  Billy.app (SwiftUI)        native/Sources/Billy, BillyKit/BillyClient.swift  ── HTTP/1.1 over run/billyd.sock
  billyctl                   core/src/cli/billyctl.ts                          ── same socket + bearer token
  Push-to-talk voice         native/Sources/BillyKit/Voice.swift               ── POST /v1/tasks source=voice
  Telegram (phone)           core/src/remote/telegram.ts  TelegramRemote       ── outbound long-poll
  Owner schedules            core/src/scheduler/schedules.ts  Schedules.tick
        │
Command admission + durable inbox
  LocalApi (auth)            core/src/daemon/api.ts  LocalApi.authorized
  admitOwnerCommand          core/src/daemon/routes.ts  admitOwnerCommand
  Inbox.admit                core/src/inbox/inbox.ts  (dedup key = source + source_message_id)
  Tasks / Control            core/src/tasks/tasks.ts, core/src/tasks/control.ts (stop/pause/cancel/revise)
        │
Scheduler / executor / planners
  Executor                   core/src/scheduler/executor.ts  tick, admitNew, wake, step, handleVerdict, complete
  ModelPlanner               core/src/planner/model.ts  →  ModelGateway (core/src/ai/gateway.ts) → AnthropicDriver
  scriptedPlanner            core/src/planner/scripted.ts
  WorkerManager              core/src/agents/workers.ts (child tasks, driver='worker')
        │
Action broker (single admitted-effect boundary)
  Broker.submit              core/src/broker/broker.ts
  decide / PolicyStore       core/src/policy/policy.ts
  Budget                     core/src/budget/budget.ts
  Claims                     core/src/scheduler/claims.ts
        │
Tools / adapters             core/src/tools/*.ts (registered in core.ts and daemon/main.ts)
  fs.* · api.send_message · proc.run / code.integrate (Seatbelt: core/src/sandbox/seatbelt.ts)
  app.launch / desktop.observe / desktop.act (Cua: core/src/desktop/cua.ts, arbiter: desktop/session.ts)
  agent.delegate / agent.collect · memory.search / memory.note · web.fetch
        │
Verification and reconciliation
  per-adapter verify/reconcile (ToolAdapter, core/src/broker/types.ts)
  Broker.reconcileAttempt / Broker.recover; Core.recover (core/src/core.ts)
  task level: CriteriaVerifier (core/src/verify/taskVerifier.ts), FrozenCriteriaVerifier (core/src/verify/frozen.ts)
        │
Journal, evidence and outbox
  Store (SQLite, single writer)   core/src/store/db.ts  transitionTask, transitionAttempt, event
  Outbox                          core/src/notify/outbox.ts  (fed by Core.notify)
  Retention (evidence files)      core/src/memory/retention.ts
  Backups                         core/src/store/backup.ts  BackupManager
```

`Core` (`core/src/core.ts`) is the composition root. The daemon, tests and CLI all build the same graph, so there is one broker path. `startDaemon` (`core/src/daemon/main.ts`) adds the extra tools, the gateway, the arbiter, workers, Telegram, schedules, backups and the HTTP routes.

## 2. Process model

| Process | Started by | Code | Talks to |
|---|---|---|---|
| `billyd` (core daemon, Node) | launchd LaunchAgent `com.billy.core`, registered by Billy.app through `SMAppService.agent` (`native/Sources/BillyKit/ServiceController.swift`). Plist: `native/Resources/com.billy.core.plist` (`RunAtLoad`, `KeepAlive`, `ThrottleInterval 10`, `ProcessType Background`). | `native/Resources/billyd` (sh) runs `Contents/Resources/node/bin/node core/src/daemon/main.ts` | Owns `billy.db`. Listens on `run/billyd.sock` and `run/workers.sock`. Spawns workers, sandboxed processes and the Cua daemon. |
| Billy.app (SwiftUI menu-bar and window app) | The owner | `native/Sources/Billy/*`, `native/Sources/BillyKit/*` | A client only: `UnixSocketTransport` → `run/billyd.sock` with the bearer token in `run/api.token`. It never sends `Origin`. |
| Worker processes (one per running child task) | `WorkerManager.spawnWorker` (`core/src/agents/workers.ts`): detached, with a clean env (only `PATH`, socket, id, token and heartbeat) | `core/src/agents/worker-main.ts` | `run/workers.sock` only (`/w/heartbeat`, `/w/step`). No DB, no secrets, no tools (ADR-0004). |
| Sandboxed `proc.run` / `code.integrate` children | `runSandboxed` (`core/src/sandbox/seatbelt.ts`) via `/usr/bin/sandbox-exec -f <profile>`, with its own process group | `PROFILE` in `seatbelt.ts`, allowlist `allowedExecutables` (`core/src/tools/proc.ts`) | Nothing. The profile denies network and unix sockets, the Keychain and Apple Events. Reads and writes are limited to the workspace plus a private tmp. |
| Private Cua daemon | `launchPrivateDaemon` (`core/src/desktop/cua.ts`) via `open -n -g -a CuaDriver.app --args serve --socket run/cua.sock --permission-mode bounded --capability-manifest run/cua-manifest.yaml`. It starts lazily on the first desktop tool use (`DesktopServices.transport`, `daemon/main.ts`) and is stopped with `shutdown` on daemon stop (`stopPrivateDaemon`). | Pinned CuaDriver 0.26.1 (`verifyPin`: binary sha256 + team ID) | Called only by desktop adapters through `SocketTransport`. Implemented; live qualification pending (S3). |

A resident Swift helper, `billy-session --watch`, supplies OS session facts every 100 ms through stdout. Missing, invalid or stale samples block input, and the arbiter retains only the latest 100 takeover events. The helper replaces four synchronous subprocesses per poll.

Inside `billyd`, the executor loop (`Executor.start(250)`, concurrency 2) and the worker supervisor (`WorkerManager.start(250)`) run on timers. Other timers handle outbox delivery (2 s), cancellation finalization and the session wake (2 s), the provider wake (30 s), schedules (10 s) and the retention sweep (15 min) (`daemon/main.ts` `timers`). Exit codes are 75 (instance lock held), 70 (corruption / recovery required) and 1 (other). `SIGTERM` and `SIGINT` run `Daemon.stop`.

## 3. Single-ownership table

| Concern | Single owner | Notes |
|---|---|---|
| Task readiness / admission | `Executor.admitNew`, `Executor.tick`, `Executor.wake` (`scheduler/executor.ts`) | `WorkerManager.supervise` starts processes for READY `driver='worker'` tasks but calls `executor.admitNew` for readiness. |
| Action retry decision | `Executor.handleVerdict` + `LIMITS` (`scheduler/executor.ts`) | The broker never retries (`broker.ts` header). SDK retries are off (`AnthropicDriver`, `maxRetries: 0`). The gateway only sets provider backoff (`ModelGateway.retryAt`). |
| Child-run lifecycle | `WorkerManager` (lease, fence, kill, replace) | The parent result is gated by `Executor.complete` (pending or failed children). |
| Effect admission | `Broker.submit` | It is the only caller of `ToolAdapter.dispatch`. |
| Authorization | `decide` + `PolicyStore` (`policy/policy.ts`) | Grant writers: `PUT /v1/policy` (`daemon/routes.ts`) and `WorkerManager.delegate` (intersection only). |
| Budget ledger | `Budget` (`budget/budget.ts`) | Ceilings are written only by `PUT /v1/budget`. |
| Notification delivery | `Outbox` (`notify/outbox.ts`) | Delivery never re-runs a task. |
| Interactive desktop input | Exclusive claim `desktop:billy` (`desktopAct.resolve`) + `DesktopArbiter` + one private Cua daemon | — |
| Store writes | One `Store` connection per process, guarded by an exclusive `instance.lock` (`Store.open`) | All transitions go through `Store.transitionTask` / `transitionAttempt`, which check `domain/machines.ts`. |
| Release gate | `evaluate()` (`release/evaluator/evaluate.ts`) | `tools/qualify.ts` only produces inputs. |

Store table ownership. Writers other than the owner are listed explicitly.

| Table (migration) | Owner module | Other writers |
|---|---|---|
| `meta` (v1) | `Store.ensureSingletons` | `TelegramRemote.saveOffset` (`telegram_offset`) |
| `stop_latch` (v1) | `Control.stopAll` / `clearStop` | — |
| `grants` (v1) | `PolicyStore.putGrant` / `revoke` | — |
| `tasks` (v1, `driver` v2) | `Tasks.create` / `revise` | Status changes: `Executor`, `Control`, `WorkerManager.supervise`, `Core.recover`, all via `Store.transitionTask`. `WorkerManager.delegate` sets `driver`. |
| `task_revisions`, `task_edges` (v1) | `Tasks` | — |
| `attempts` (v1) | `Broker` | `Executor.step` cancels never-dispatched PREPARED attempts. |
| `events` (v1) | `Store.event` (append-only, all modules) | — |
| `inbox` (v1) | `Inbox.admit` | — |
| `outbox` (v1) | `Outbox` | — |
| `resource_claims`, `resource_generations`, `resource_waiters` (v1) | `Claims` | — |
| `workers` (v1, token/pgid v2) | `WorkerManager` | `Control.cancel` (FENCED), `Core.recover` (LOST) |
| `budgets`, `budget_entries` (v1) | `Budget` | — |
| `evidence` (v1) | `Retention` | — |
| `memory`, `memory_fts`, `memory_tombstones` (v1) | `Memory` (`memory/memory.ts`) | — |
| `devices`, `pairing_challenges` (v1) | `TelegramRemote` | — |
| `plans`, `step_failures` (v1) | `Executor` | — |
| `processes` (v1) | the `proc.run` adapter (`tools/proc.ts`) | — |
| `child_links` (v2) | `WorkerManager.delegate` | — |
| `schedules` (v3) | `Schedules` | — |
| `schema_migrations` | `Store.migrate` | — |

## 4. Data locations

Runtime data lives in `~/Library/Application Support/Billy` (`defaultDataDir`, `core/src/store/db.ts`). The directory is 0700 and files are 0600 (`process.umask(0o077)` in `startDaemon`). `assertSafeLocation` refuses `/Volumes/*`, iCloud, `~/Library/CloudStorage`, Dropbox and Google Drive.

| Path (under the data dir unless absolute) | Content | Code |
|---|---|---|
| `billy.db`, `-wal`, `-shm` | Authoritative store (WAL, `synchronous=FULL`, FK on, `quick_check` gate at open) | `Store.open` |
| `instance.lock` | Single-instance lock (SQLite `locking_mode=EXCLUSIVE`) | `Store.open` |
| `config.json` | Non-secret owner config (`BillyConfig`) | `daemon/config.ts` |
| `run/billyd.sock`, `run/api.token` | Owner API socket (0600) and bearer token (0600) | `LocalApi`, `ensureToken` |
| `run/workers.sock` | Worker lease API | `WorkerManager.listen` |
| `run/cua.sock`, `run/cua-manifest.yaml` | Private Cua daemon socket and bounded capability manifest | `launchPrivateDaemon`, `manifestYaml` |
| `backups/<id>.billybak`, `backups/<id>.manifest.json` | AES-256-GCM encrypted SQLite backups. The key is in the Keychain service `com.billy.backup-key`. | `BackupManager` |
| `evidence/` | Billy-owned evidence files tracked in the `evidence` table | `Retention` |
| `quarantine/<ts>-<rand>/`, `RECOVERY_REQUIRED.json` | Byte-preserved corrupt DB files and an incident record. The marker blocks `Store.open`. | `openOrQuarantine`, `restoreLatestVerified` |
| `restore-log.jsonl` | Restore audit | `BackupManager.restore` |
| `~/Library/Logs/Billy/billyd.{out,err}.log` | launchd stdout/stderr | `com.billy.core.plist` |
| `$TMPDIR/billy-sandbox/<sha256>.sb`, `$TMPDIR/billy-run-*` | Read-only sandbox profile; per-run temp dir, removed on exit | `profileFile`, `runSandboxed` |
| Keychain `com.billy.provider.anthropic`/`default`, `com.billy.remote.telegram`/`bot` | Provider and bot credentials, read by reference only | `KNOWN_REFS` (`core/src/secrets/keychain.ts`) |

## 5. Trust boundaries (summary)

The authoritative analysis is [threat-and-failure-register.md](threat-and-failure-register.md). Its §1 boundary table was written at commit `4f19bfa` and still marks B2–B7 as PLANNED. The rows below are their current implementation state.

| Boundary | Mechanism in code | Residual |
|---|---|---|
| B1 owner ↔ Billy.app | Same-user UI | — |
| B2 phone → billyd | `TelegramRemote.handle`: numeric sender ID of a paired device; private chats only; forwarded, bot and group messages rejected; inbox dedup | Transits Telegram servers. Implemented; live qualification pending (S4). |
| B3 app/CLI ↔ billyd | Unix socket 0600 in a 0700 dir, constant-time bearer token, requests with `Origin`/`Sec-Fetch-Site` rejected, no TCP listener (`LocalApi`) | Any same-uid process that can read `run/api.token` |
| B4 billyd → Cua | Pinned binary, private socket, bounded manifest, telemetry off (`cua.ts`) | The socket is same-uid with no token (ADR-0002 §5). Implemented; live qualification pending (S3). |
| B5 billyd → model provider | `ModelGateway.complete`: stop latch, `model_egress`, priced model, budget reservation; audit events record only a request digest | Implemented; live qualification pending (S1, S2). |
| B6 billyd → Keychain | `Keychain.get` by named reference; value registered with the redactor | — |
| B7 untrusted code → host | Seatbelt `PROFILE`; worker processes are not a hostile-code boundary (ADR-0004) | Shares the uid and kernel; no CPU/memory quotas. |

## 6. Bundle deployment

`tools/package.sh` builds from `git archive HEAD` (it refuses a dirty tree unless `--allow-dirty` is passed). It verifies the vendored Node v26.8.2 tarball against `SHASUMS256.txt` and the signer team `HX7739G8FX`. It runs `npm ci --omit=dev --ignore-scripts`, deletes `core/test`, writes the notices and SBOM, and then calls `native/scripts/build-app.sh --core --node`. Layout produced by `build-app.sh`:

```text
Billy.app/Contents/
  MacOS/Billy                                   SwiftUI app (swift build -c release)
  Info.plist, PkgInfo
  Library/LaunchAgents/com.billy.core.plist     portable; launcher resolves logs from runtime HOME
  Resources/billyd/billyd                       launcher → node core/src/daemon/main.ts
  Resources/billyd/billyctl                     launcher → node core/src/cli/billyctl.ts
  Resources/node/bin/node                       official signed Node runtime (unmodified)
  Resources/core/                               core sources + production node_modules (no tests)
  Resources/AppIcon.icns
  Resources/bin/billy-session                   resident, read-only OS session facts
```

The app is ad-hoc signed with the hardened runtime (`codesign --options runtime -s -`); it is not notarized. `package.sh` produces `Billy-<v>.zip`, `Billy-<v>.dmg`, `sbom.json`, `THIRD_PARTY_NOTICES.txt`, `build-manifest.json` and `SHA256SUMS` under `artifacts/release/<v>/`. At runtime, `startDaemon` derives the sandbox `RUNTIME_DIR` from the real path of `process.execPath` (`Contents/Resources/node`).
