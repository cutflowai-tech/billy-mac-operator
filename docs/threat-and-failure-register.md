# Billy threat and failure register (P0)

Status: living document. Review date 2026-10-11, against commit `4f19bfa` (P2 spine).
Scope: handoff §11 (policy, secrets, threat model), §12 (native control), §15.3 (remote auth), §18 (failure modes), §24.5 (T-SEC scenarios), ADR-0001, ADR-0002, both foundation audits, and all of `core/src/**`.

Status vocabulary used below:

- **IMPLEMENTED+TESTED** – code exists, and a test in `core/test/**` exercises the hostile path (the test file is named).
- **IMPLEMENTED_UNTESTED** – code exists, but no test drives the hostile path.
- **PARTIAL** – code covers part of the threat. The gap is named, and in most cases it is a numbered finding in §4.
- **PLANNED** – no code yet. The design source (ADR or handoff section) is cited.

"Residual risk" is what remains after the stated mitigation works as intended. It is not a list of bugs; bugs are in §4.

---

## 1. Trust boundaries and assets

```
                         ┌───────────────────────────── OWNER (human) ─────────────────────────────┐
                         │ authority source: local app clicks, paired phone (Telegram numeric ID)  │
                         └───────────────┬───────────────────────────────────────┬─────────────────┘
                                         │ B1 local UI (same user)               │ B2 remote (internet)
                                         ▼                                       ▼
 ┌──────────── macOS user session (uid = owner) ──────────────────────┐   ┌───────────────────────┐
 │                                                                    │   │ Telegram Bot API      │
 │  ┌──────────────────────┐   IPC (PLANNED: auth'd,   ┌────────────┐ │◄──┤ (long-poll, outbound) │
 │  │ Billy native app     │◄─ no localhost TCP) ─────►│ billyd     │ │   │ untrusted transport;  │
 │  │ (SwiftUI, menu bar)  │          B3               │ core daemon│ │   │ identity = numeric ID │
 │  └──────────────────────┘                           │ (Node,     │ │   └───────────────────────┘
 │                                                    │  zero deps)│ │
 │   ASSETS inside billyd's trust zone:               │            │ │   ┌───────────────────────┐
 │   A1 ~/Library/Application Support/Billy/billy.db  │ broker ◄───┼─┼───┤ Model providers (cloud│
 │      (grants, tasks, attempts incl. receipts,      │ policy     │ │B5 │ egress): Anthropic /  │
 │       events, inbox/outbox, budget)  dir 0700      │ executor   │ │──►│ others. Receive task  │
 │   A2 stop latch + cancellation generations         │ store      │ │   │ context, receipts,    │
 │   A3 policy/grant rows (only owner paths write)    └─────┬──────┘ │   │ screenshots (PLANNED) │
 │   A4 Keychain items (credential refs) ── B6 ──────────►  │        │   └───────────────────────┘
 │                                                          │ B4 NDJSON on unix socket
 │                                                          ▼ (same-uid only, NO token)
 │   ┌──────────────────────────────┐        ┌───────────────────────────────┐
 │   │ Untrusted workers (PLANNED)  │  ✗ deny│ CuaDriver.app 0.26.1 daemon    │
 │   │ generated scripts, installs, │───────►│ private socket path (ADR-0002) │
 │   │ repo builds; sandbox-exec     │  (B7)  │ bounded mode + manifest        │
 │   │ Seatbelt profile denies A1,  │        │ holds TCC: AX + Screen Rec.    │
 │   │ A4, Cua socket dir, policy   │        └──────────────┬────────────────┘
 │   └──────────────────────────────┘                       │ AX / CGEvent / ScreenCaptureKit
 │                                                          ▼
 │   A5 local files (granted roots; everything else)   A6 other apps / windows / clipboard
 │   A7 other same-user processes (any app the owner runs) ── can reach B4 and A1 (same uid)
 └────────────────────────────────────────────────────────────────────┘
```

| Boundary | From → to | What crosses | Status (updated 2026-10-11) |
|---|---|---|---|
| B1 | Owner → native app | Clicks, grants, stop | IMPLEMENTED. The app talks to billyd only over B3 (`native/Sources/BillyKit/BillyClient.swift`). |
| B2 | Phone → Telegram → billyd | Commands, stop, replies | IMPLEMENTED and contract-tested (`core/src/remote/telegram.ts`; `core/test/security/telegram.test.ts`). Identity is the numeric user id of a paired device. Forwarded, group and bot messages are rejected. Live qualification is pending (S4). |
| B3 | App ↔ billyd | Control API | IMPLEMENTED: Unix socket only (0600 socket in a 0700 directory), bearer token, and any browser Origin/Sec-Fetch header refused (`core/src/daemon/api.ts`). There is no TCP listener (T-SEC-08). |
| B4 | billyd → Cua daemon | Desktop tool calls | IMPLEMENTED: a private bounded daemon on Billy's socket with a manifest generated from the grant and no display-wide observation (`core/src/desktop/cua.ts`). Residual risk (ADR-0002): any same-user process can reach a Cua socket. |
| B5 | billyd → model providers | Prompt context, receipts, file contents | IMPLEMENTED: `ModelGateway` (`core/src/ai/gateway.ts`) checks egress per task grant, budget and stop latch, and applies redaction. F-11 is accepted as residual. |
| B6 | billyd → Keychain | Credential refs | IMPLEMENTED: named references only (`core/src/secrets/keychain.ts`). Endpoint credentials require `grant.secret_references` and are injected at the transport boundary (`core/src/tools/api.ts`, T-SEC-09). |
| B7 | Workers → host | Everything | IMPLEMENTED: untrusted code runs only through Seatbelt (`core/src/sandbox/seatbelt.ts`). The profile and temp directory live outside the workspace (T-SEC-03/07/11). Worker processes hold only a lease token (ADR-0004). |

Assets, ranked by impact: A4 credentials > A3 policy/grants and A2 stop latch (integrity) > A5 owner files outside roots (confidentiality and integrity) > A6 desktop input (integrity) > A1 audit trail (integrity and confidentiality) > budget (availability of money).

Adversaries considered:

- (a) Hostile content: web pages, repos, screenshots, tool output, notifications, and model output that reads it.
- (b) A compromised or malicious dependency, skill, or generated script running as a worker.
- (c) A hostile website in the owner's browser that targets loopback.
- (d) A remote attacker holding stolen Telegram credentials or a stolen session.
- (e) Another same-user process. This one is out of scope for containment and is only listed for residual risk; same uid means it can already read A1.
- (f) Tampered update artifacts.

---

## 2. Threat register

Code references use `file:line` or `file::symbol`. Test references are files under `core/test/`.

| ID | Threat | Current mitigation (where implemented) | Status | Acceptance IDs | Residual risk |
|---|---|---|---|---|---|
| TH-01 | Prompt injection via web pages, repo files, screenshots, or tool output changes the goal, the recipient, or the policy | Grants are written only by `PolicyStore.putGrant` (`policy/policy.ts:114`). The broker decides from the grant row and adapter-resolved facts (`broker/broker.ts:126,145`), never from content. Success criteria are frozen per revision (`tasks/tasks.ts:31-44`, `Tasks.criteriaDigest`). Planner postconditions are added to tool postconditions and cannot replace them (`broker.ts:129-130`). **Gaps:** the message recipient `to` is model-supplied and not bound by any grant field (`tools/api.ts:28,45`). Planner-supplied postconditions can name any path, which gives an injected planner a read oracle (F-04). | PARTIAL; criteria binding is IMPLEMENTED+TESTED (`integration/broker.test.ts` T-ACTION-08) | T-SEC-01, T-SEC-02, T-MEM-04, T-ACTION-08 | Injected content can still choose *any* action inside the standing grant, including messages to arbitrary recipients on a granted account. Grant breadth is the real blast radius. |
| TH-02 | Malicious dependency, skill, or install script | ADR-0001: zero third-party runtime npm deps; `package.json` has devDependencies only. Cua is pinned by sha256 and team ID (ADR-0002 §1; enforcement code not yet written). No skill or plugin loader exists. | PARTIAL (dependency surface minimised); pin enforcement PLANNED | T-SEC-03, T-SEC-10, T-FOUND-01 | devDependencies (`typescript`, `@types/node`) run at build time on the host. `npm install` without `--ignore-scripts` would run their install scripts as trusted host code. |
| TH-03 | Worker scope escape (filesystem, sockets, Keychain, policy DB) | Logical only: `Broker.authenticate` (`broker.ts:91-99`) binds actor to task, lease status, and generation. There is no process isolation; no worker launcher exists. The Seatbelt profile (ADR-0002 §3) is PLANNED. The `core:<task_id>` actor id is self-asserted (F-09). | PLANNED | T-SEC-03, T-SEC-07, T-SEC-11, T-AGENT-05 | Until Seatbelt lands, no untrusted code may run. Any worker code would currently be same-uid with direct access to A1, A4, and B4. |
| TH-04 | Stolen remote credentials (Telegram bot token, paired session) | Schema only: `devices`, `pairing_challenges` (`store/schema.ts:230-250`). Inbox dedup via `Inbox.admit`. Identity verification is the caller's job. | PLANNED | T-REMOTE-04, T-REMOTE-05, T-REMOTE-07, T-REMOTE-08 | A stolen bot token lets an attacker read every message to the owner and impersonate Billy *to* the owner, but not the owner to Billy, provided numeric-ID binding is enforced. |
| TH-05 | Replayed or duplicated commands | `Inbox.admit` (`inbox/inbox.ts:19-33`) keys on `(source, source_message_id)` in one transaction with task creation. Semantic-operation dedup is in `broker.ts:151-172`, plus the unique index `attempts_one_live` (`store/schema.ts:105`). | IMPLEMENTED+TESTED (`integration/spine.test.ts` "T-REMOTE-03 (core part)"; `integration/store.test.ts` "only one live attempt") | T-REMOTE-03, T-ACTION-07 | Semantic identity includes the planner-chosen `step_key` and the exact args (`broker.ts:128`), so a model that rewords a step creates a new operation and a second provider key (F-10). |
| TH-06 | Local web-to-loopback (CSRF, DNS rebinding, unauthenticated WebSocket) against a local API | No listener exists in `core/src`. Design rule: no localhost TCP control port; IPC must be same-user authenticated (handoff §11.4, §15.3). | PLANNED (no current attack surface) | T-SEC-08 | When a listener is added, it must check Host and Origin and require a non-cookie token. A unix socket is preferable. |
| TH-07 | Path traversal, symlink races, prefix tricks, mount swaps | `canonicalTarget` (`tools/fs.ts:27-48`) realpaths the parent and refuses a symlink leaf. `pathWithinRoots` (`policy.ts:101-107`) uses a `root + '/'` boundary. Root `dev:ino` is rechecked in the DISPATCHING transaction (`broker.ts:233-234`) and again before link/rename (`fs.ts:199`). Reads use `O_NOFOLLOW` (`fs.ts:98`). **Broken for source-side arguments**: `fs.copy.from`, `fs.move.from`, and `fs.trash.trash_dir` are never authorized (F-01, F-02). Path case variants on APFS are not normalised (F-15). | PARTIAL: destination side IMPLEMENTED+TESTED (`integration/broker.test.ts` T-SEC-04, T-ACTION-05); source side FAILS | T-SEC-04, T-ACTION-05 | Even with the fixes there is a check-then-use window between the `rootIdentity` check and `linkSync`/`renameSync`, because Node has no `openat`/`renameat`. A same-user racer can win it. Containment needs dirfd-based I/O (a native helper) or a sandbox. |
| TH-08 | Stale screenshots or elements; click lands on the wrong control | Envelope carries `observation_ref` (`contracts/action.ts:64`). Cua element tokens are snapshot-bound and refused when stale (`foundation-audit-cua.md` §5). No desktop adapter yet. | PLANNED | T-MAC-05, T-MAC-06, T-MAC-07, T-MAC-12 | Coordinate-only clicks (`x,y`) carry no snapshot binding in Cua. Billy must forbid them or bind them to a fresh capture. |
| TH-09 | Secret leakage through logs, notifications, model requests, or the DB | `redact` (`util/redact.ts:25`) applies **only** to outbox title and body (`notify/outbox.ts:31`). Events, `attempts.arguments_json`, `receipt_json`, `evidence_json`, and executor error events are stored raw. Pattern gaps (F-07). Raw text prefix in the notify dedup key (F-08). File contents are persisted in receipts and fed to the planner (F-11). | PARTIAL; IMPLEMENTED_UNTESTED (no redaction test exists) | T-SEC-05, T-SEC-09, T-REMOTE-07 | Redaction is pattern-based and cannot catch arbitrary secrets that aren't registered. Prevention (refs, not values) is the primary control and is not built yet. |
| TH-10 | Unauthorized provider failover (private data sent to an unapproved vendor) | `decide` checks `resolved.egress_provider` against `scope.model_egress` (`policy.ts:199-201`). No adapter sets `egress_provider` yet. `api.send_message` follows HTTP redirects to unapproved hosts (F-05). | PARTIAL (policy hook only) | T-SEC-12, T-AI-03 | Whichever adapter calls models must set `egress_provider` itself. A forgotten fact silently skips the check, because `decide` treats `undefined` as "not applicable". |
| TH-11 | Forged sub-agent evidence ("tests passed", fabricated owner approval) | Task completion is decided by `CriteriaVerifier` (`verify/taskVerifier.ts:14-29`) against frozen criteria and actual file state. Attempt verification runs inside the broker (`broker.ts:275`), not from the worker's word. Children cannot write grants (no API). | IMPLEMENTED_UNTESTED for children (no child runtime); verifier IMPLEMENTED+TESTED (`integration/spine.test.ts` "independent final verification") | T-SEC-06, T-AGENT-07 | `ConditionChecker` plugins and `step_committed` trust the broker's own records. That is acceptable as long as only the broker writes `attempts`. |
| TH-12 | Mutable acceptance tests or evaluator tampering | Requirements manifest is frozen with a sha256 (`release/requirements.manifest.sha256`, `tools/freeze_manifest.py`). Criteria digest per revision (`tasks.ts:40`). Migration digests are pinned (`store/db.ts:119-122`). | PARTIAL | T-REL-02, T-REL-03, T-SEC-11 | The test files themselves are writable by any same-user builder agent. Evidence must be bound to a commit and rerun independently (T-REL-03, T-REL-09). |
| TH-13 | Compromised update or component artifacts (Node runtime, CuaDriver.app) | ADR-0001 (checksum-verified Node) and ADR-0002 §1 (sha256 + team ID pin, refuse mismatch). No code yet. | PLANNED | T-SEC-10, T-REL-06 | Pin checks run at startup. A same-user attacker who replaces the binary *after* the check (TOCTOU) is not covered. Re-check before each daemon launch. |
| TH-14 | Another same-user process reaches the Cua socket (or billy.db) | ADR-0002 §2: private socket path in a 0700 directory, bounded mode, a manifest generated from grants, telemetry disabled. Data dir 0700 and db 0600 (`store/db.ts:58-59,78`). | PLANNED (socket); IMPLEMENTED_UNTESTED (dir/db modes) | T-SEC-03, T-SEC-07 | **Accepted residual** (ADR-0002 §5): any same-uid process can connect to any Cua socket, send `shutdown`, or open billy.db. Directory modes do not stop the same uid. Only OS identity checks (`LOCAL_PEERPID` + code signature) or a separate user would. |
| TH-15 | Clipboard leakage or clobbering | Cua exposes `clipboard_read` as an R2 tool (`foundation-audit-cua.md` §3). Billy has no clipboard adapter. Handoff §12.4 rules apply. | PLANNED | T-MAC-02, T-MAC-09 | When built: never persist clipboard contents as evidence, compare the change count before restoring, and exclude `clipboard_read` from the manifest unless granted. |
| TH-16 | PID reuse leads to killing or signalling an unrelated process | No process tools. `cancellation: 'kill_owned_process'` exists only as a spec enum (`contracts/action.ts:113`). The Cua manifest mixes pids and window IDs (`foundation-audit-cua.md` §4). | PLANNED | T-AGENT-08, T-DUR-08 | Bind process ownership to (pid, start time, audit token) or a process-group handle. Never use a bare pid. |
| TH-17 | TCC permission confusion after rebuild or re-sign, or attribution to the wrong responsible process | ADR-0002: launch Cua via LaunchServices so TCC attributes to `com.trycua.driver`. Child-spawn attribution is UNVERIFIED (`foundation-audit-cua.md` §8). | PLANNED | T-MAC-11, T-UX-04, T-FOUND-03 | A rebuild or signature change silently invalidates grants. Doctor must name the exact executable and code-signing requirement; it must not report "granted" from a stale cache. |
| TH-18 | Owner stop does not take effect (bypass or racing dispatch) | `Control.stopAll` (`tasks/control.ts:29-54`) sets the latch and bumps generations in one transaction. The broker re-reads both inside the DISPATCHING transaction (`broker.ts:221-243`). The latch persists. **Gaps:** in-flight adapters get an AbortSignal that is never aborted (F-12). VERIFYING and RECONCILING tasks are not paused (F-13). | IMPLEMENTED+TESTED (`integration/spine.test.ts` T-ACTION-09, T-DUR-12) with gaps | T-ACTION-09, T-DUR-12, T-REMOTE-06 | An effect that is already dispatching completes. That is correctly reported as in-flight, but it cannot be cancelled even for cancellable adapters. |
| TH-19 | Revoked or narrowed grant still authorizes queued work | `decide` is re-run at dispatch with a fresh `policy.effective()` (`broker.ts:229-231`). The revision must match (`policy.ts:170`). Cascading revoke (`policy.ts:128-136`). | IMPLEMENTED+TESTED (`integration/broker.test.ts` T-ACTION-06) | T-ACTION-06, T-REMOTE-04, T-SEC-12 | `putGrant` on a revoked grant id silently re-activates it, and every task bound to it with it (F-14). |
| TH-20 | Budget over-admission or unaccounted spend | Transactional reservations (`budget/budget.ts:60-77`). UNCERTAIN spend counts. A missing ceiling means wait. | IMPLEMENTED+TESTED (`integration/spine.test.ts` T-BOOT-05, T-AI-04) | T-AI-04, T-BOOT-05 | A reservation that spans UTC midnight under a daily ceiling disappears from accounting (F-16). |
| TH-21 | Alternate route after a policy denial (try shell, GUI, or another tool) | The single broker path is enforced by composition (`core.ts:54`); there is no shell, MCP, or desktop tool yet. On DENIED the executor simply replans (`scheduler/executor.ts:263-264`), with no cross-route denial memory. | PARTIAL | T-SEC-07 | When shell and desktop tools are added, a denial for resource R must deny R on every route. That needs a resource-level, not tool-level, decision. |
| TH-22 | Pre-authorization probing (existence oracle, unbounded reads before policy) | None. `tool.resolve()` runs **before** `decide()` (`broker.ts:121-145`) and touches the filesystem for arbitrary paths (F-06). | NOT MITIGATED | T-SEC-04, T-SEC-09 | See F-06. |
| TH-23 | Owner phishing via planner-authored notification text | Outbox redacts secrets only. Planner `reason` strings go straight to the owner channel (`executor.ts:212,217`). | NOT MITIGATED | T-UX-02, T-SEC-01 | Injected content can make Billy send attacker-chosen text or links to the owner's phone under Billy's identity. Templated notifications plus quoting of untrusted text would reduce this. |

---

## 3. Failure-mode register (handoff §18)

Test references are to `core/test/**`. "—" means no test exists yet.

| # | Failure mode | Billy handling today (file refs) | Test covering it | Status |
|---|---|---|---|---|
| 1 | Malformed or partial model output | Strict tool `input_schema` validation, envelope schema validation, and unknown-tool rejection before any effect (`broker.ts:107-110,143-144`; `contracts/schema.ts`). No model planner yet. | `integration/broker.test.ts` T-ACTION-01 | IMPLEMENTED+TESTED (broker side); model repair PLANNED |
| 2 | Provider rate limit | `api.send_message` maps every 4xx, **including 429**, to a non-retryable definite failure (`tools/api.ts:65`) and ignores `Retry-After`. Planner errors map to WAITING_PROVIDER (`executor.ts:191-198`). No failover code. | — | PARTIAL (429 handled wrongly; see F-17) |
| 3 | Provider authentication expires | Planner exception leads to WAITING_PROVIDER with one notification (`executor.ts:194-197`). No auth-specific path. | — | PLANNED |
| 4 | Connection lost after external send | Transport error gives `unknown`, then OUTCOME_UNKNOWN, then `reconcileAttempt` via provider lookup on the stable key `billy-<semantic_operation_id>` (`api.ts:67-69,87-90`; `broker.ts:271-273,302-347`). | `fault/crash-boundaries.test.ts` T-DUR-04 | IMPLEMENTED+TESTED |
| 5 | Crash before journal intent commit | Fault point `broker.before_intent_commit`. No row exists, so nothing is dispatched. Recovery rejects PROPOSED/VALIDATED rows (`broker.ts:357-359`). | `fault/crash-boundaries.test.ts` (SIGKILL at each boundary, both tools) | IMPLEMENTED+TESTED |
| 6 | Crash between dispatch record and adapter call | DISPATCHING is persisted before the call (`broker.ts:241`). Recovery treats DISPATCHING as OUTCOME_UNKNOWN and reconciles (`broker.ts:312`). | `fault/crash-boundaries.test.ts` (`broker.after_dispatching`) | IMPLEMENTED+TESTED |
| 7 | Crash after effect but before receipt | `broker.after_adapter_call` then reconcile; a found key means COMMITTED and no resend. | `fault/crash-boundaries.test.ts` T-DUR-03/04 | IMPLEMENTED+TESTED; recovery can abort entirely if `verify` throws (F-03) |
| 8 | Notification service fails | Outbox is separate from task state; backoff and retry use a stable `dedup_key` (`notify/outbox.ts:38-86`). | `integration/spine.test.ts` T-DUR-05 | IMPLEMENTED+TESTED; concurrent `deliverDue` can double-send (F-18) |
| 9 | Lead context rolls over | Durable plans, history, and attempts (`executor.ts:144-166`). No model context builder. | — | PLANNED |
| 10 | Worker stops responding | `workers` table generation is checked by `authenticate`. Recovery marks RUNNING workers LOST (`core.ts:88`). No worker runtime. | — | PLANNED |
| 11 | Worker lies about tests | The broker verifies independently (`broker.ts:275`). `CriteriaVerifier` checks real state. | `integration/broker.test.ts` T-ACTION-04 (lying tool) | IMPLEMENTED+TESTED (tool level); worker level PLANNED |
| 12 | Agent modifies its policy or config | No API lets a non-owner write grants. No containment boundary exists yet. | — | PLANNED (needs TH-03) |
| 13 | Hostile dependency install script | Zero runtime deps. No sandbox. | — | PLANNED |
| 14 | Website contains injected instructions | Content never reaches `decide`. Recipient is unconstrained (TH-01). | — | PARTIAL |
| 15 | Source file mimics an agent instruction | Same as #14. | — | PARTIAL |
| 16 | Stale screenshot or moved window | `observation_ref` field only. | — | PLANNED |
| 17 | User moves mouse or changes focus | — | — | PLANNED |
| 18 | Secure input or protected permission dialog | — | — | PLANNED |
| 19 | Mac locks or sleeps | `WAITING_USER_SESSION` state exists (`domain/machines.ts:7`). No detector. | — | PLANNED |
| 20 | Logout or reboot | Durable recovery sequence (`core.ts:85-110`). No login-item/SMAppService code. | `integration/spine.test.ts` T-DUR-12 (restart) | PARTIAL |
| 21 | Disk nearly full | — (SQLite errors propagate; executor loop logs an event, `executor.ts:117`) | — | PLANNED |
| 22 | SQLite busy or contention | Single writer, `BEGIN IMMEDIATE`, bounded `busy_timeout` (`store/db.ts:72,145-159`). | `integration/spine.test.ts` T-DUR-09 | IMPLEMENTED+TESTED |
| 23 | Database corruption | `integrityGate` (`PRAGMA quick_check`) refuses to open a corrupt store (`db.ts:89-98`). | — (no corruption fixture test) | IMPLEMENTED_UNTESTED |
| 24 | Live backup incomplete | `backupTo` uses the SQLite backup API plus `quick_check` on the copy (`db.ts:217-229`). | `integration/store.test.ts` "backup is consistent with WAL activity" | IMPLEMENTED+TESTED (restore path PLANNED) |
| 25 | External volume disappears | Live DB under `/Volumes/` or a cloud folder is refused (`db.ts:25-38`). The parent `dev:ino` fingerprint catches a remount at dispatch (`fs.ts:50-53`). | `integration/store.test.ts` "live DB under an external volume"; `integration/broker.test.ts` T-SEC-04 (dir swap) | IMPLEMENTED+TESTED (partial: no mount-identity check on resume) |
| 26 | Symlink or path changes during operation | See TH-07. Source-side args are unchecked (F-01, F-02). Case aliasing (F-15). | `integration/broker.test.ts` T-SEC-04 | PARTIAL |
| 27 | PID reused | — | — | PLANNED |
| 28 | Clipboard changes during task | — | — | PLANNED |
| 29 | Duplicate phone command | `Inbox.admit` (`inbox.ts:19-33`). | `integration/spine.test.ts` T-REMOTE-03 (core) | IMPLEMENTED+TESTED (core); transport PLANNED |
| 30 | Remote token stolen or revoked | `devices.revoked_at` column only. | — | PLANNED |
| 31 | Remote stop delayed offline | The latch applies on receipt (`control.ts:29`). No transport acknowledgement. | — | PLANNED |
| 32 | Owner changes task mid-execution | `Control.revise` bumps the revision and generation (`control.ts:113-121`). The broker rejects stale revisions at admission and at dispatch (`broker.ts:113-114,226`). | `integration/broker.test.ts` T-ACTION-10 (part) | IMPLEMENTED+TESTED |
| 33 | All allowed retries fail | Per-step retries, equivalent-failure counting, a replan cap, and BLOCKED_EXTERNAL with notification (`executor.ts:40,228-246`). `MAX_ATTEMPTS_PER_OPERATION` (`broker.ts:19,162`). | `integration/spine.test.ts` (multi-step) — no exhaustion test | IMPLEMENTED_UNTESTED |
| 34 | Budget exhausted or usage unknown | `Budget.reserve` waits. Unknown usage settles as UNCERTAIN (`budget.ts:80-97`; `broker.ts:263`). | `integration/spine.test.ts` T-BOOT-05, T-AI-04 | IMPLEMENTED+TESTED (midnight gap F-16) |
| 35 | Permissions revoked mid-task | Grant revocation is checked at dispatch (TH-19). TCC revocation is not modelled. | `integration/broker.test.ts` T-ACTION-06 | PARTIAL |
| 36 | Helper version mismatches core | Migration digest and newer-schema refusal (`db.ts:109-129`). Cua `require_compatible_daemon` is upstream. Billy pin check PLANNED. | — | PARTIAL |
| 37 | Upgrade fails mid-migration | Each migration runs in one transaction (`db.ts:124-127`). | — | IMPLEMENTED_UNTESTED |
| 38 | Upstream security issue affects used code | Pinned versions plus audits (`docs/foundation-audit-*.md`). No advisory feed. | — | PLANNED |
| 39 | Final artifact differs from tested commit | — | — | PLANNED (T-REL-03) |
| 40 | Test prerequisite unavailable | Ledger external-blocker records (`execution/ledger.json`). | — | PARTIAL |

---

## 4. Findings (current code, commit 4f19bfa)

Each finding was confirmed by reading the code. Every one marked **[reproduced]** was also run against the real `Core`/`Broker` with throwaway scripts (kept outside the repo). Line numbers refer to commit `4f19bfa`.

### F-01 — CRITICAL — `fs.copy` and `fs.move` never authorize the source path [reproduced]
**Where:** `core/src/tools/fs.ts:245-253` (fsCopy.resolve), `:280-293` (fsMove.resolve), and `core/src/policy/policy.ts:184-188` (`decide` checks only `resolved.facts.file_path`, which is the destination).

**Scenario:** A planner steered by an injected web page proposes `fs.copy {from: "~/.ssh/id_rsa", to: "<granted root>/notes.txt"}`. The result is `COMMITTED`, the private key now sits in the granted root, and from there a later `fs.read` or upload exfiltrates it. `fs.move` from outside the root *removes* the owner's original from its location (reproduced: outside file gone, verdict COMMITTED). The existing T-SEC-04 test passes only because it exercises destinations.

**Fix:** Have adapters return *all* touched paths, for example `facts.file_paths: [{path, access:'read'|'write'|'delete'}]`, and make `decide` require every one inside the granted roots. Add a source-side case (copy, move, symlinked source) to T-SEC-04.

### F-02 — HIGH — `fs.trash` accepts an unauthorized, model-supplied `trash_dir` [reproduced]
**Where:** `core/src/tools/fs.ts:326` (schema), `:331`, and `:340-343`, where `mkdirSync(dir,{recursive:true})` is followed by `renameSync` into it.

**Scenario:** `fs.trash {path: "<root>/payload.plist", trash_dir: "~/Library/LaunchAgents"}` creates arbitrary directories anywhere the user can write. It also moves granted-root content outside every root; for example, it can plant a file in an autostart or sync folder. Reproduced: directory created, file moved, COMMITTED.

**Fix:** Remove `trash_dir` from the model-facing schema; use `trashDirFor()` only, with the test override injected via `services`. Alternatively, require `trash_dir` to be inside a granted root and authorize it as a write path (F-01 mechanism).

### F-03 — HIGH — An exception from `verify` strands attempts and aborts the whole startup recovery [reproduced]
**Where:**
- `core/src/broker/broker.ts:275`: `tool.verify` is not wrapped in try/catch.
- `:327`: `tool.verify` is also unwrapped inside `reconcileAttempt`.
- `:356-369`: `recover()` has no per-row error isolation.
- `core/src/core.ts:85-110`: `Core.recover` runs `broker.recover()` first.
- `core/src/scheduler/executor.ts:224` has no try/catch around `broker.submit`, and `:106` leaves the `runTask` promise without a catch, which makes it an unhandled rejection that terminates Node.

**Scenario:** A verifier throws, for example because a provider lookup endpoint was removed from `services` and `lookup(undefined)` dereferences `ep.lookup_path`. `submit` then rejects with the attempt left in OBSERVED_SUCCESS or RECONCILING, and the daemon crashes on the unhandled rejection. On restart, `recover()` hits the same row and throws again. Claims are not cleared, workers are not marked LOST, RUNNING tasks stay RUNNING, and outbox SENDING rows are not reset. Every subsequent start fails the same way (reproduced: "recover THREW", stale claim still present, other task still RUNNING). Even the stop latch still works, but nothing recovers.

**Fix:** Wrap `verify` (and `reconcile`) in try/catch that maps to `inconclusive`/`unknown`, which leaves the attempt UNRESOLVED. Isolate each row in `recover()` and record failures as events. Do the claims/workers/outbox/task steps regardless. Add `.catch` on `runTask` that moves the task to BLOCKED_EXTERNAL with a recorded error.

### F-04 — HIGH — Planner-supplied postconditions act as an arbitrary-file read oracle [reproduced]
**Where:** `core/src/broker/broker.ts:129-130` merges `p.postconditions` unchecked. `core/src/tools/fs.ts:226-236` (`verifyFileConditions`) reads any path. `CONDITION_SCHEMA` (`contracts/action.ts:12-17`) constrains only shape.

**Scenario:** An injected planner submits a harmless in-root `fs.write` with the postcondition `{kind:'file_contains', path:'~/.ssh/id_rsa', text:'<guess>'}`. COMMITTED versus FAILED leaks one bit per probe, so contents can be extended character by character. A `file_sha256` postcondition returns the outside file's full sha256 in `evidence` (reproduced). Reads are unbounded, so pointing at a multi-GB file blocks the event loop.

**Fix:** Reject planner postconditions whose paths are not inside the effective grant's roots (run them through `decide`). Cap read size. Do not return `got` values for planner-supplied conditions. Only owner-frozen criteria may reference other paths.

### F-05 — MEDIUM — `api.send_message` follows HTTP redirects past destination policy [reproduced]
**Where:** `core/src/tools/api.ts:57-61` (POST) and `:95` (lookup GET) call `fetch` with the default `redirect:'follow'`. Policy checks only `new URL(ep.base_url).host` (`:44`, `policy.ts:192-195`).

**Scenario:** A compromised or misconfigured endpoint, or an open redirect on it, answers 307 `Location: http://attacker/collect`. Billy re-POSTs the message body (private content) to a host that is not in `network_destinations`. Reproduced: the attacker server received `{"account":"acct","to":"bob","body":"PRIVATE BODY"}`. A 307/308 on the lookup path can likewise forge `found:true`, which turns an unknown outcome into COMMITTED.

**Fix:** Pass `redirect: 'error'` (or `'manual'` and treat 3xx as definite failure). Enforce `https:` for non-loopback `base_url`.

### F-06 — MEDIUM — Target resolution touches the filesystem before authorization (existence oracle and pre-auth DoS) [reproduced]
**Where:** `core/src/broker/broker.ts:121-125` calls `tool.resolve()` before `decide()` (`:145`). Resolvers realpath, lstat, and fully read files (`fs.ts:27-48`, `fileDigest` `:55-61` with no size cap, used by copy/move/trash `resolve`).

**Scenario:** `fs.read /etc/hosts` returns "path outside granted roots". `/etc/nonexistent` returns "target does not exist: /private/etc/nonexistent". `/nonexistent-dir/x` returns "parent does not exist". The reason string reaches the planner, giving an injected model a file-existence oracle over the whole disk. `fs.copy {from: <2 GB file outside roots>}` makes the daemon `readFileSync` and hash it before any policy check, which blocks the single event loop for seconds and spikes memory; a FIFO path can block it outright.

**Fix:** Do a lexical pre-check of the normalized path against the roots before any syscall. Return a uniform "DENIED: outside scope" for every failure outside roots. Stream digests with a size cap. Refuse non-regular files before opening.

### F-07 — MEDIUM — Redaction misses common credential shapes and the `Authorization: Bearer` form [reproduced]
**Where:** `core/src/util/redact.ts:14-23`.

**Scenario** (reproduced outputs):
- `Authorization: Bearer <opaque>` becomes `Authorization: [REDACTED] <opaque>`. The keyword regex consumes "Bearer" as the value, and the token survives.
- `sk-proj-…` and `sk-svcacct-…` (current OpenAI key formats) are untouched, because `sk-[A-Za-z0-9]{20,}` stops at the `-`.
- PEM/OpenSSH private keys, `https://user:pass@host`, `Cookie:` values, Slack `xox?-`, and Google `AIza…` keys pass through.
- `"password": "correct horse battery"` redacts only the first word.

There is also no redaction test for T-SEC-05.

**Fix:**
- Handle `bearer\s+<token>` explicitly.
- Broaden `sk-[A-Za-z0-9_-]{20,}`.
- Add patterns for PEM blocks, URL userinfo, cookies, `xox[abpr]-`, and `AIza[0-9A-Za-z_-]{35}`.
- Redact the whole quoted JSON value.
- Add a canary corpus test.

Redaction remains a backstop: secrets must never be placed in these strings.

### F-08 — MEDIUM — Notification dedup key embeds raw, unredacted text and silently drops distinct notifications
**Where:** `core/src/core.ts:79`: `Buffer.from(text).toString('base64url').slice(0,48)`. The key is stored in `outbox.dedup_key` and passed to `Channel.send(..., dedupKey)` (`notify/outbox.ts:59`). Redaction runs only on the body (`outbox.ts:31`).

**Scenario:** A blocked reason such as `"token sk-ant-api03-…"` puts the first 36 bytes of the raw secret, base64url-encoded, into the DB and into whatever the channel does with the key (for example a Telegram payload or log). Separately, two different messages with the same first 36 bytes (for example "Waiting: budget wait on scope-x: remaining …") dedupe to one, so the owner never sees the second.

**Fix:** Use `digest(redact(text))` (the full sha256) as the text component.

### F-09 — MEDIUM — Broker caller authentication is self-asserted for `core:<task_id>`
**Where:** `core/src/broker/broker.ts:92`.

**Scenario:** Any caller that can construct a `Proposal` and sets `actor_id: "core:<task>"` skips the worker-lease and generation checks entirely. Today all callers are in-process, so this is latent. It becomes a direct scope escape (T-SEC-06, T-AGENT-05) the moment proposals arrive over worker IPC, because a fenced or stale worker simply claims the core identity.

**Fix:** Authenticate by a capability object, not a string. Give the executor an unforgeable in-process token (a private symbol or closure). For IPC, derive identity from the connection (peer pid + audit token), never from the payload.

### F-10 — MEDIUM — Non-idempotent dedup and provider idempotency depend on planner-chosen `step_key` and exact args
**Where:** `core/src/broker/broker.ts:128` (`semId` includes `step_key` and `args` digest). `core/src/tools/api.ts:87-90` (provider key = `billy-<semId>`).

**Scenario:** After an UNRESOLVED or FAILED send, a model planner re-emits the "same" message with a different `step_key` or a trivially reworded body. That is a new semantic operation and a new provider idempotency key, so the recipient gets a second message. `MAX_ATTEMPTS_PER_OPERATION` and the "proof of non-application" gate are both bypassed. The executor blocks the *task* on UNRESOLVED (`executor.ts:279-283`), but after the owner or recovery unblocks it, nothing prevents the reworded duplicate.

**Fix:**
- For NON_IDEMPOTENT effects, also key a "pending/uncertain effect on (account, recipient)" guard that blocks new sends to the same resource while any attempt there is UNRESOLVED.
- Require the owner to acknowledge before a new send to that recipient.
- Derive the step identity from the task revision plus a broker-assigned ordinal, not from model text.

### F-11 — MEDIUM — File contents read via `fs.read` are persisted in the DB and replayed to the planner
**Where:**
- `core/src/tools/fs.ts:104-105` puts content in the receipt.
- `broker.ts:259` stores `receipt_json`.
- `scheduler/executor.ts:144-148` returns receipts in `history` to every planner call.
- `fs.write` stores `content` in `attempts.arguments_json` (`broker.ts:207`).

**Scenario:** Reproduced: a read of a key file stores `{"content":"SECRET-KEY-MATERIAL\n",…}` in `attempts.receipt_json` permanently, in every backup, and in each later planner context. Once a cloud planner exists, every subsequent model request re-sends it (B5), with no egress classification. This conflicts with §11.6 ("minimize, filter, and classify content before egress") and T-SEC-05.

**Fix:**
- Store large or sensitive payloads in a content-addressed blob store with retention, and keep only digest and size in `receipt_json` and `arguments_json`.
- Have the planner context builder fetch content explicitly under an egress classification.
- Apply `redactDeep` to anything persisted to `events`.

### F-12 — MEDIUM — Stop cannot cancel in-flight work: the adapter AbortSignal is never wired
**Where:**
- `core/src/broker/broker.ts:119,322`: `signal: new AbortController().signal`, and the controller is discarded.
- `core/src/tasks/control.ts:52`: `onStop` hooks exist, but nothing registers one.
- `core/src/tools/api.ts:60` uses its own timeout signal.
- `core/src/scheduler/executor.ts:192` gives the planner an unaborted signal as well.

**Scenario:** The owner hits Stop during a 15 s API call or (future) a long desktop or shell action. The latch is durable and no *new* dispatch happens, but a cancellable adapter (`cancellation: 'cooperative' | 'kill_owned_process'`) runs to completion. The planner model call also keeps running and spending.

**Fix:** Keep a per-attempt `AbortController` map in the broker. Register a `Control.onStop`/`onCancel` hook that aborts controllers for affected tasks. Pass `AbortSignal.any([ctx.signal, timeout])` to `fetch`.

### F-13 — MEDIUM — Tasks in VERIFYING or RECONCILING are not paused by Stop and resume without explicit owner resume
**Where:**
- `core/src/tasks/control.ts:40` transitions only where `PAUSED_BY_OWNER` is legal.
- `core/src/domain/machines.ts:25,27`: VERIFYING and RECONCILING have no PAUSED_BY_OWNER edge.
- `core/src/core.ts:92-100`: `recover()` moves VERIFYING to READY and RECONCILING to READY even while the latch is set.

**Scenario:** The owner stops everything while task T is VERIFYING (or RECONCILING). The daemon restarts and T becomes READY. When the owner clears the latch (intending to resume only selected tasks), T starts running again with no `resume(T)`. This contradicts T-DUR-12 ("old work stays stopped until explicit resume") and §12.4.

**Fix:** Either add PAUSED_BY_OWNER edges from VERIFYING and RECONCILING, or record a per-task `stopped_at_generation` marker that `tick()`/`admitNew()` honour until an explicit resume. In `recover()`, route to PAUSED_BY_OWNER when the latch is set.

### F-14 — LOW — Re-putting a revoked grant silently re-activates it (and all tasks bound to it)
**Where:** `core/src/policy/policy.ts:114-126` (`putGrant` inserts a new revision with `revoked_at NULL`, and `prev` is read with `includeRevoked=true`). `:150-158`: `effective()` recursion has no cycle guard, and `putGrant` does not validate `parent_grant_id`.

**Scenario:** The owner revokes grant G after a stolen-phone event (T-REMOTE-04). Later the owner edits G's scope in the app, for example to narrow it. Every queued task still bound to G regains authority immediately. A parent cycle (G1 has parent G2, G2 has parent G1) causes stack overflow inside `decide` at dispatch.

**Fix:** Refuse `putGrant` for a revoked `grant_id` (revocation is terminal; issue a new id). Validate that the parent exists, is not revoked, and is acyclic.

### F-15 — LOW — Case-variant paths on APFS bypass claims and semantic dedup [reproduced (realpath behaviour)]
**Where:** `core/src/tools/fs.ts:34` uses `realpathSync` (JS implementation), which preserves the caller's case. Verified: `realpathSync('/USERS/Shared')` returns `/USERS/Shared`, while `realpathSync.native` returns `/Users/Shared`. Claim keys `path:<path>` (`fs.ts:77`) and `semId` then differ by case.

**Scenario:** Two concurrent attempts write `<root>/Report.txt` and `<root>/report.txt` (the same inode on case-insensitive APFS). Both get "exclusive" claims and both dispatch, which breaks REQ-12 single-writer. It also produces false denials when the case differs from the grant root.

**Fix:** Use `realpathSync.native` on the parent *and* resolve the leaf's on-disk name (readdir match or `F_GETPATH`), then key claims on `dev:ino` where the file exists.

### F-16 — LOW — Daily budget loses a reservation that spans UTC midnight [reproduced]
**Where:** `core/src/budget/budget.ts:43-51` sums RESERVE/RELEASE/ACTUAL entries by `at >= periodStart`.

**Scenario:** With a ceiling of 1000/day, the planner reserves 900 at 23:59:59 and settles 900 actual at 00:00:01. Yesterday's period ended and today's sees `-900 + 900 = 0`, so remaining is 1000 (reproduced). That spend is never counted against any day. At the boundary up to 2× ceiling can be committed in flight.

**Fix:** Attribute RELEASE, ACTUAL, and UNCERTAIN entries to the period of their RESERVE (store `period_key` on each entry). Alternatively, count open reservations regardless of period.

### F-17 — LOW — HTTP 429 is a permanent, non-retryable failure
**Where:** `core/src/tools/api.ts:65`.

**Scenario:** A rate-limited send becomes DEFINITE_FAILURE, then FAILED, and the semantic operation is permanently failed (`broker.ts:161`). The executor replans, and with a model planner that tends toward a *reworded* send (see F-10) instead of waiting. This violates §18 row "Provider rate limit".

**Fix:** Map 429 (and 503 with `Retry-After`) to `{outcome:'failure', retryable:true}` plus a wait hint that the executor turns into WAITING_PROVIDER with `next_attempt_at`.

### F-18 — LOW — Outbox has no status compare-and-set, so concurrent `deliverDue` double-sends
**Where:** `core/src/notify/outbox.ts:39,53-55` (`UPDATE … SET status='SENDING'` without `AND status IN ('PENDING','UNKNOWN')`).

**Scenario:** A timer-driven `deliverDue` overlaps a manual or "on enqueue" call. Both select the same PENDING row across the `await ch.send` and both send. The owner gets duplicate notifications, and duplicate remote messages count as noise under T-UX-02.

**Fix:** Claim with `UPDATE … WHERE delivery_id=? AND status=?` and skip the row when `changes === 0`. Alternatively, serialise `deliverDue` with an in-process mutex.

### F-19 — LOW — `fs.write` replace mode widens permissions of the replaced file; temp files are 0644 and leak on crash [reproduced]
**Where:** `core/src/tools/fs.ts:196` (`openSync(tmp, …, 0o644)`) and `:204` (`renameSync`).

**Scenario:** Replacing a 0600 private file produces a 0644 file (reproduced). On a multi-user Mac, or when the root is shared, the content becomes readable by other users. A crash between `openSync` and `link`/`rename` leaves `.billy-<attempt>.tmp` with full content, and recovery never cleans it up.

**Fix:** Create the temp file 0600, then `fchmod` it to the original file's mode (and keep owner and xattrs where relevant) before the rename. Sweep `.billy-*.tmp` in granted roots during recovery.

### F-20 — LOW — Partial multi-step file effects are recorded as PROVEN_NOT_APPLIED
**Where:** `core/src/tools/fs.ts:270,311,347`: `reconcile` maps "postconditions not all met" to `not_applied`. `fsMove.dispatch` `:307` does `linkSync` then `unlinkSync`. `fsCopy.dispatch` `:266` (`copyFileSync` can leave a partial destination).

**Scenario:** The process crashes after `linkSync` in `fs.move`. Reconcile sees the destination present and the source present, so it reports `not_applied` and the attempt becomes PROVEN_NOT_APPLIED, which is false evidence. The retry then hits "destination exists (no clobber)" forever. For `fs.copy`, a partial destination file permanently blocks the operation and stays on disk.

**Fix:** Return `unknown` (leading to UNRESOLVED) unless reconcile can prove that *no* part of the effect exists. For move, detect the "both names, same inode" state and complete the unlink. For copy, write to a temp file and `link` it into place, as `fs.write` does.

### F-21 — MEDIUM — WAIT_RESOURCE leaves a dead waiter at the head of the claim queue, blocking that resource until restart [reproduced]
**Where:** `core/src/broker/broker.ts:189-193`: `acquireAll` runs before the `try{…}finally{releaseAll(holder)}` at `:197-280`, so the waiter rows inserted by `scheduler/claims.ts:28-33` for that attempt id are never withdrawn. Each retry is a new attempt id that queues behind the dead one (`claims.ts:25-26`).

**Scenario:** Any momentary contention on `path:X` (or, later, `desktop:<session>`) makes every future acquisition of that key return WAIT_RESOURCE, even after the holder releases. Reproduced: two orphan waiters, permanent WAIT_RESOURCE. Nothing calls `executor.wake('resource_released')` either, so the task also sits in WAITING_RESOURCE forever. For the desktop claim this stops all GUI work until the daemon restarts (`Claims.clearAll`). Claim `expires_at` (`claims.ts:40`) is never checked anywhere, so the TTL gives no relief.

**Fix:** Call `claims.withdraw(holder)` on the WAIT_RESOURCE path. Better, make the waiter identity the stable `semantic_operation_id`, not the attempt id. Emit `wake('resource_released')` from `releaseAll`, and expire claims and waiters by `expires_at`.

### Notes (not defects, recorded for completeness)

- `canonicalTarget`'s `..` check (`fs.ts:31`) is dead code, because `normalize()` has already removed `..`. Safety comes from the root check on the canonical path, so this is harmless but misleading.
- `intersectScope` drops a `*.example.com` child of an identical `*.example.com` parent (`policy.ts:75`). This is a false deny, not an escalation.
- `decide` does not enforce `secret_references`, `foreground`, `browser_profiles`, or `capabilities`. No adapter needs them yet. They must be enforced before the desktop and Keychain adapters land, otherwise grants carry unenforced fields.

---

## 5. Linkage and next actions

- F-01, F-02, F-04, and F-06 block T-SEC-04 and T-SEC-09 from being claimed. Add source-side, `trash_dir`, and postcondition-path cases to `core/test/integration/broker.test.ts`.
- F-03 and F-21 belong under T-REL-08 (crash-boundary coverage) and T-DUR-09. Add a "verifier throws" case and a "contention then release" case.
- F-07, F-08, and F-11 are prerequisites for T-SEC-05. Write a canary-corpus test over outbox, events, attempts, and backup files.
- F-12 and F-13 extend T-ACTION-09 and T-DUR-12. Add stop during VERIFYING and stop during a cooperative adapter.
- TH-03, TH-06, TH-08, TH-13, TH-14, TH-15, TH-16, and TH-17 stay PLANNED. Each must be re-rated here when its adapter lands, with a reproduction linked to its acceptance ID.

## Resolution log (integration owner, 2026-10-11)
All fixes are covered by `core/test/security/review-findings.test.ts`; each test was confirmed failing before its fix.

| Finding | Status | Fix |
|---|---|---|
| F-01 critical | FIXED | Every touched path (source and destination) is placed in `facts.file_paths` and checked by `decide()`. Tools declare `paths()`, which the broker checks lexically before any filesystem access. |
| F-02 high | FIXED | `trash_dir` removed from the model-facing schema. The destination is the OS Trash, or an owner/test service setting. |
| F-03 high | FIXED | A `verify` throw leads to RECONCILING, then reconcile, then UNRESOLVED. Recovery continues per attempt. The executor never leaves a task stranded in RUNNING. |
| F-04 high | FIXED | Planner postcondition paths must be inside the granted roots, checked both lexically and canonically. Verification reads are bounded to 16 MiB. |
| F-05 | FIXED | `redirect: 'error'` on the send and lookup fetches. |
| F-06 | FIXED | Lexical root pre-check before resolution, with a uniform denial message. |
| F-07 | FIXED | Patterns added for bearer/basic tokens, `sk-proj`/`svcacct`, PEM keys, URL credentials, cookies, Slack, Google and quoted passwords. |
| F-08 | FIXED | The dedup key uses a digest of the redacted text, not raw text. |
| F-09 | FIXED | The `core:` identity requires a per-process random `coreKey` held only by the in-process executor. |
| F-10 | MITIGATED | Non-idempotent effects on a target with an uncertain attempt are refused until reconciled. A deliberate new message to the same recipient after a committed one is still allowed and visible (residual). |
| F-11 | ACCEPTED-RESIDUAL | File contents read for planning are stored in the local DB. The data dir is 0700, files 0600, backups AES-256-GCM encrypted, and FileVault is recommended. The plaintext live DB is stated, not hidden. |
| F-12 | FIXED | A per-attempt AbortController. Stop/cancel aborts in-flight adapters and kills owned process groups (identity-checked). |
| F-13 | FIXED | VERIFYING and RECONCILING can move to PAUSED_BY_OWNER. Recovery under the latch keeps work paused. |
| F-14 | FIXED | Revoked grants cannot be re-put. Parent chains are validated (no cycles, depth ≤ 8). |
| F-15 | FIXED | Claim keys are case-folded (APFS is case-insensitive by default). |
| F-16 | FIXED | Open reservations count regardless of the period boundary. |
| F-17 | FIXED | 429 is a definite, retryable failure (not applied). |
| F-18 | FIXED | Compare-and-set claim on outbox rows. |
| F-19 | FIXED | Temp files are created 0600, the original mode is preserved on replace, and the own temp is removed during reconciliation. |
| F-20 | FIXED | Partial copy/move outcomes are reconciled as `unknown`, never as "not applied". |
| F-21 | FIXED | Waiters are keyed by task. Releasing a claim wakes WAITING_RESOURCE tasks. |

## Independent final audit (T-REL-09, 2026-10-12, audited commit 4c77ee8; re-reviewed at cffef3a and the commit that follows it)

An independent reviewer with a fresh context reran the non-live suites (104/104, evaluator 9/9 at 4c77ee8; 106/106 and 11/11 at cffef3a) and confirmed that the frozen manifest matches the handoff (36 requirements, 104 mandatory scenarios, gates unchanged). Verdict: not release-ready. Its findings and their resolution:

| ID | Severity | Finding | Resolution |
|---|---|---|---|
| A-01 | high | Measurements, reused logs and the artifact were not bound to the qualifying run | FIXED (after re-check). Live and spine measurements carry commit, tree state and time (`core/test/stamp.ts`). The cleanliness check excludes generated evidence (`release/results`, `artifacts`), so qualify's own output does not mark the tree dirty. Qualify ignores records from another commit, a dirty tree or an earlier run. The app seals `core/build-info.json`. The evaluator fails on artifact/commit mismatch, a dirty tree or reused logs |
| A-02 | high | System file-panel input could write outside the granted roots | MITIGATED (after re-check). (1) Input to a panel-service window is protected kind `file_panel_input`. (2) Keyboard input (`press_key`, `hotkey`, focused `type_text`) to a window whose AX tree (depth 2) shows an attached sheet is refused, whether or not the panel service is granted. Not covered, accepted as residual risk: Open/Save panels shown as separate windows rather than sheets; `type_text`/`set_value` with an element token pointing into a panel field mirrored in the host's AX tree; apps with in-process save panels. In all three cases an app the owner granted can save wherever that app itself can. Desktop grants are app-scoped, not path-scoped |
| A-03 | medium | The panel is matched by process name and geometry; the driver manifest allows every panel-service window | MITIGATED. A match must be unique (ambiguity fails closed). Input requires the A-02 protected grant |
| A-04 | medium | Pixel `x,y` had no upper bound | FIXED. Pixel input outside the observed window's bounds is refused before dispatch |
| A-05 | medium | `expect: [{window:{exists:true}}]` makes action verification trivially true | ACCEPTED (open for hardening). Task-level frozen success criteria are verified independently of action predicates; requiring an element/OCR predicate on every effectful action is planned |
| A-06 | medium | "Three consecutive runs" was measured within one test invocation, and failures were not kept | MITIGATED. Every live repetition is appended to `artifacts/live-history.jsonl` (pass and fail, with commit). Streaks across separate qualification runs are not yet enforced by the evaluator |
| A-07 | medium | `docs/testing-and-release.md` contradicted the code | FIXED in the same change |
| A-08 | low | Soak hash timing and summary trust | FIXED. The hash is taken before unpacking; every soak value, including pass/fail, is derived from the hashed report |
| A-09 | low | The fault hook ships in release builds | ACCEPTED. It is inert unless `BILLY_FAULT_POINTS` is set in the process environment; anyone able to set that can already kill the process |
| A-10 | medium | The evaluator accepted any independent review record, even one for an older commit | FIXED. A review must name `audited_commit`; it covers the candidate only if equal to it or if later commits change nothing but `release/reviews.json`, `release/findings.json` or `execution/ledger.json` (test in `evaluate.test.ts`) |

## Post-review remediation (2026-10-12, code review e33705c..309d3b2)

The two-axis review (Standards and Spec) found the following; resolutions are in commit 26d70b6 and later.

| ID | From | Finding | Resolution and evidence |
|---|---|---|---|
| A-02 | Spec 7, audit | Pixel/element/keyboard input could reach a file panel without `file_panel_input`. | **CLOSED, pending independent verification.** Authorization is now target-aware at the policy boundary (`core/src/desktop/surface.ts`, `core/src/tools/desktop/act.ts`). Each observation is classified as `app_window`, `file_panel` or `unverified` by one bounded AX probe. A file panel is any of: a panel-service window, an attached sheet, a location chooser, or a column file browser. That class sets the protected kind the policy engine checks, for all 13 input forms. Transitions: every input without an element token (pixel, focused, keys, menu) re-runs the probe immediately before dispatch, and a changed surface or geometry refuses input. Token input is bound by the driver to one element of the observed snapshot, so an element of a later sheet cannot be named. Re-probing before token input would invalidate the token, a defect found on the real Mac and now covered by a test. Keys never take a token. Unverifiable surfaces fail closed (`unverified_surface_input`). Evidence: `core/test/security/desktop-surface.test.ts` (adversarial suite, 14 tests at round 2; the fake driver invalidates tokens on re-snapshot like the real one). Mutation checks: disabling the protection fails 4 tests, disabling the recheck fails the transition test, and re-probing before token input fails 2 tests. |
| A-03 | Spec 6 | Panel matched by geometry only. | **CLOSED.** Ownership needs three facts: exactly one sheet in the host's own AX tree; a process whose executable is exactly the canonical panel service (`ps` comm, not a command-line pattern); and a service window whose frame equals the sheet's. Zero or several matches fail closed. Panel input also requires the host app grant. Same test file. |
| A-11 | design | Residual after A-02: a granted app's own *non-standard* file UI (no AX sheet, location chooser or column browser), or a file manager in list view, can move files wherever that app can. | ACCEPTED (medium). Desktop grants are app-scoped, as `docs/autonomy-and-policy.md` states; granting an app is granting what it can do. Standard file dialogs (sheets, location chooser, column browser, file sidebar, Cancel plus a file verb) are covered by A-02 and A-18; a custom file UI with none of that structure is this residual. |
| A-12 | Spec 4 | Findings could change after a review without re-review. | **CLOSED.** Reviews are fingerprinted (`release/evaluator/review.ts`): commit and tree, findings digest, manifest digest, critical-evidence digests. Only the review's own outputs and the build ledger may change afterwards; any other change, including findings, voids the approval. Evidence: `release/evaluator/evaluate.test.ts` (T-REL-09 tests). |
| A-13 | Spec 2 | T-REL-09 did not record what the reviewer reproduced. | **CLOSED.** A review must list reproduction runs: suite, command, commit, counts, scenario IDs, and the log digest under `release/reviews/<commit>/`. Every mandatory SECURITY and FAULT scenario must be reproduced with zero failures against the audited commit (`tools/reproduce.ts`). The PACKAGE test records who reproduced what, against which candidate, with what result. |
| A-14 | Spec 1 | T-MAC-05 never crossed applications. | Superseded by A-20 (two fixture applications, token/pixel/focused input). |
| A-15 | Standards (hard) | The live harness duplicated executor retry policy. | **CLOSED.** The harness retry was removed. "Did not become stably key" is now a retryable product failure; the executor is the only retry owner. |
| A-16 | Standards | Debug logging, duplicated constants and pathspecs, untyped facts, long multi-purpose act/observe, unclear names. | **CLOSED.** Debug hooks removed. Panel identity has one source (`core/src/desktop/panels.ts`, also used by the driver manifest). The tree-state check has one definition (`tools/git-state.ts`). `decide()` takes `ResolvedTarget['facts']`; the protected kinds are a typed union. The desktop tool is split into `common`, `launch`, `observe`, `act` and `verify` modules, with separate panel and window paths. The unclear names were renamed. |

## Post-review remediation, round 2 (2026-10-12, re-review of 309d3b2..999b204)

High and critical fixes are recorded as `closed` with `requires_verification: true`. The evaluator and the T-REL-09 package test treat them as **unresolved** until an approving, fingerprinted independent review lists them in `verified_findings` (`release/evaluator/review.ts`, `unresolvedFindings`). Pending: A-02, A-03, A-12, A-17, A-18.

| ID | From | Finding | Resolution and evidence |
|---|---|---|---|
| A-17 | Spec a1 | Reviews were not bound to the built artifact or acceptance results; source was read from the working tree. | Two-stage reviews. A **commit review** fingerprints the commit and tree, the findings and manifest, the critical reproduction logs, and the verified findings. An **acceptance attestation** (`tools/attest.ts`) fingerprints the artifact sha256 and the exact acceptance-result files. The evaluator requires both, reads reviews from `release/reviews.json` (no longer embedded in `results.json`, which was circular), and reads source at the candidate commit (`git show`). Tests: evaluator stage-1 and stage-2 cases. |
| A-18 | Spec a4 | Classification failed open: a standalone Open panel in list or icon view matched no marker, and truncated walks were trusted. | File-panel markers now include standard dialog structure (Cancel plus Open, Save, Choose, …) and a file sidebar. A walk cut short inside the window is `unverified` (fail closed). The driver's `elements_complete` flag is `false` even for fully returned walks, so coverage is proven from the walk itself: the window's rows (ancestry via `parent_index`) must form a contiguous prefix, followed by at least one row outside the window, such as the menu bar or a status item, with no window row after it. Otherwise the surface is `unverified`. The real driver was checked to report ancestry for every non-root row and to walk the window first and contiguously, on TextEdit and on Billy.app, whose status item is a separate root. The probe budget is the driver's default walk (2,000 elements) with no depth limit, because a depth cut would hide deep markers without being reported as truncation. A walk counts as complete only when the driver explicitly says so; an absent flag fails closed. Tests: 13 in `desktop-surface.test.ts`; mutation checks fail on both new rules. Real Mac: TextEdit and fixture windows classify as `app_window`. |
| A-19 | Spec a2 | T-REL-09 recorded counts, and independence was self-declared by the tool. | The T-REL-09 record lists reproduced scenario IDs, reviewer, independence basis, candidate commit, command, results and log digests. `tools/reproduce.ts` requires the reviewer's own `--independence-basis` and `--verdict`. A review without a stated basis, or with a non-approve verdict, never approves. |
| A-20 | Spec a3 | T-MAC-05 used one fixture app and only token input. | Two fixture apps (`com.billy.fixture`, `com.billy.fixture.b`) both show "Report.txt". Token, pixel and focused input are routed, with isolation checked after each step. Passed **one** development run on the real Mac (dirty tree, 999b204); the required three consecutive passes are only established by a candidate qualification run. |
| A-21 | Spec c2/c3 | Token binding was proven only in the fake; panel input was not re-classified. | New real-driver test: a token from a superseded snapshot is refused by the real Cua driver, with no effect. It passed one development run on the real Mac; it also checks the driver's walk order that the menu-bar coverage rule relies on. Panel input: a panel-service window is a file panel by identity, so what is re-established before input is **ownership** (the host still shows exactly that sheet, and the panel window still has its frame). Calling this "re-classification" was inaccurate. The target fingerprint includes pid and window id. |
| A-22 | Standards | Duplicated helpers, loose types, repeated action lists, pass-throughs, two names for one concept. | One git/tree source (`tools/git-state.ts`: tree state, tree of a commit, changed files, file at a commit); one SHA-256 (`review.ts`); one flag helper (`tools/cli.ts`); the reproduction command derived from the argv actually run; `ACTION_TRAITS`; `SurfaceKind`-typed live target; a named focus-contention predicate; typed predicates; verification from the resolved target (no database reach-in); one `Frame` type with converters; a shared observation builder; `surfaceKey` and the classifier parameter removed; a single `PANEL_SERVICE_BUNDLE` name. |

Scope notes (Spec b): every sheet is treated as a file-panel surface, including "save changes?" alerts, because a sheet can host a file panel and a false positive costs only an authority request. Finder's column view and sidebar are file-browser surfaces, so the Finder test (T-MAC-03) is granted `file_panel_input` explicitly, as any owner would need to grant it.

Round-2 re-review corrections (2026-10-12): fix verification for release now requires a review that passed **both** stages (a commit-only approval cannot verify a fix). An acceptance attestation covers `results.json`, which embeds every measurement value and the digest of every evidence log; the evaluator re-verifies those digests, so the attested results transitively bind the live evidence.

T-MAC-01 note (2026-10-12): Vision OCR reads Calculator's lone "0" as the letter "o" (50% confidence) and often not at all. The *cleared* precondition is therefore verified exactly through accessibility: Calculator labels its clear key "All Clear" only when the entry is cleared. The computed result "42" is still verified by on-device OCR of the display strip, whose region is now derived from the AX layout. OCR matching was not loosened.

## Independent review of 3eea94e (2026-10-12): REJECTED

A fresh-context reviewer reproduced 39 of the 40 critical scenarios (security 53/53, fault 38/38, integration 59/59, unit 5/5). It verified **A-03, A-12 and A-17** and rejected the commit (record in `release/reviews.json`, logs in `release/reviews/3eea94eaed67/`). A-02 and A-18 remain pending verification. Fixes:

| ID | Severity | Finding | Resolution and evidence |
|---|---|---|---|
| A-23 | high | Observation classified one AX walk but issued element tokens from a second walk. A sheet attaching in between was returned as an `app_window` observation whose tokens addressed the sheet's field: `set_value` of a path was committed without `file_panel_input`. | Fixed. An observation makes **one** walk; the classification and every token come from it, and the caller's query and depth only filter what is returned (`core/src/tools/desktop/observe.ts`). Test: "A-02 race" in `desktop-surface.test.ts` (exactly one host walk per observation; a sheet field never receives token input without authority). Pending independent verification. |
| A-24 | high | File-dialog markers were English labels only: a German Open panel classified as `app_window`. | Fixed. The primary evidence is AppKit's non-localized AX identifiers on Open/Save panels (`save-panel`, `open-panel`, `where popup`, `saveAsNameTextField`, `NS_OPEN_SAVE_*`), checked on the real panel. Labels remain secondary evidence. Test: "A-18 localization" (German panel → `file_panel`); a mutation without the identifier rule fails it. Pending independent verification. |
| A-25 | medium | The gate used `results.findings`, not the fingerprinted register; qualify assumed `[]` if the register was missing. | Fixed. The evaluator reads `release/findings.json` at the candidate and fails when the results disagree; qualify refuses to run without the register. Evaluator test added. |
| A-26 | medium | `tools/reproduce.ts` could never reproduce T-BOOT-02 (a mandatory FAULT scenario in the Python build-continuation suite), so no review could ever approve. | Fixed. `reproduce.ts` also runs the build-continuation suite and maps it to T-BOOT-02 and T-BOOT-06, as qualify does, keeping its log and digest. |

## Deep engineering audit (2026-10-13, baseline 9d0e6a7)

Scope: request -> inbox -> scheduler -> planner -> authority/budget -> broker -> adapters -> verification -> recovery/notification, plus daemon lifecycle, sandbox, desktop surface, release evaluator and packaging. Every fix has a regression test that fails on the pre-fix code (mutation-checked) unless noted. GUI, live-provider, phone and soak qualification were not run (owner deferral; no billed budget).

Process note for T-REL-09: review approval now requires an SSH signature by a principal in the owner's allowed-signers file (`BILLY_ALLOWED_SIGNERS`, outside the repository; sign with `tools/sign-review.ts`). No existing record is signed, so no review approves until the owner configures a trust root and an independent reviewer signs.

| ID | Severity | Finding | Status and evidence |
|---|---|---|---|
| A-27 | high | A model could complete a zero-action task by declaring, on its done turn, a criterion that was already true (A-05: action evidence vs the owner's goal). | **FIXED** (pending independent verification). done-turn criteria never freeze; completion needs an earned evidence strength (owner criteria, a frozen criterion false before the first effect and true now, or a read-only observation of this revision). Commit `0276fa3`. |
| A-28 | high | fs.write/fs.copy/fs.move followed a symlink swapped in after the checks (link()/copyfile() follow links), giving a workspace name to a file outside the grant. | **FIXED** (pending independent verification). no-follow descriptors, inode and parent-identity check after publish, undo on mismatch. Commit `92b4b80`. |
| A-29 | high | Background members of a sandboxed process group outlived a leader that exited normally (escaping timeout, Stop and the journal); a pipe holder hung the run. | **FIXED** (pending independent verification). group killed when the leader exits; bounded wait for pipe close (setsid escape remains, A-46). Commit `cf8ec31`. |
| A-30 | high | Resource waiters kept stale per-key queue positions, so two tasks could each head a queue the other needed (deadlock). | **FIXED** (pending independent verification). one ticket per waiter across all keys; abandoned keys dropped. Commit `71b0306`. |
| A-31 | high | Pause, cancel or revise during completion verification still completed or failed the task and sent a false 'Done' notice. | **FIXED** (pending independent verification). verification result dropped unless the task is still VERIFYING the same revision and generation; notices only for real transitions. Commit `da759ff`. |
| A-32 | high | Graceful stop orphaned the private Cua driver, and socket names restarted at cua-1.sock, so a surviving driver enforcing an older grant's manifest could be reused. | **FIXED** (pending independent verification). awaited bounded shutdown, per-launch socket/manifest names, startup retirement of stale drivers. Commit `279536b`. |
| A-33 | high | Focus-routed input (keys, focused typing, menus) could reach a file-panel sheet in another window of the same app; Finder list views classified as ordinary windows. | **FIXED** (pending independent verification). every window of the app is classified before focus-routed input; Finder is always a file-panel surface. Real-driver routing behaviour not live-verified (GUI tests deferred). Commit `4c13e8b`. |
| A-34 | high | Reviewer identity was free text (an implementer could write an approving review) and reproduction logs were fingerprinted but never parsed. | **FIXED** (pending independent verification). SSH signature from the owner's allowed-signers file (outside the repo) required; evaluator re-derives counts, scenario IDs and commit from each log. Commit `bd9bd3b`. |
| A-35 | medium | An empty or truncated API token file made the local API accept an empty or missing bearer. | **FIXED**. tokens under 32 characters are replaced and never match. Commit `e4c2679`. |
| A-36 | medium | After an owner revision the model could never act again (effects of the old revision blocked freezing criteria). | **FIXED**. only effects of the current revision count. Commit `0276fa3`. |
| A-37 | medium | Deterministic provider 4xx errors were retried on every availability wake. | **FIXED**. wait for configuration. Commit `0276fa3`. |
| A-38 | medium | Resume skipped the dependency gate; revise un-paused; restart never woke resource waiters or tasks left RECOVERING; daily budget waits never woke. | **FIXED**. Commit `5f7a28b`. |
| A-39 | medium | Phone /stop could be rate limited; Telegram notices with lost outcomes were dropped; unknown outcomes and lookup errors were unbounded or stalled delivery. | **FIXED**. Commit `e1a04ea`. |
| A-40 | medium | A corrupt store made launchd restart the daemon every 10 s without recording an incident. | **FIXED**. quarantine at startup, clean exit, KeepAlive SuccessfulExit=false. Commit `e4c2679`. |
| A-41 | medium | web.fetch missed mapped/compatible IPv6, CGNAT and other non-public ranges and re-resolved DNS at connect time (rebinding). | **FIXED**. BlockList classifier, connections pinned to vetted answers. Commit `3e118a5`. |
| A-42 | medium | An accepted (2xx) message send whose lookup lagged was FAILED, inviting a duplicate under a new key; response bodies uncapped. | **FIXED**. inconclusive -> keyed reconciliation; 64 KiB cap. Commit `61c1905`. |
| A-43 | medium | Children kept running after their parent was paused or failed. | **FIXED**. Commit `af96009`. |
| A-44 | medium | Non-streaming provider calls timed out at 120 s for 16k-token turns (billed, retried). | **FIXED**. streamed, 10-minute ceiling (offline SSE test only; no live provider run). Commit `aad5f33`. |
| A-45 | medium | Untrusted tool output could close the prompt's untrusted fence; memory reached the provider unredacted. | **FIXED**. Commit `e52dfb0`. |
| A-46 | medium | A sandboxed process that calls setsid leaves the owned group and survives Stop/timeout (macOS has no subreaper). | **ACCEPTED** (residual). The run no longer hangs on it; the escapee is not killed. Commit `cf8ec31`. |
| A-47 | medium | Review history was not ancestry-checked; an uncommitted reviews.json made the tree dirty. | **FIXED**. Commit `b5aa958`. |
| A-48 | medium | The driver pin did not validate the bundle seal (only the executable digest). | **FIXED**. codesign --verify --strict --deep. Commit `f98ac2e`. |
| A-49 | low | Workspace claim keys were case-sensitive on case-insensitive volumes. | **FIXED**. Commit `ef5a93e`. |
| A-50 | low | Packaged builds were always CFBundleVersion 1; notices ran from the working tree. | **FIXED**. Commit `57461b3`. |
| A-51 | low | Any settings save cleared the provider's retry-after backoff. | **FIXED**. Commit `c693c7b`. |
| A-52 | medium | Claims are not hierarchical: a proc.run workspace claim does not conflict with fs path claims inside that workspace. | **OPEN**. |
| A-53 | low | Refusal-fallback reservation does not cover multi-model iterations (latent: fallback is disabled in the daemon). | **OPEN**. |
| A-54 | low | Byte-reproducible packaging is unproven. | **OPEN**. |
