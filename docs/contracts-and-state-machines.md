# Contracts and state machines (as implemented)

Sources of truth:
- `core/src/contracts/action.ts`: envelope schema and `ToolSpec`
- `core/src/domain/machines.ts`: transition tables
- `core/src/broker/broker.ts`: admission sequence
- `core/src/scheduler/executor.ts`: verdict handling
- `core/src/store/schema.ts`: migrations

Line numbers refer to the files at the time of writing. Component context is in [architecture.md](architecture.md); authority and limits are in [autonomy-and-policy.md](autonomy-and-policy.md).

## 1. Action envelope (`ACTION_ENVELOPE_SCHEMA`, `ActionEnvelope`)

The broker builds the envelope in `Broker.submitInner` (`broker.ts:177-188`) and validates it before `decide` runs (`broker.ts:189-190`). Every field is required.

| Field | Type / bound | How it is filled today |
|---|---|---|
| `schema_version` | const `1` | constant |
| `action_id`, `attempt_id` | uuid | New per attempt. A retry reuses the first attempt's `action_id` (`broker.ts:260`). |
| `task_id` | uuid | proposal |
| `task_revision` | int 1..1e6 | proposal; must equal `tasks.revision` |
| `cancellation_generation` | int ≥ 0 | proposal; must equal `tasks.cancellation_generation` |
| `actor_id` | 1..512 chars | `core:<task_id>` + in-process `coreKey`, or `worker:<uuid>` + `worker_generation` |
| `tool_id` | `^[a-z][a-z0-9_.]{1,63}$` | registry |
| `tool_version` | int 1..1000 | registry (highest version if the proposal omits it) |
| `arguments` | object | Inline. The handoff's `arguments_ref` is not used. Arguments are validated against the tool's `input_schema` (`broker.ts:138-139`). |
| `arguments_digest` | sha256 | `digest(arguments)` (canonical JSON, `util/canon.ts`) |
| `target` | `{device_id, account_id \| null, resource_id}` | `ToolAdapter.resolve` |
| `authority` | `{grant_id, policy_revision, expires_at}` | Effective grant at submit time. A null-UUID placeholder is used when there is no grant, and `decide` then returns NEEDS_NEW_OWNER_AUTHORITY. |
| `effect_class` | `READ_ONLY \| IDEMPOTENT_WRITE \| NON_IDEMPOTENT_EFFECT` | `ToolSpec.effect_class` |
| `semantic_operation_id` | sha256 | See §5. |
| `idempotency_key` | null or 8..128 chars | Proposal (the executor never sets it). Providers use a key derived from the semantic id instead (§5). |
| `resource_claims` | ≤ 16 `{resource_key, mode}` | `resolve().claims` |
| `fencing_generation` | int ≥ 0 | `0` until `Claims.acquireAll` returns a generation (`broker.ts:249`) |
| `preconditions` | ≤ 16 conditions | Always `[]`. Precondition evidence goes into the AUTHORIZED transition's `evidence_json` (`broker.ts:265`). |
| `postconditions` | ≤ 16 conditions | Tool postconditions followed by planner postconditions. Planner postconditions never replace the tool's; their paths must be inside granted roots (`broker.ts:156-163`). |
| `observation_ref` | nullable | Proposal (desktop tools carry it in `arguments.observation_ref`) |
| `retry_policy_id` | `none \| read_transient \| idempotent_write` | Derived from `effect_class` (`broker.ts:186`) |
| `deadline_at` | nullable UTC | Proposal (the executor does not set it); checked at `broker.ts:146` |
| `budget_reservation_id` | uuid or `no-cost` | `Budget.reserve` (§3 of [autonomy-and-policy.md](autonomy-and-policy.md)) |
| `compensation_ref` | nullable | always `null` |

`CONDITION_SCHEMA` requires `kind` matching `^[a-z][a-z0-9_]{1,63}$` and allows only scalar extra fields.

## 2. Tool registry metadata (`ToolSpec`)

`ToolRegistry.register` rejects a duplicate `tool_id@version`. `get` returns the highest version when no version is given. An unknown tool is REJECTED before any target resolution (`broker.ts:136-137`). Required `ToolSpec` fields:
`tool_id`, `version`, `description`, `input_schema`, `output_schema`, `effect_class`, `tool_class` (matched against `grant.tool_classes`), `capabilities`, `target_kind`, `cancellation`, `timeout_ms`, `idempotency`, `verification`, `reconciliation`, `compensation`, `lock_class`, `egress`, `executable_identity`.

Registered tools (the default set is in `core.ts` plus `startDaemon` in `daemon/main.ts`):

| tool_id | effect | tool_class | claims (resource_key, mode) | verify / reconcile | egress |
|---|---|---|---|---|---|
| `fs.read`, `fs.stat` | READ_ONLY | file | `path:<lower(path)>` shared (read) | file digest | none |
| `fs.list` | READ_ONLY | file | — | — | none |
| `fs.write` | IDEMPOTENT_WRITE | file | `path:` exclusive | `verifyFileConditions` | none |
| `fs.copy` | IDEMPOTENT_WRITE | file | src shared, dst exclusive | `verifyFileConditions`; a partial result reconciles as unknown | none |
| `fs.move` | IDEMPOTENT_WRITE | file | src + dst exclusive | same | none |
| `fs.trash` | IDEMPOTENT_WRITE | file | `path:` exclusive | file conditions (moved to the user's Trash; never deleted) | none |
| `api.send_message` | NON_IDEMPOTENT_EFFECT | api.message | — (`lock_class` account) | provider lookup by `billy-<semantic id>` | cloud |
| `proc.run` | NON_IDEMPOTENT_EFFECT | process | `workspace:<path>` exclusive | exit observed / `processes` row; reconcile returns `unknown` if the process was spawned | none |
| `code.integrate` | IDEMPOTENT_WRITE | process | `integration:<repo>` + `workspace:<repo>` exclusive | git head + tests | none |
| `app.launch` | IDEMPOTENT_WRITE | app | — | pid lookup through Cua | local |
| `desktop.observe` | READ_ONLY | desktop | — | read-only | local |
| `desktop.act` | NON_IDEMPOTENT_EFFECT | desktop | `desktop:billy` exclusive | Cua `verify_state` predicates; unmet predicates reconcile as unknown | local |
| `agent.delegate` | IDEMPOTENT_WRITE | worker | — | `child_links` row for the semantic id | none |
| `agent.collect` | READ_ONLY | worker | — | read-only | none |
| `memory.search` | READ_ONLY | memory | — | read-only | none |
| `memory.note` | IDEMPOTENT_WRITE | memory | — | lookup by `source_ref=attempt:<id>` | none |
| `web.fetch` | READ_ONLY | web.read | — | read-only; every redirect hop is re-authorized | cloud |

The desktop tools are implemented; live qualification is pending (setup packet S3). `api.send_message` reads endpoints from `services.endpoints`, which `startDaemon` does not populate. In the shipped daemon the tool therefore resolves only in test harnesses.

## 3. Task state machine (`TASK_TRANSITIONS`)

There are 22 states. Terminal states: `COMPLETED`, `CANCELLED`, `FAILED` (`TASK_TERMINAL`). The six waiting states (`WAITING`) are `WAITING_DEPENDENCY`, `WAITING_RESOURCE`, `WAITING_PERMISSION`, `WAITING_BUDGET`, `WAITING_PROVIDER` and `WAITING_USER_SESSION`.

`Store.transitionTask` → `checkTask` refuses any pair not listed below (119 allowed transitions):

| From | Allowed targets |
|---|---|
| RECEIVED | PLANNING, BLOCKED_EXTERNAL, FAILED, WAITING_DEPENDENCY, WAITING_RESOURCE, WAITING_PERMISSION, WAITING_BUDGET, WAITING_PROVIDER, WAITING_USER_SESSION, PAUSED_BY_OWNER, CANCEL_REQUESTED |
| PLANNING | READY, BLOCKED_EXTERNAL, FAILED, VERIFYING, WAITING_DEPENDENCY, WAITING_RESOURCE, WAITING_PERMISSION, WAITING_BUDGET, WAITING_PROVIDER, WAITING_USER_SESSION, PAUSED_BY_OWNER, CANCEL_REQUESTED |
| READY | RUNNING, PLANNING, BLOCKED_EXTERNAL, WAITING_DEPENDENCY, WAITING_RESOURCE, WAITING_PERMISSION, WAITING_BUDGET, WAITING_PROVIDER, WAITING_USER_SESSION, PAUSED_BY_OWNER, CANCEL_REQUESTED |
| RUNNING | VERIFYING, PLANNING, RECOVERING, RECONCILING, FAILED, WAITING_DEPENDENCY, WAITING_RESOURCE, WAITING_PERMISSION, WAITING_BUDGET, WAITING_PROVIDER, WAITING_USER_SESSION, PAUSED_BY_OWNER, CANCEL_REQUESTED |
| VERIFYING | COMPLETED, READY, PLANNING, RECOVERING, RECONCILING, FAILED, CANCEL_REQUESTED, PAUSED_BY_OWNER, WAITING_DEPENDENCY |
| RECOVERING | READY, PLANNING, FAILED, BLOCKED_EXTERNAL, WAITING_DEPENDENCY, WAITING_RESOURCE, WAITING_PERMISSION, WAITING_BUDGET, WAITING_PROVIDER, WAITING_USER_SESSION, PAUSED_BY_OWNER, CANCEL_REQUESTED |
| RECONCILING | VERIFYING, READY, PLANNING, BLOCKED_EXTERNAL, CANCEL_REQUESTED, PAUSED_BY_OWNER |
| each of the six WAITING_* states | READY, PLANNING, FAILED, BLOCKED_EXTERNAL, PAUSED_BY_OWNER, CANCEL_REQUESTED |
| PAUSED_BY_OWNER | READY, PLANNING, CANCEL_REQUESTED |
| CANCEL_REQUESTED | CANCELLED |
| BLOCKED_EXTERNAL | READY, PLANNING, FAILED, CANCEL_REQUESTED, PAUSED_BY_OWNER |
| COMPLETED, CANCELLED, FAILED | — (none) |

Notes:
- `RUNNING` cannot go straight to `COMPLETED`. Completion is `RUNNING → VERIFYING → COMPLETED` in `Executor.complete`.
- `CANCEL_REQUESTED → CANCELLED` happens only in `Control.finalizeCancellations`, once no attempt is in PREPARED, DISPATCHING, OBSERVED_SUCCESS, OUTCOME_UNKNOWN or RECONCILING. The task result records committed, uncertain and stopped-before-dispatch counts, with the note "cancellation is not rollback".
- `Tasks.revise` refuses terminal tasks. `Control.revise` bumps the revision and the cancellation generation, then moves the task to `PLANNING` when that is legal.

### Waiting and blocked states and their wake conditions

`tasks.wait_condition` is set by `Executor` and cleared on wake. `Executor.wake(condition)` only scans `status LIKE 'WAITING_%'` (`executor.ts:88`).

| wait_condition | State | Set at (`executor.ts`) | What makes it runnable |
|---|---|---|---|
| `dependency_completed` | WAITING_DEPENDENCY | 78 (`admitNew`) | Re-checked on every `admitNew` pass (each tick) via `Tasks.dependenciesSatisfied` |
| `children_settled` | WAITING_DEPENDENCY | 244 (planner `blocked`), 342 (`complete` with pending children) | `wake('children_settled')` from `WorkerManager.supervise` (`workers.ts:177`) |
| `grant_changed` | WAITING_PERMISSION | 231 (gateway `egress`), 244, 301, 305 | `PUT /v1/policy` (`routes.ts:124`) |
| `budget_changed` | WAITING_BUDGET | 231 (gateway `budget`), 308 | `PUT /v1/budget` (`routes.ts:136`) |
| `provider_configured` | WAITING_PROVIDER | 231 (gateway `auth`/`config`) | `configureProvider` when a driver exists (`main.ts:87`) |
| `provider_available` | WAITING_PROVIDER | 231 (rate limit / unavailable), 244 | 30 s timer (`main.ts:199`) |
| `session_available` | WAITING_USER_SESSION | 244, 312 | 2 s timer when `arbiter.state()==='idle'` (`main.ts:198`) |
| `resource_released` | WAITING_RESOURCE | 315 | `Claims.releaseAll` → `Core` `onRelease` hook (`core.ts:72`) |
| `reconcile` | BLOCKED_EXTERNAL | 215, 319 | Only at startup: `Core.recover` moves the task to READY when no attempt is UNRESOLVED, RECONCILING or OUTCOME_UNKNOWN (`core.ts:109-113`). Otherwise the owner must resume. |
| `owner_input` | BLOCKED_EXTERNAL | 110 (internal error), 272 (recovery exhausted) | Owner resume (`Control.resume`) |
| `planner_available` | BLOCKED_EXTERNAL | 220 | Owner resume |
| `external` | BLOCKED_EXTERNAL | 244 (planner `blocked` with no wait kind) | Owner resume |

`PAUSED_BY_OWNER` has no wait condition. It leaves only through `Control.resume`, which refuses while the stop latch is set.

## 4. Action state machine (`ACTION_TRANSITIONS`)

There are 17 states and 27 allowed transitions. `ACTION_UNSETTLED` = DISPATCHING, OBSERVED_SUCCESS, OUTCOME_UNKNOWN, RECONCILING, UNRESOLVED. `ACTION_TERMINAL` = RETRY_ELIGIBLE, FAILED, COMMITTED, REJECTED, CANCELLED.

| From | Allowed targets | Driven by |
|---|---|---|
| PROPOSED | VALIDATED, REJECTED | `broker.ts:264`; REJECTED from `Broker.recover` (`broker.ts:427`) |
| VALIDATED | AUTHORIZED, REJECTED | `broker.ts:265`; recover `:427` |
| AUTHORIZED | PREPARED, REJECTED, CANCELLED | `broker.ts:266`; CANCELLED from recover `:432` (REJECTED is declared but not driven) |
| PREPARED | DISPATCHING, REJECTED, CANCELLED | `broker.ts:296`; CANCELLED on a stale recheck `:293`, by recover `:432`, or by `Executor.step` `executor.ts:209` |
| DISPATCHING | OBSERVED_SUCCESS, DEFINITE_FAILURE, OUTCOME_UNKNOWN | `broker.ts:314-316`; OUTCOME_UNKNOWN on an interrupted dispatch (`reconcileAttempt :375`) |
| OBSERVED_SUCCESS | VERIFIED, FAILED, RECONCILING | `settleVerification :350/:357/:360`; a verifier throw goes to RECONCILING (`:335`) |
| DEFINITE_FAILURE | RETRY_ELIGIBLE, FAILED | `broker.ts:322-325` (`retryable` flag) |
| OUTCOME_UNKNOWN | RECONCILING | `reconcileAttempt :376-378` |
| RECONCILING | VERIFIED, PROVEN_NOT_APPLIED, UNRESOLVED, FAILED | `reconcileAttempt :382-414` |
| PROVEN_NOT_APPLIED | RETRY_ELIGIBLE, FAILED | `:408-411` (FAILED is declared but not driven) |
| UNRESOLVED | RECONCILING | `reconcileAttempt :376` |
| VERIFIED | COMMITTED | `:350-353`, `:398-401` (same transaction) |
| RETRY_ELIGIBLE, FAILED, COMMITTED, REJECTED, CANCELLED | — | terminal |

`DISPATCHING` is committed before the adapter is called (step 8 below). A crash after that point is therefore always treated as possibly applied.

## 5. Broker sequence (handoff §8.3) mapped to `broker.ts`

| # | Step | Code |
|---|---|---|
| 1 | Authenticate the caller and bind it to the task and lease | `authenticate` `:109-119`, called at `:133-134`. `core:` identities need the per-process `coreKey` (F-09). Worker identities need a RUNNING row for the same task and an equal generation. |
| 2 | Validate tool, arguments, revision, cancellation generation, task RUNNING, stop latch, deadline | `:136-146`; envelope schema `:189-190` |
| 3 | Canonical target and authority scope | Lexical root check of `tool.paths()` before any filesystem access (F-06) `:150-154`; planner postcondition paths `:156-163`; `resolve` `:167-171`; `decide` `:191-196` |
| 3a | Dedup and quarantine against prior attempts of the same semantic operation | `:197-224` (rules below) |
| 4 | Refresh preconditions | `tool.preconditions` `:225-230`. A `wait` hint maps to WAIT_SESSION or WAIT_RESOURCE. |
| 5 | Budget reservation, then resource claims (sorted, all-or-nothing) | `:231-249`; the reservation is released if the claims fail |
| 6 | Persist PROPOSED → VALIDATED → AUTHORIZED → PREPARED in one transaction | `:252-273`; the `attempts_one_live` unique violation maps to UNRESOLVED |
| 7 | Recheck stop latch, task status, generation, revision, actor lease, `decide`, claim generation and target fingerprint | `:276-298`, in the same transaction as step 8. Failure → CANCELLED, with verdict STOPPED, DENIED or STALE (`:299-303`). |
| 8 | Persist DISPATCHING, then call the adapter once | `:296`, `:305-311`. An adapter throw is treated as `unknown`. |
| 9 | Record the outcome, receipt and uncertainty, and settle the budget | `:313-326` |
| 10 | Independent verification | `tool.verify` `:330-339` → `settleVerification` `:346-362`. An unknown outcome → `reconcileAttempt` `:365-416`. |
| 11 | Commit | Attempt VERIFIED → COMMITTED in one transaction (`:350-353`). The task transition is a **separate** transaction in `Executor.handleVerdict` (`executor.ts:286-330`). |
| 12 | Notifications, claim release, next work | Claims released in `finally` (`:340-343`). Notifications go through `Core.notify` → `Outbox.enqueue` (from the executor). The next step comes from the executor loop. |

Startup recovery (`Core.recover`):
1. `Broker.recover` rejects PROPOSED and VALIDATED attempts and cancels AUTHORIZED and PREPARED ones. It reconciles every DISPATCHING, OBSERVED_SUCCESS, OUTCOME_UNKNOWN or RECONCILING attempt independently, so one failure does not abort recovery (F-03).
2. `Claims.clearAll` runs.
3. Workers in STARTING or RUNNING are marked LOST.
4. `Outbox.recover` moves SENDING rows to UNKNOWN.
5. Tasks in RUNNING or VERIFYING go to RECOVERING and then to READY. They go to PAUSED_BY_OWNER instead if the stop latch is set.
6. RECONCILING tasks move the same way.
7. Settled `reconcile` blocks are released.
8. `finalizeCancellations` runs.

### Semantic operation identity

```text
semantic_operation_id = sha256(canonical({ task_id, step_key, tool_id, resource_id, args: sha256(canonical(arguments)) }))   // broker.ts:174
```

The identity is per task and independent of `task_revision`. A revised goal therefore sees, and deduplicates against, effects already made under earlier revisions. Child tasks have their own `task_id`. `step_key` is planner-chosen: `ModelPlanner` restricts it to `^[A-Za-z0-9._:-]{1,80}$`. The provider idempotency key is `billy-<semantic_operation_id>` (`tools/api.ts` `keyFor`), so every attempt of one intended effect carries the same key.

### Dedup and quarantine rules (`broker.ts:197-224`, in order)

1. A prior attempt is COMMITTED → `DEDUPLICATED`, returning the stored receipt and evidence. There is no second effect.
2. A prior attempt is not in {RETRY_ELIGIBLE, FAILED, REJECTED, CANCELLED} → `UNRESOLVED` ("reconcile first").
3. NON_IDEMPOTENT_EFFECT: any attempt in the same task with the same tool and `resource_id` that is DISPATCHING, OBSERVED_SUCCESS, OUTCOME_UNKNOWN, RECONCILING or UNRESOLVED → `UNRESOLVED` (F-10: a reworded duplicate cannot start while one is uncertain).
4. A prior attempt is FAILED → `FAILED` (the operation is definitively failed; the planner must choose a different operation).
5. Three or more prior attempts → `FAILED` (`MAX_ATTEMPTS_PER_OPERATION = 3`).
6. `retry_policy_id = 'none'` with prior attempts: allowed only if the last attempt was CANCELLED or REJECTED (never dispatched) or has a recorded PROVEN_NOT_APPLIED or DEFINITE_FAILURE transition. Otherwise → `UNRESOLVED`.
7. Database backstop: the partial unique index `attempts_one_live` (schema v1) allows at most one non-terminal attempt per semantic id.

## 6. Verdict → task state (`Executor.step` / `handleVerdict`)

| Broker verdict | Executor action | Resulting task state (wait_condition) |
|---|---|---|
| COMMITTED, DEDUPLICATED | continue | RUNNING (next step) |
| RETRY_ELIGIBLE | retry the same step after `50 ms × n`. After `LIMITS.retriesPerStep` (3), replan. | RUNNING |
| FAILED, REJECTED, DENIED | Replan. The failure signature `sha256({tool, args, err-without-uuids})` is counted in `step_failures`. At ≥ 3 (`equivalentFailures`), `plans.replans` increments. If replans is already ≥ 2 → RECOVERING → BLOCKED_EXTERNAL (`owner_input`). | RECOVERING → READY → RUNNING |
| REJECTED with reason `authentication:` | stop; no transition (a fenced worker never acts) | unchanged |
| NEEDS_AUTHORITY | notify `needs_authority` | WAITING_PERMISSION (`grant_changed`) |
| WAIT_PREREQUISITE | — | WAITING_PERMISSION (`grant_changed`) |
| WAIT_BUDGET | notify `budget` | WAITING_BUDGET (`budget_changed`) |
| WAIT_SESSION | — | WAITING_USER_SESSION (`session_available`) |
| WAIT_RESOURCE | — | WAITING_RESOURCE (`resource_released`) |
| UNRESOLVED | notify `uncertain` | RECONCILING → BLOCKED_EXTERNAL (`reconcile`) |
| STALE | replan on the new revision | PLANNING if still RUNNING |
| STOPPED | stop | unchanged (Control already paused the task) |

Planner outcomes:
- **`done`** → `Executor.complete`. The task goes to VERIFYING. If children are pending → WAITING_DEPENDENCY (`children_settled`). If the verifier passes, no attempt is unresolved and every child is COMPLETED → COMPLETED. Otherwise, if replans < 2 → RECOVERING → READY (replans+1); else FAILED.
- **`blocked`** → the declared wait state, or BLOCKED_EXTERNAL.
- **`fail`** → FAILED.
- **Planner throws:** `ProviderWait` kinds map to WAITING_BUDGET, WAITING_PERMISSION or WAITING_PROVIDER (`executor.ts:226-234`).
- **More than 200 steps** (`maxStepsPerTask`) → FAILED.
- Before any planning, unsettled attempts are reconciled. Any attempt still uncertain → RECONCILING → BLOCKED_EXTERNAL (`reconcile`) (`executor.ts:203-217`).

## 7. Schema migrations (`core/src/store/schema.ts`)

`Store.migrate` applies each migration once, inside a transaction, and records `sha256(sql)` in `schema_migrations`. If an applied version's digest differs, or the database has a version this build does not know, open fails with `CompatibilityError`. `PRAGMA quick_check` runs before migration, and a failure is a `CorruptionError` (`Store.integrityGate`).

| Version | Name | Adds |
|---|---|---|
| v1 | `core-domains` | `meta`, `stop_latch`, `grants`, `tasks`, `task_revisions`, `task_edges`, `attempts` (+ `attempts_one_live`), `events`, `inbox`, `outbox`, `resource_claims`, `resource_generations`, `resource_waiters`, `workers`, `budgets`, `budget_entries`, `evidence`, `memory`, `memory_fts` (FTS5), `memory_tombstones`, `devices`, `pairing_challenges`, `plans`, `step_failures`, `processes` |
| v2 | `workers-and-delegation` | `tasks.driver` (default `'core'`), `workers.token_digest`, `workers.pgid`, `child_links` (unique per semantic id and per child) |
| v3 | `owner-schedules` | `schedules` (`once` / `interval` ≥ 60 s, UTC instants, display timezone) |

Rollback means restoring a pre-upgrade backup (`BackupManager.restore`). There are no down-migrations.
