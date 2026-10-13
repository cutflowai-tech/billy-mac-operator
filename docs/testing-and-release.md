# Testing and release gate (as implemented)

This document covers how evidence is produced, labelled and judged, and what currently blocks `RELEASE_READY`. The requirement and scenario set is frozen in `release/requirements.manifest.json` (36 requirements, 104 mandatory scenarios). Its approved digest is `release/requirements.manifest.sha256` (`eed9a89c…7cda`). Build and vendor steps are in [developer-runbook.md](developer-runbook.md). Component context is in [architecture.md](architecture.md).

## 1. Evidence lanes and how `tools/qualify.ts` assigns them

The lanes are UNIT, CONTRACT, INTEGRATION, NATIVE_LIVE, PROVIDER_LIVE, REMOTE_LIVE, FAULT, SECURITY and PACKAGE (handoff §19.1). `qualify.ts` assigns a lane from the suite that produced the test case, never from a claim:

| Suite (`SUITES`) | Command run by qualify | Lane |
|---|---|---|
| `core-unit` | `node --test … test/unit/*.test.ts` (cwd `core`) | UNIT |
| `core-integration` | `test/integration/*.test.ts` | INTEGRATION |
| `core-security` | `test/security/*.test.ts` | SECURITY |
| `core-fault` | `test/fault/*.test.ts` with `BILLY_FAULT_INJECTIONS=10` | FAULT |
| `evaluator` | `release/evaluator/*.test.ts` (cwd repo root) | CONTRACT |
| `build-continuation` | `python3 -I tests/boot/test_build_continuation.py` | FAULT (cases are named `T-BOOT-02 T-BOOT-06 <test_name>`) |

Mapping rules (`tools/qualify.ts`):
- A test case covers scenario `T-X-NN` when its TAP name contains that ID as a whole word.
- **Contract tag:** a case whose name contains `(contract)` is lane CONTRACT, whatever its suite (`laneOf`).
- **Partial tags:** `(core part)`, `(process part)`, `(contract part)` and `(part)` mark partial coverage (`partial`). Partial cases never make a scenario PASS. If every matching case is partial, the result is `PARTIAL`, which the evaluator rejects.
- If any matching case fails, the scenario is `FAIL`. With no matching case it is `NOT_RUN`, with a blocker note: "live prerequisite not available (setup packet)" for live lanes, otherwise "no automated test yet".
- A passing scenario takes the manifest's lane when a full case has that lane, otherwise the lane of its first full case. A live scenario reaches its live lane only through the live suites (`native-live`, `provider-live`, `remote-live`, which run `core/test/live/*.test.ts`); a passing case from any other suite shows as `PASS(<lane>) — wrong lane` in `matrix.json`, and the evaluator fails it.
- If every matching case is skipped (e.g. a live prerequisite is missing), the scenario is `NOT_RUN` with the skip reason as its blocker; a skip is never a pass.
- `SUITES` also runs the Swift tests (`native/.build/debug/BillyTests`) and the PACKAGE suite against `--artifact`.

Lane placement (2026-10-12). The first candidate qualification showed scenarios whose tests sat in a suite of the wrong kind. Following the handoff's lane definitions (§19.1), these tests were moved without changing any assertion:
- To SECURITY ("adversarial authority, input, isolation, privacy"): T-ACTION-05, T-ACTION-06 and T-SEC-04 (`security/broker-adversarial`); T-SEC-10 (`security/update-tamper`); T-SEC-12 (`security/egress`); T-MEM-03 and T-MEM-04 (`security/memory-adversarial`); T-SEC-06/T-AGENT-05 and T-AGENT-07 (`security/agents-authority`).
- To FAULT ("injected failures at controlled boundaries"): T-ACTION-09 (`fault/stop-during-dispatch`), T-AI-05 (`fault/network-loss`) and T-MEM-06 (`fault/retention-pressure`).
- The over-conservative "(contract)" tags on T-SEC-12, T-REMOTE-07 and T-AGENT-04 were removed. Those tests exercise Billy's own policy and components with a fake external service, which the handoff restricts only for the live lanes.
- T-REL-09 now has PACKAGE evidence: the installed app's sealed commit must be covered by an independent review record.
- T-AGENT-01 records `concurrent_workers` (peak overlapping worker processes), and the provider harness records `meaningful_actions` for T-AI-01, matching the evaluator's gate names.

Run binding (added after the independent audit, 2026-10-12):
- Measurements in `artifacts/measurements/` count only if they carry this run's commit, `dirty_tree: false` and a time after the run started; others are listed in `results.run.ignored_measurements`. Live tests stamp their records (`core/test/live/stamp.ts`).
- The soak's values (minutes, tasks, timestamps, effect counts) are read from its hashed `report.json`, whose artifact digest is taken before unpacking and must equal the candidate's.
- `tools/package.sh` seals `core/build-info.json` (version, commit) inside the signed app; the evaluator fails if the artifact's commit is not the candidate commit.
- The evaluator fails a run with a dirty tree or any reused log (`--skip-run`, `--reuse-live`); those flags remain for local diagnosis only.

Outputs go to `release/results/<commit[0:12]>/`: `<suite>.tap`, `results.json`, `matrix.json` and `evaluation.json`. A dirty tree is recorded (`run.dirty_tree`) and makes the evaluation fail.

## 2. Suite layout and commands

```text
core/test/unit/machines.test.ts          transition tables, 1000+ seeded random sequences → artifacts/seeds/machines.json
core/test/integration/*.test.ts          backup, broker, coding, daemon, desktop (fake Cua socket), foundation, memory,
                                         operations, planner (fake provider), spine, store
core/test/security/*.test.ts             injection, review-findings (F-01..F-21), sandbox (real sandbox-exec), telegram (fake transport)
core/test/fault/*.test.ts                agents (lease loss / fencing), clock, core-boundaries, corruption, crash-boundaries
core/test/package/package.test.ts        installed-artifact checks (T-REL-01/04/06/10, T-UX-04, T-FOUND-06)
core/test/harness/                       broker-proc.ts, core-proc.ts (crashable child processes), receiver.ts (effect counter)
release/evaluator/evaluate.test.ts       evaluator contract tests (T-REL-02, T-REL-03)
tests/boot/test_build_continuation.py    development-runtime continuation (T-BOOT-02, T-BOOT-06)
native/Sources/BillyTests/               self-hosted Swift runner (no XCTest under Command Line Tools)
```

Commands that exist:

```bash
cd core && node --test --test-concurrency=1 'test/**/*.test.ts'      # also: npm test (core/package.json)
node --test release/evaluator/*.test.ts                              # from the repo root
python3 -I tests/boot/test_build_continuation.py
node tools/qualify.ts --artifact <zip> [--skip-run]                 # --skip-run re-maps existing .tap logs
tools/package.sh [--version X.Y.Z] [--allow-dirty]                   # refuses a dirty tree without --allow-dirty
node release/evaluator/evaluate.ts --results <results.json> --candidate-commit <sha> --artifact <zip> [--json]
cd native && swift run BillyTests
```

`BILLY_FAULT_INJECTIONS` sets the injections per fault test (default 10).

Desktop, provider and phone tests in the deterministic suites use a fake Cua socket (`desktopTransportPath`), an injected `ProviderDriver` and a fake `TelegramTransport` (`DaemonOverrides`, `daemon/main.ts`). They are CONTRACT or INTEGRATION evidence, never live evidence.

## 3. Fault-injection boundaries

`fault(point)` (`core/src/util/fault.ts`) SIGKILLs the process on the nth hit of a point named in `BILLY_FAULT_POINTS` (`"<point>[:<nth>]"`). Workers receive `BILLY_WORKER_FAULT_POINTS` (`WorkerManager.spawnWorker`). Without the variable the hook does nothing. The external `receiver.ts` process counts real effects.

| Fault point | Call site | Injected by |
|---|---|---|
| `broker.before_intent_commit` | `broker.ts:253` | `test/fault/crash-boundaries.test.ts` (`api.send_message` and `fs.write`, ×N each) |
| `broker.after_prepared` | `broker.ts:274` | crash-boundaries |
| `broker.after_dispatching` | `broker.ts:304` | crash-boundaries |
| `broker.after_adapter_call` | `broker.ts:312` | crash-boundaries; core-boundaries (first crash of the `reconcile.mid` case) |
| `broker.after_outcome_record` | `broker.ts:321` | crash-boundaries |
| `broker.after_verify` | `broker.ts:338` | crash-boundaries |
| `broker.before_commit` | `broker.ts:349` | crash-boundaries |
| `reconcile.mid` | `broker.ts:386` | `test/fault/core-boundaries.test.ts` |
| `scheduler.after_task_running` | `executor.ts:106` | core-boundaries |
| `outbox.after_sending_mark` | `outbox.ts:56` | core-boundaries (T-DUR-05) |
| `outbox.after_send` | `outbox.ts:65` | core-boundaries (T-DUR-05) |
| `stop.after_latch` | `control.ts:51` | core-boundaries (T-DUR-12) |
| `worker.after_spawn_record` | `workers.ts:103` | core-boundaries (T-DUR-07, T-FOUND-04) |
| `worker.before_result` | `workers.ts:229` | core-boundaries (T-DUR-07, T-FOUND-04) |
| `scheduler.after_claim` | **declared only; never called and never injected** | — |

That makes 14 live boundaries. Each passing injection appends a row to `artifacts/fault/broker-boundaries.jsonl`, and `qualify.ts` derives `T-REL-08.distinct_boundaries` and `min_injections_per_boundary` from that file. The file is appended across runs, but `qualify.ts` counts only rows timestamped after the current run started. Other fault tests do not use fault points:
- `agents.test.ts`: lease loss, fencing, concurrent workers, parent cancel
- `clock.test.ts`: wall-clock jumps
- `corruption.test.ts`: quarantine and restore, failed migration

## 4. Quantitative gates (`manifest.gates`, checked by `evaluate()`)

| Gate | Threshold | Measurement read |
|---|---|---|
| `state_machine_sequences_min` | 1000 | `T-REL-08.event_sequences` (from `artifacts/seeds/machines.json`) |
| `crash_boundaries_min` | 12 | `T-REL-08.distinct_boundaries` |
| `injections_per_boundary_min` | 10 | `T-REL-08.min_injections_per_boundary` |
| `active_soak_minutes_min` | 60 | `T-REL-07` `finished_at − started_at` |
| `active_soak_tasks_min` | 20 | `T-REL-07.tasks` |
| `native_consecutive_runs` | 3 | `T-MAC-01..08.consecutive_passes` |
| `native_distinct_scenarios_min` | 8 | in the manifest only; the evaluator checks the eight fixed IDs T-MAC-01..08 instead |
| `real_autonomy_actions_min` | 10 | `T-AI-01.meaningful_actions` |
| `multi_agent_concurrent_workers_min` | 2 | `T-AGENT-01.concurrent_workers` |
| `local_stop_ack_seconds_max` | 2.0 | `T-ACTION-09.ack_seconds` |
| `human_takeover_suppression_ms_max` | 500 | `T-MAC-09.suppression_ms` |

Other measurements are merged from `artifacts/measurements/*.json` (`{test_id, measurements}`).

## 5. Evaluator rules (`release/evaluator/evaluate.ts`)

`evaluate()` returns `release_ready: true` only when the failure list is empty. The CLI exits 0 only in that case. Checks:

1. The manifest is non-empty, and its sha256 equals the baseline file. A mismatch is a failure.
2. There must be at least one requirement and at least one mandatory test. An empty list never passes.
3. Results must have `schema_version 1`. `candidate.commit`, `candidate.artifact_sha256` and `candidate.requirement_manifest_sha256` must equal the delivered commit, the artifact digest and the manifest digest.
4. Every mandatory test ID needs exactly one result. Unknown IDs and duplicates fail.
5. Per test:
   - `result` must be `PASS`. SKIPPED, BLOCKED, NOT_RUN, EXPECTED_PASS, MOCK_ONLY, UNRESOLVED and anything else fail.
   - The lane must satisfy the required lane (`laneSatisfies`). A live lane accepts only itself. FAULT and SECURITY accept themselves or any live lane. PACKAGE accepts only itself. UNIT, CONTRACT and INTEGRATION accept any lane of equal or higher rank: UNIT 0 < CONTRACT 1 < INTEGRATION = FAULT = SECURITY 2 < PACKAGE 3 < live 4.
   - The candidate binding is checked again per result.
   - `run_id` and ISO-8601 UTC `started_at` ≤ `finished_at` are required.
   - At least one evidence file is required, and each file's sha256 must match its bytes on disk.
   - Live lanes also need an `environment` record.
6. Every requirement needs at least one passing mandatory scenario.
7. The quantitative gates in §4 must hold.
8. No `critical` or `high` finding may be anything but `closed` (from `release/findings.json`). At least one `independent` review record is required (from `release/reviews.json`). Neither file exists in the repository today.
9. A self-reported `complete` or `release_state` field is ignored.

## 6. Current status (honest)

Release label: **not `RELEASE_READY`**. The most recent recorded qualification is `release/results/97b02671c381/`, against commit `97b0267`, not the current HEAD:

| Status | Scenarios |
|---|---|
| `matrix.json` PASS | 47. The evaluator accepted 30 of them and rejected 17 for lane mismatch, e.g. INTEGRATION evidence for a SECURITY or FAULT scenario (T-ACTION-05/06/09, T-DUR-05/12, T-SEC-04/06/10/12, T-AGENT-04/05/07, T-MEM-03/04/06, T-REMOTE-07, T-REL-04). `matrix.json` flags a wrong lane only for live lanes. |
| `PASS(CONTRACT) — wrong lane` on a live scenario (rejected) | 5 (T-MAC-09, T-MAC-10, T-MAC-12, T-REMOTE-03, T-REMOTE-04) |
| PARTIAL (rejected) | 1 (T-ACTION-10) |
| NOT_RUN | 51 |

That run's evaluator recorded 100 unmet items. They included:
- 11 requirements with no passing scenario (REQ-03, 04, 11, 12, 25, 26, 29, 30, 33, 34, 36)
- these gates: crash boundaries, soak duration and tasks, native consecutive runs, real autonomy, concurrent workers, takeover suppression
- no independent review record

The evidence must be regenerated against the packaged candidate before any claim.

### Live scenarios and their blockers (26)

The setup packet ([SETUP_PACKET.md](SETUP_PACKET.md)) items:
- **S1** provider credential
- **S2** spending ceiling
- **S3** TCC Accessibility and Screen Recording for CuaDriver
- **S4** Telegram bot and paired phone
- **S5** microphone and Speech
- **S6** supervised sessions (lock/unlock, permission revoke, mouse takeover, airplane mode)

Per the packet, S3 blocks every NATIVE_LIVE scenario and S4 every REMOTE_LIVE scenario. Goals admitted through any owner surface (app, voice, CLI, Telegram) are always seeded with the model planner (`admitOwnerCommand`, `core/src/daemon/routes.ts`). So a scenario that must run an owner-submitted task to completion also needs S1 and S2. Those dependencies are marked "(exec)".

Status as of 2026-10-12. "Passed (dev)" means the live test passed on this Mac at an earlier commit; it still has to be rerun at the release candidate commit, because `qualify.ts` only counts live logs produced for that commit (`--reuse-live` reuses a log only within the same commit directory).

| # | Scenario | Lane | Harness | Status |
|---|---|---|---|---|
| 1 | T-BOOT-03 Actual environment qualification | NATIVE_LIVE | `test/live/native.test.ts` | passed (dev) |
| 2 | T-FOUND-03 Actual bundled computer provider | NATIVE_LIVE | native | passed (dev), with T-MAC-01 |
| 3 | T-DUR-06 Task survives interface closure | NATIVE_LIVE | not yet automated | needs S8 (installed per-user service) |
| 4 | T-MAC-01 Calculator result verification | NATIVE_LIVE | native | passed (dev) 3/3, OCR-verified display |
| 5 | T-MAC-02 TextEdit content round trip | NATIVE_LIVE | native | passed (dev) 3/3, exact bytes incl. Arabic |
| 6 | T-MAC-03 Finder file operation | NATIVE_LIVE | native | FAILING: Finder's Edit menu (Copy/Paste Item) is only populated when the menu opens, so AX menu resolution cannot reach it in the background |
| 7 | T-MAC-04 Controlled browser form | NATIVE_LIVE | not yet automated | blocked on S7 (driver refuses the user-owned Chrome install) |
| 8 | T-MAC-05 Cross-application focus changes | NATIVE_LIVE | native + fixture app | rewritten 2026-10-12 to cross applications (TextEdit ×2 + fixture, all titled "Report.txt") |
| 9 | T-MAC-06 Scroll and element reacquisition | NATIVE_LIVE | native + fixture app | passed (dev) 3/3 |
| 10 | T-MAC-07 Coordinate mapping on actual displays | NATIVE_LIVE | native | passed (dev) 3/3 (single display, scale 1 only) |
| 11 | T-MAC-08 Native save dialog and Unicode paths | NATIVE_LIVE | native + fixture app | FAILING: folder navigation in the save panel (see "Native control findings"). An earlier probe run left a `consecutive_passes: 1` record; such records no longer count unless written by the qualifying run |
| 12 | T-MAC-09 Owner takeover during input | NATIVE_LIVE | not yet automated | needs S6 (supervised session) |
| 13 | T-MAC-10 Locked/unavailable session waiting | NATIVE_LIVE | not yet automated | needs S6 |
| 14 | T-MAC-11 Native permission revocation | NATIVE_LIVE | not yet automated | needs S6 |
| 15 | T-MAC-12 Provider generation change | NATIVE_LIVE | native | passed (dev) |
| 16 | T-UX-01 Native owner workflow | NATIVE_LIVE | not yet automated | needs S8, S1+S2 |
| 17 | T-UX-05 Accessible direct controls | NATIVE_LIVE | native (packaged Billy.app against a throwaway core) | passed (dev) once; found the toolbar Stop is named "Stop Billy" and status is exposed as text values |
| 18 | T-UX-06 Explicit push-to-talk task | NATIVE_LIVE | not yet automated | needs S5, S1+S2 |
| 19 | T-AI-01 Real autonomous multi-step goal | PROVIDER_LIVE | `test/live/provider.test.ts` | implemented; skips until S1+S2 |
| 20 | T-AI-06 Model context reconstruction | PROVIDER_LIVE | provider | implemented; skips until S1+S2 |
| 21 | T-AI-07 English and Egyptian Arabic intents | PROVIDER_LIVE | provider | implemented; skips until S1+S2 |
| 22 | T-REMOTE-01 Real phone-to-Mac command | REMOTE_LIVE | `test/live/remote.test.ts` (supervised) | implemented; skips until S4+S1+S2 and `BILLY_REMOTE_LIVE=1` |
| 23 | T-REMOTE-02 Actual progress and completion delivery | REMOTE_LIVE | remote | as above |
| 24 | T-REMOTE-03 Reconnect and duplicate submission | REMOTE_LIVE | remote (+ FAULT contract `test/fault/telegram-crash.test.ts`) | as above |
| 25 | T-REMOTE-04 Device/session revocation | REMOTE_LIVE | remote | as above |
| 26 | T-REMOTE-06 Offline stop acknowledgment | REMOTE_LIVE | remote | as above; owner toggles Airplane Mode |

The provider and remote harnesses have only been exercised in their skip path on this Mac (no credentials exist yet), so their assertions are unproven against the real services. Expect a first-run fix-up when S1/S2/S4 land.

Running the live suites:

```bash
node --test --test-timeout=3600000 core/test/live/native.test.ts
BILLY_LIVE_BUDGET_USD=5 node --test --test-timeout=3600000 core/test/live/provider.test.ts
BILLY_REMOTE_LIVE=1 BILLY_LIVE_BUDGET_USD=5 node --test --test-timeout=3600000 core/test/live/remote.test.ts
```

Native runs wait for the owner to be idle (3 s before observing, 5 s before any foreground input), so they take longer while the Mac is in use. T-MAC-06 and T-MAC-08 need the fixture app: `tests/fixtures/BillyFixture/build.sh`.

### Native control findings (2026-10-11/12)

- **Deep audit (2026-10-13).** Findings A-27 to A-54 in `docs/threat-and-failure-register.md`. Two changes affect live runs. Focus-routed input (keys, focused typing, menus) is refused while another window of the same app shows a file panel. Every Finder window is a `file_panel` surface, and the T-MAC-03 grant already includes `file_panel_input`. Neither change was exercised against the real driver (GUI tests deferred).
- **T-REL-09 signing (2026-10-13).** A review approves only when it carries an SSH signature (`tools/sign-review.ts`, namespace `billy-review`) from a principal in the owner's allowed-signers file. The evaluator finds that file through `BILLY_ALLOWED_SIGNERS`, and it must live outside the repository. Reproduction logs now open with their commit, and the evaluator re-derives their counts and scenario IDs.
- **Authorization model changed (2026-10-12).** Input to any file-panel surface now needs `file_panel_input`, so the T-MAC-08 and T-MAC-03 grants include it explicitly (see `docs/autonomy-and-policy.md`, Input-surface authorization).
- **Sandboxed apps' save panels are out-of-process.** TextEdit's Save sheet belongs to `com.apple.appkit.xpc.openAndSavePanelService`. Its elements appear in TextEdit's AX tree but the driver refuses actions on them (`element_outside_target_window`), and the service window has no AX surface of its own. `desktop.observe` gained `attached_panel` (host AX geometry, pixel input on the panel window). It needs the panel service in the grant, and the bounded manifest pins the service by its canonical executable path. Background pixel input to that window is still refused, so this route is not yet usable.
- **Synthetic keystrokes follow the owner's active keyboard layout.** On this Mac (Arabic PC), Cmd‑Shift‑G arrived as the letter "ل". Billy never changes the owner's input source, so keyboard chords are not a dependable navigation method. Prefer AX actions, then pointer.
- **The driver reads pixel `x,y` in screenshot space.** It downscales large windows (a 1700 pt panel became 1568 px), so `desktop.act` now converts points to the driver's screenshot pixels before pixel input.
- **The driver's structured element list holds only actionable elements.** Static text (status labels, plain list cells) is only in its markdown. `desktop.observe` now adds those as read-only entries (no token, no frame).
- **Finder (T-MAC-03).** Finder opens fixture folders in column view, so the target column can sit outside the window. View ▸ as List fixes that, and selection by AX press works. But Finder builds its Edit menu only when the menu opens, so `invoke_menu` cannot find Copy or Paste Item while Finder is in the background (the menu still shows the owner's own \"Undo …\" item). Billy never invokes an item it cannot match exactly. Fixture Finder windows are closed in `finally`.
- **Fixture save panel (T-MAC-08).** The name field is set exactly (Unicode, verified). Expanding the panel and widening it puts the target folder row in view. A double-click on the row (AX open is unsupported, then the foreground pointer fallback) closes the panel with neither a save nor a cancel recorded. The location popup's menu also does not open reliably via AX press. Still open.
