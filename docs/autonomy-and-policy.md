# Autonomy, authority and limits (as implemented)

This document covers what Billy may do without asking, what bounds it, and what can never widen its authority. The admission mechanics (broker steps, dedup, verdict mapping) are in [contracts-and-state-machines.md](contracts-and-state-machines.md). Threats are in [threat-and-failure-register.md](threat-and-failure-register.md).

Live status: real model calls, native desktop input and the phone path are **implemented; live qualification pending (setup packet S1–S5)**.

## 1. Grants

A grant is a row in `grants` keyed by `(grant_id, revision)` (`PolicyStore`, `core/src/policy/policy.ts`). It carries:
- `owner_id`, `scope` (`GrantScope`, validated by `GRANT_SCOPE_SCHEMA`) and `scope_digest`
- `parent_grant_id`, `task_id`
- `expires_at`, `revoked_at` and `source`

Only two code paths write grants:

| Writer | Path | Effect |
|---|---|---|
| Owner | `PUT /v1/policy` (`core/src/daemon/routes.ts`), from Billy.app or the local API with the bearer token | `putGrant` on `cfg.default_grant_id`: a new revision (or a new grant on first save). Requires a future `expires_at`. Wakes `grant_changed`. |
| Delegation | `WorkerManager.delegate` (`core/src/agents/workers.ts`) | New child grant = `intersectScope(parent effective scope, request)`, with `parent_grant_id` set and the parent's `expires_at` |

`putGrant` refuses to re-activate a revoked grant (F-14) and rejects parent cycles and chains deeper than 8. `PolicyStore.revoke` cascades to descendant grants, but no owner route calls it yet. Today an owner narrows authority by saving a new revision.

### Scope fields and where they are enforced

| Field | Meaning | Enforced at |
|---|---|---|
| `tool_classes` | Tool classes allowed | `decide` (missing → NEEDS_NEW_OWNER_AUTHORITY). The planner's tool catalog is filtered too (`ModelPlanner.toolCatalog`). |
| `allowed_effects` | READ_ONLY / IDEMPOTENT_WRITE / NON_IDEMPOTENT_EFFECT | `decide` (missing → NEEDS_NEW_OWNER_AUTHORITY) and the planner catalog |
| `file_roots` | Absolute directories | Lexical pre-check in the broker (step 3). `decide` requires every `file_path` / `file_paths` to be inside a root. Planner postcondition paths are checked lexically and canonically. The Cua manifest's `files` are derived from the roots. |
| `apps` | Bundle identifiers | `decide` (`resolved.app`, used by the desktop tools); Cua manifest `resources.apps` |
| `domains` | Exact host or `*.suffix` (`domainMatches`) | `decide` (`resolved.host`); `web.fetch` re-checks every redirect hop |
| `network_destinations` | `host[:port]` | `decide`; `web.fetch` requires an explicit entry for private or loopback addresses |
| `account_ids` | Account identities | `decide` (`resolved.account_id`) |
| `recipients` | `<endpoint>:<account>:<to>`. `"*"` = any. Absent = none. | `decide` (`resolved.recipient`, set by `api.send_message`) |
| `model_egress` | Provider ids that may receive task content | `ModelGateway.complete` (`provider not authorized` → WAITING_PERMISSION). The list comes from `cfg.default_grant_id` (`daemon/main.ts`, `egress`), not from the task's own grant. |
| `foreground` | `never` / `when_idle` / `allowed` | `DesktopArbiter.mayInput` in `desktop.act` preconditions and again at dispatch. Read from `cfg.default_grant_id` (`DesktopServices.foreground`). |
| `delegation` | `{allowed, max_depth 0..5}` | `WorkerManager.delegate`; each child gets `max_depth - 1` |
| `spend_scopes` | Budget scopes a tool may charge | `decide`, only when an adapter sets `facts.spend_scope`. No registered adapter does. |
| `protected_actions` | Explicitly allowed protected kinds (default none) | `decide`, only when an adapter sets `facts.protected_kind`. No registered adapter does. |
| `secret_references`, `browser_profiles` | — | Stored and intersected, but not enforced by `decide` (no adapter consumes them) |

`ToolSpec.capabilities` is declared metadata only; `decide` does not check it.

### Child intersection rules (`intersectScope`)

- List fields (`apps`, `browser_profiles`, `account_ids`, `tool_classes`, `allowed_effects`, `secret_references`, `network_destinations`, `spend_scopes`, `protected_actions`, `model_egress`): set intersection.
- `file_roots`: a requested root is kept only if it equals a parent root or lies under one.
- `domains`: a requested domain is kept only if a parent pattern matches it. A requested wildcard needs a wildcard parent. Note that `*.x` under an identical `*.x` is a known false deny.
- `foreground`: the lower of the two ranks (`never` < `when_idle` < `allowed`).
- `delegation`: `allowed = req ∧ parent ∧ parent.max_depth > 0`; `max_depth = min(req, parent − 1)`, floored at 0.
- `recipients`: a parent `"*"` yields the request; a requested `"*"` yields the parent; otherwise the intersection. A request with no recipients inherits the parent's.
- `PolicyStore.effective` re-applies the intersection along the whole parent chain at every read (depth ≤ 8). `expires_at` is the earliest in the chain. A revoked or missing ancestor makes the grant invalid.

`WorkerManager.delegate` starts the request from the parent scope, overrides only `file_roots`, `tool_classes` and `apps` (the `agent.delegate` arguments), and defaults `delegation` to `{allowed:false, max_depth:0}`. The child task inherits the parent's `budget_scope`, so delegation never adds budget.

### Decision outcomes (`decide`, evaluated in this order)

| Check | Outcome |
|---|---|
| No valid grant (missing, revoked or superseded) | NEEDS_NEW_OWNER_AUTHORITY |
| `env.authority.policy_revision` ≠ current revision | DENY (stale revision) |
| Expired | NEEDS_NEW_OWNER_AUTHORITY |
| Tool class not granted | NEEDS_NEW_OWNER_AUTHORITY |
| Effect class not granted | NEEDS_NEW_OWNER_AUTHORITY |
| `protected_kind` not allowed | DENY |
| Path outside roots | DENY |
| App, host, recipient or account not granted | DENY |
| `egress_provider` not allowed | DENY |
| `spend_scope` not in the grant | WAIT_PREREQUISITE |
| otherwise | ALLOW |

The broker maps DENY → `DENIED` (the executor replans), NEEDS_NEW_OWNER_AUTHORITY → `NEEDS_AUTHORITY` (WAITING_PERMISSION) and WAIT_PREREQUISITE → WAITING_PERMISSION. Every refusal writes a `broker/refused` or `policy/decision` event.

### Revision and revocation at dispatch

The envelope binds the grant revision that was current at submit time. Broker step 7 runs `decide` again against the current effective grant, in the same transaction that persists DISPATCHING (`broker.ts:276-298`). A new revision, an expiry or a revocation between submit and dispatch therefore cancels the attempt before any effect, with verdict `DENIED` ("authority changed"). The next submission is evaluated against the new state. No action is queued outside the broker, so every new step is evaluated afresh. `Control.cancel` also fences the cancelled tasks' workers (FENCED), and the broker then refuses their identity.

## 2. Budget

Ledger: `budgets` (ceilings) plus append-only `budget_entries` (`Budget`, `core/src/budget/budget.ts`). Amounts are integer micro-USD.

- **Ceilings:** set only by the owner (`PUT /v1/budget` → `Budget.setCeiling`, period `total` or `daily`; daily resets at UTC midnight of the store clock). Source code contains no default ceiling. With no ceiling, any chargeable admission raises `BudgetWait('no explicit ceiling configured')`. This is setup packet S2.
- **Committed amount** = open reservations (RESERVE − RELEASE, regardless of period, per F-16) + ACTUAL + UNCERTAIN in the current period.
- **Reservation:** `reserve(scopes, estimate, ref)` checks every scope and writes RESERVE rows in one transaction. It succeeds for all scopes or none.
- **Settlement:** `settle(id, actual | 'unknown')` writes RELEASE plus ACTUAL. For `'unknown'` it writes UNCERTAIN equal to the full reservation. It is idempotent.

Scopes actually used:

| Path | Scope(s) reserved | Estimate |
|---|---|---|
| Model calls (`ModelGateway.complete`) | `[task.budget_scope]` (`ModelPlanner.next`). Owner tasks get `cfg.provider.budget_scope` (default `provider-total`, `admitOwnerCommand`). Children inherit the parent's. | `ceil(chars/2.5 × in_price + max_tokens × out_price)` at the worst-case price (§3) |
| Tool actions (`Broker.submitInner` step 5) | `facts.spend_scope` or `task.budget_scope` | `ToolAdapter.estimateMicros`. No registered tool implements it, so tool actions are `no-cost`. |

Separate daily, provider and release-qualification scopes are not reserved together yet: each call reserves exactly one scope.

Uncertain spend:
- Gateway: a provider error with 4xx status other than 408, 409 or 429 settles 0. Any other error, including network errors, settles `'unknown'` (UNCERTAIN).
- Broker: `unknown` outcomes settle `'unknown'`; failures settle 0; success settles the reported usage, or the estimate if none is reported.

## 3. Model gateway

The gateway (`core/src/ai/gateway.ts`) is the only path to a provider. `ModelGateway.complete` admits a call in this order:
1. Stop latch set → `ProviderWait('stopped')`.
2. No driver → `ProviderWait('config')`.
3. `grant_egress` must include `driver.id` → else `ProviderWait('egress')`.
4. Resolve the model: `cfg.roles[role]`, falling back to `cfg.roles.planner`.
5. The model must have a known price → else `ProviderWait('config')`.
6. Provider backoff window active → `ProviderWait('rate_limited')`.
7. Estimate and reserve the budget → `BudgetWait` becomes `ProviderWait('budget')`.
8. Write a `model_call/dispatching` event (role, model, estimate, request digest), then call the driver.
9. On error:
   - settle 0 or UNCERTAIN as in §2
   - set backoff (`retry-after`, else `2 s × 2^n`, at most 15 min) for 429, 529, 5xx and network errors
   - map 401/403 → `auth` and 429 → `rate_limited`, anything else → `unavailable`
10. On success: price each `usage_by_model` entry. An unknown model is priced at the worst-case rate. Settle, then write `model_call/completed`.
11. `stop_reason` of `refusal` or `max_tokens`, or non-JSON output → `ProviderOutputError` (already billed).

`AnthropicDriver` (`core/src/ai/anthropic.ts`) uses the official SDK with `maxRetries: 0`, a cached system prompt, adaptive thinking and JSON-schema output. With `refusalFallback` (always on in `startDaemon`) it sends the `server-side-fallback-2026-07-01` beta. For that reason reservations use the worst-case price.

Roles: the `Role` type lists `planner`, `general_executor`, `visual_reasoner`, `coding_builder`, `reviewer`, `summarizer` and `fallback`. `startDaemon` configures only `planner` and `fallback`, both set to `cfg.provider.planner_model ?? 'claude-opus-5-5'`. The only role code calls today is `planner` (`ModelPlanner`, `effort: 'medium'`, `max_tokens: 16000`). Other roles would resolve to the planner model. `POST /v1/provider/discover` checks the configured role models against the account's `listModels()` and `PRICES`.

Prices (`PRICES`, "Anthropic first-party list prices, cached 2026-10-06"; µUSD per token = USD per million tokens):

| Model | Input | Output | Cache read | Cache write |
|---|---|---|---|---|
| claude-opus-5-5 | 4 | 20 | 0.2 | 5 |
| claude-sonnet-5-5 | 2 | 10 | 0.2 | 2.5 |
| claude-haiku-5-5 | 0.1 | 0.5 | 0.01 | 0.125 |
| claude-fable-5-1 (worst case `WORST`) | 10 | 50 | 0.25 | 12.5 |
| claude-opus-5 | 5 | 25 | 0.5 | 6.25 |
| claude-opus-4-8 | 5 | 25 | 0.5 | 6.25 |

Provider-live behaviour is implemented; live qualification is pending (S1 credential, S2 ceiling). The `claude_cli` provider kind exists in the config schema, but `PUT /v1/provider` rejects it and no driver implements it.

## 4. Retry and loop bounds

| Bound | Value | Scope / persistence | Code |
|---|---|---|---|
| Attempts per semantic operation | 3 | persistent (counted from `attempts`) | `MAX_ATTEMPTS_PER_OPERATION`, `broker.ts` |
| Retries of a RETRY_ELIGIBLE step | 3 (`retriesPerStep`), backoff `50 ms × n` with no jitter | in-memory per task run | `LIMITS`, `Executor.step` |
| Equivalent failures before a strategy counts as exhausted | 3 (`equivalentFailures`), keyed by `sha256({tool, args, error})` | persistent (`step_failures`) | `Executor.step` |
| Materially different replans | 2 (`replans`); a third exhausted strategy → BLOCKED_EXTERNAL (`owner_input`) and the owner is told | persistent (`plans.replans`), shared with failed completion checks | `Executor.step`, `Executor.complete` |
| Steps per task | 200 (`maxStepsPerTask`) → FAILED | in-memory, reset when the task leaves RUNNING | `Executor.step` |
| Structured repair of invalid model output | 2 repairs (3 calls); then `blocked` WAITING_PROVIDER | per planner call | `ModelPlanner.next` (`maxRepairs`) |
| Non-idempotent retry | only after proof of non-application, or if never dispatched | persistent | broker rule 6 |
| Provider backoff | `retry-after`, else `2 s × 2^n` ≤ 15 min | in-memory | `ModelGateway` |
| Outbox delivery | 8 attempts, backoff `2 s × 2^n` ≤ 30 min. An UNKNOWN delivery on a channel without `lookup` becomes FAILED, never a blind resend. | persistent | `Outbox` |
| Telegram polling | backoff 1 s → 60 s, or `retry_after` | in-memory | `TelegramRemote.run` |
| Worker lease | 5 s lease, 1 s heartbeat, at most 3 workers | persistent rows plus monotonic beats | `DEFAULT_WORKERS` |
| Executor concurrency | 2 core-driven tasks | — | `startDaemon` (`maxConcurrent: 2`) |
| Claim TTL | 10 min, recorded but not enforced (`stillHeld` ignores `expires_at`). Claims are cleared at startup. | — | `Claims` |

Liveness signals (timers, heartbeats) are separate from progress signals (`step_failures`, replans, committed attempts).

## 5. Human coexistence (desktop arbiter)

Implemented in `DesktopArbiter` (`core/src/desktop/session.ts`); live qualification pending (S3, S6). `DEFAULT_ARBITER` sets `activeWindowMs 1500`, `resumeIdleMs 5000`, `selfEchoMs 250` and `pollMs 100`.

- **Session facts** come only from the OS: HID idle time (`ioreg IOHIDSystem`), console lock state and the frontmost bundle (`lsappinfo`).
- **Owner state:** `locked`; `active` when HID idle < 1.5 s and the activity is not Billy's own injected input (±250 ms of `noteSelfInput`); otherwise `idle`.
- **Input gate (`mayInput`):**
  - locked → refuse (WAIT_SESSION)
  - owner active → refuse (WAIT_RESOURCE)
  - a `needs_foreground` action under `foreground: never` → refuse
  - a `needs_foreground` action under `when_idle` → refuse until 5 s of idle
  - The gate is checked in `desktop.act` preconditions and again immediately before the driver call.
- **Takeover:** each 100 ms tick that sees a non-idle state or a frontmost-app change increments `epoch`. `startDaemon` then clears all observations. `desktop.act` refuses an observation from an older epoch or driver generation, or one older than 30 s (`OBSERVATION_TTL_MS`). Each observation allows one action, so Billy must re-observe before resuming.
- **Exclusivity:** `desktop.act` holds the exclusive `desktop:billy` claim. Only the private bounded Cua daemon is used.
- **Waking:** WAITING_USER_SESSION tasks are woken every 2 s while the arbiter is idle (`main.ts`). An owner-active refusal maps to WAITING_RESOURCE, which wakes only on a claim release.

### Input-surface authorization (A-02, A-03)

Desktop authority is target-aware. A grant names apps, and each input is also checked against the **surface** it reaches.

| Surface | How it is recognised (`core/src/desktop/surface.ts`) | Protected kind the grant must list |
|---|---|---|
| `app_window` | An ordinary window of a granted app | none |
| `file_panel` | One of: a system Open/Save panel-service window; an attached sheet; a save-panel location chooser ("Where:"); a column file browser | `file_panel_input` |
| `unverified` | The window has no accessibility surface, so its identity cannot be established | `unverified_surface_input` |

Rules:
- **Applies to every input method.** Element-token, pixel, focused, key, hotkey, scroll and menu input are all classified the same way, because the classification belongs to the observation, not to the input method.
- **Re-verified before dispatch.** Input without an element token (pixel, focused, keys, menu) is routed by the system at delivery time. For that input the same bounded probe runs again immediately before dispatch. If the surface kind, the window geometry (for pixel input), or the host sheet and panel window (for a panel) changed, input is refused and the planner must observe again.
- **Token input stays bound.** Input with an element token is bound by the driver to one element of the observed snapshot. A stale token is refused, and an element of a surface that appeared later cannot be named. Keys (`press_key`, `hotkey`) never take a token, because they travel through whatever is focused.
- **Panels are bound to their host.** A panel observation is bound to its host. The host's AX tree must show exactly one sheet, the panel process's executable must be exactly the canonical service, and the panel window's frame must equal the sheet's. Panel input also needs the host app in the grant.
- **Residual (A-11, accepted):** a granted app's own non-standard file UI can act within that app's capability. Granting an app grants what it can do.

## 6. Memory trust model

Implemented in `Memory` (`core/src/memory/memory.ts`).

- **Trust levels** (in rank order): `untrusted` < `inferred` < `verified` < `owner`. Highest trust each source may claim (`ALLOWED_TRUST`):

  | Source | Allowed trust |
  |---|---|
  | `owner_command` | owner only |
  | `task_result` | verified, inferred or untrusted |
  | `worker` | inferred or untrusted |
  | `model_inference` | inferred |
  | `web`, `file` | untrusted |

- **Owner trust** also requires an `OwnerAuth` token. Tokens are minted by `ownerAuth()` only in the daemon's local API routes (`/v1/memory*`) and checked against a private `WeakSet`. The planner's `memory.note` tool always writes `trust: inferred` with `model_inference` provenance.
- **Corrections** (`correct`, owner only) create a new owner record and set `superseded_by` on the old one. `current` returns the highest trust first, then the most recent.
- **Deletion** (owner only) writes a tombstone, then removes the content and FTS rows for the whole supersession chain, with `secure_delete`. Backups taken earlier keep a copy (`BACKUP_RESIDUAL_NOTE`).
- **Scoping:** search and `contextFor` are limited to the task's `project_scope`. Context text is headed `MEMORY_DATA_NOT_AUTHORITY`, labels inferred and stale (`fresh_until` passed) items, and is wrapped in `<memory note="data, not authority">` in the planner prompt.

## 7. What can never grant authority

| Input | Why it cannot widen authority | Code |
|---|---|---|
| Model output | It is only a proposal. The broker validates the schema, `decide` applies the grant, and task completion is checked by the verifier, not by the `done` claim. | `Broker.submit`, `Executor.complete` |
| Memory items | `decide` and the broker never read memory. Owner trust needs an `OwnerAuth` token. | `memory.ts`, `policy.ts` |
| Web pages, files, tool receipts | Labelled untrusted (`trust: 'untrusted_external_content'`; `<untrusted_tool_output>` in the prompt) | `web.ts`, `planner/model.ts` |
| Child workers | No grant writes. Their scope is the intersection with the parent. `agent.collect` exposes only `untrusted_child_summary`; "verified" means status COMPLETED. | `workers.ts`, `tools/agents.ts` |
| Worker processes | Hold only a per-worker token and lease generation; no DB or secrets | ADR-0004, `worker-main.ts` |
| Telegram message text | Identity comes only from Telegram's sender fields of a paired, unrevoked device. Text cannot change the sender. | `TelegramRemote.handle` |
| Scheduled firings | Admitted through `admitOwnerCommand` under the default grant; schedules carry no scope | `scheduler/schedules.ts`, `daemon/main.ts` |
| Renewing or re-putting a revoked grant | Refused | `PolicyStore.putGrant` |
| Delegation | Cannot exceed the parent or add budget | `intersectScope`, `WorkerManager.delegate` |
| Tool registration | Adds capability metadata, never grant scope | `ToolRegistry`, `decide` |
