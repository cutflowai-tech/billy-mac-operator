# ADR-0004: Leased worker processes drive child tasks through the core

Status: Accepted (2026-10-11) · REQ-19, REQ-20, REQ-35 · Tests: core/test/fault/agents.test.ts

## Decision
Child tasks (`driver='worker'`) are driven by separate OS processes (`core/src/agents/worker-main.ts`).

- **Worker capability:** each worker holds only a per-worker token and its lease, identified by worker id, per-task generation and heartbeat. It reaches the core only over a private 0600 Unix socket.
- **Steps run through the core:** every step the worker requests executes the core planner and broker under the worker's identity. The broker re-authenticates the lease and generation on every submission.
- **One owner per concern:** there is exactly one broker, one retry owner, one budget ledger and one store writer.
- **Child authority** is the intersection of the parent's effective grant and the request (`intersectScope`). Depth shrinks per level, and the budget scope is the parent's.

## Lease loss and fencing
When a lease is lost (heartbeat age greater than `leaseMs`, or the process has gone):

1. The worker is marked LOST or FENCED.
2. The process group is killed only after its (pid, start time) identity is verified.
3. The task goes RECOVERING → READY once no core step is executing.
4. A replacement worker with generation+1 is admitted.

A stale worker that resumes is refused at `/w/step` (409) and by the broker (stale generation).

## What this is not
Worker processes are not a hostile-code boundary. Untrusted or generated code runs only through `proc.run` inside the Seatbelt sandbox (ADR-0001, T-SEC-03). The worker process has no database access, no secrets and no tools of its own.
