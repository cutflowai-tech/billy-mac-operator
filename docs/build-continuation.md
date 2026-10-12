# Development runtime continuation (REQ-02, T-BOOT-02, T-BOOT-06)

## Actual runtime
- Lead: Claude Code inside the Claude desktop app (Code tab), one owner-facing conversation.
- Delegation: in-session background sub-agents (Agent tool); they re-invoke the lead on completion.
- Context rollover: the runtime compacts the lead's context automatically; the lead must reconstruct
  from `execution/ledger.json` (`billy-dev brief`), never from the owner.
- Session-scoped timers: `CronCreate` (in-memory, dies with the session).
- Cross-session continuation: desktop-app "scheduled tasks" (file-backed under `~/.claude/scheduled-tasks`,
  fresh context each run) — **run only while the desktop app is open**.

## Local supervisor (implemented, tested)
`tools/billy_dev` — authoritative JSON ledger written atomically (tmp+fsync+rename+dir fsync) under flock.
The supervisor is the single owner of readiness/lease/retry; workers run one admitted step under a lease
generation; worker success is a *proposal* verified against a postcondition recorded before launch.

## Proof executed (`python3 -I tests/boot/test_build_continuation.py`)
| Scenario | Result |
|---|---|
| Worker SIGKILLed after its effect, before reporting | Reconciled from postcondition; step not re-run; effects log shows exactly one execution per step |
| Worker SIGKILLed before its effect | Requeued with same task id, lease generation 2, attempt 2 |
| Lead supervisor + worker SIGKILLed (process group) mid-step | New supervisor process (different pid) rebuilt state only from ledger, recovered fx-2, completed fx-3 |
| Dependent phase readiness | `auto_progression` events promote dependents with no owner message; an unrelated BLOCKED_EXTERNAL task stays blocked without blocking the chain |
| Illegal ledger transition | Rejected; state unchanged |

## Limitations (truthful)
- `BUILD_RUNTIME_PARTIALLY_DURABLE`: continuation survives worker loss, lead-process loss and context
  compaction **while the Claude desktop app is running**. Nothing in this runtime executes while the app
  is closed or the Mac is off/asleep. No OS-level launchd job was installed for the development runtime
  (would be a persistent system change and would consume the owner's Claude usage unattended).
