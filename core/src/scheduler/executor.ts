// Executor + scheduler: the single owner of task readiness and action retry
// decisions (handoff §6.2, §10). It drives RUNNING tasks one step at a time
// through a pluggable Planner and the Broker, and maps every broker verdict to
// an explicit task state with a wake-up condition.
import type { Store } from '../store/db.ts';
import type { Broker, Proposal, SubmitResult } from '../broker/broker.ts';
import type { Tasks } from '../tasks/tasks.ts';
import type { Control } from '../tasks/control.ts';
import type { Condition } from '../contracts/action.ts';
import { digest } from '../util/canon.ts';
import { TASK_TRANSITIONS, type TaskState } from '../domain/machines.ts';
import { fault } from '../util/fault.ts';

export interface StepRecord { step_key: string; tool_id: string; verdict: string; receipt: unknown; reason: string; revision?: number }

export interface PlanContext {
  task: any;                        // row + goal + success_criteria
  history: StepRecord[];            // settled steps for this revision, oldest first
  lastFailure: { step_key: string; reason: string; verdict: string } | null;
  replans: number;
  state: any;                       // planner-owned durable state
  signal: AbortSignal;
}

export type PlanStep =
  | { kind: 'action'; step_key: string; tool_id: string; arguments: Record<string, unknown>; postconditions?: Condition[]; note?: string }
  | { kind: 'done'; summary: string }
  | { kind: 'blocked'; reason: string; wait?: 'WAITING_PROVIDER' | 'WAITING_PERMISSION' | 'BLOCKED_EXTERNAL' | 'WAITING_USER_SESSION' | 'WAITING_DEPENDENCY' }
  | { kind: 'fail'; reason: string };

export interface Planner {
  id: string;
  next(ctx: PlanContext): Promise<{ step: PlanStep; state: any }>;
}

export interface TaskVerifier {
  verify(task: any, history: StepRecord[]): Promise<{ ok: boolean; evidence: unknown; reason?: string }>;
}

export const LIMITS = { equivalentFailures: 3, replans: 2, retriesPerStep: 3, maxStepsPerTask: 200 };

export interface ExecutorDeps {
  store: Store; broker: Broker; tasks: Tasks; control: Control;
  planners: Map<string, Planner>;
  plannerFor: (task: any) => string;
  verifier: TaskVerifier;
  maxConcurrent?: number;
  notify?: (kind: string, taskId: string, text: string) => void;
}

export class Executor {
  private d: ExecutorDeps;
  private running = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private shutdown = new AbortController();
  private activeSteps = new Set<Promise<'continue' | 'stop'>>();
  private stepControllers = new Map<string, Set<AbortController>>();
  modelCalls = 0;

  constructor(d: ExecutorDeps) { this.d = d; }

  private get store() { return this.d.store; }

  /** Move a task through legal transitions to `to`, if possible. */
  private moveTo(taskId: string, to: TaskState, fields: Record<string, unknown> = {}, reason?: string): boolean {
    const st = this.store.taskStatus(taskId);
    if (st === to) return true;
    if (TASK_TRANSITIONS[st].includes(to)) { this.store.transitionTask(taskId, to, fields, reason); return true; }
    // Legal two-step route through RECOVERING (e.g. RUNNING -> RECOVERING -> BLOCKED_EXTERNAL).
    if (TASK_TRANSITIONS[st].includes('RECOVERING') && TASK_TRANSITIONS.RECOVERING.includes(to)) {
      this.store.tx(() => { this.store.transitionTask(taskId, 'RECOVERING', {}, reason); this.store.transitionTask(taskId, to, fields, reason); });
      return true;
    }
    this.store.tx(() => this.store.event('executor', taskId, 'transition_refused', { from: st, to, reason: reason ?? null }));
    return false;
  }

  /** Admission: RECEIVED -> PLANNING -> READY (dependencies permitting). */
  admitNew(): void {
    const rows = this.store.db.prepare(`SELECT task_id, status FROM tasks WHERE status IN ('RECEIVED','PLANNING')
      OR (status='WAITING_DEPENDENCY' AND wait_condition='dependency_completed')`).all() as any[];
    for (const r of rows) {
      if (this.store.stopLatch().stopped) return;
      if (!this.d.tasks.dependenciesSatisfied(r.task_id)) {
        this.moveTo(r.task_id, 'WAITING_DEPENDENCY', { wait_reason: 'dependency', wait_condition: 'dependency_completed' });
        continue;
      }
      if (r.status === 'RECEIVED' || r.status === 'WAITING_DEPENDENCY') this.moveTo(r.task_id, 'PLANNING');
      this.moveTo(r.task_id, 'READY', { wait_reason: null, wait_condition: null });
    }
  }

  /** Event-driven wake-up of waiting tasks whose condition may now hold. */
  wake(condition: string): number {
    const rows = this.store.db.prepare(`SELECT task_id FROM tasks WHERE status LIKE 'WAITING_%' AND wait_condition=?`).all(condition) as any[];
    let n = 0;
    for (const r of rows) if (this.moveTo(r.task_id, 'READY', { wait_reason: null, wait_condition: null }, `wake:${condition}`)) n++;
    return n;
  }

  /** One scheduling pass: start READY tasks up to the concurrency cap (oldest first = no starvation). */
  tick(): string[] {
    if (this.stopped || this.store.stopLatch().stopped) return [];
    this.admitNew();
    const cap = this.d.maxConcurrent ?? 2;
    const free = cap - this.running.size;
    if (free <= 0) return [];
    const ready = this.store.db.prepare(`SELECT task_id FROM tasks WHERE status='READY' AND driver='core' ORDER BY updated_at, created_at LIMIT ?`).all(free + this.running.size) as any[];
    const started: string[] = [];
    for (const r of ready) {
      if (this.running.has(r.task_id) || this.running.size >= cap) continue;
      if (!this.moveTo(r.task_id, 'RUNNING')) continue;
      fault('scheduler.after_task_running');
      const p = this.runTask(r.task_id).catch((e) => {
        // Never leave a task stranded in RUNNING because of an unexpected error.
        this.store.tx(() => this.store.event('executor', r.task_id, 'task_error', { error: String((e as Error)?.message ?? e).slice(0, 300) }));
        if (this.moveTo(r.task_id, 'RECOVERING')) this.moveTo(r.task_id, 'BLOCKED_EXTERNAL', { wait_reason: `internal error: ${String((e as Error)?.message ?? e).slice(0, 200)}`, wait_condition: 'owner_input' });
      }).finally(() => this.running.delete(r.task_id));
      this.running.set(r.task_id, p);
      started.push(r.task_id);
    }
    return started;
  }

  start(intervalMs = 250): void {
    this.stopped = false;
    if (this.shutdown.signal.aborted) this.shutdown = new AbortController();
    const loop = () => {
      if (this.stopped) return;
      try { this.tick(); } catch (e) { this.store.tx(() => this.store.event('executor', 'loop', 'error', { error: String(e) })); }
      this.timer = setTimeout(loop, intervalMs);
    };
    loop();
  }

  async stop(timeoutMs = 10_000): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.shutdown.abort();
    this.d.broker.abort('all');
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.running.values(), ...this.activeSteps]),
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('executor shutdown timeout')), timeoutMs); }),
      ]);
    } finally { if (timeout) clearTimeout(timeout); }
  }

  async drain(timeoutMs = 30_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      this.tick();
      if (!this.running.size) {
        this.tick();
        if (!this.running.size) return;
      }
      await Promise.race([...this.running.values(), new Promise((r) => setTimeout(r, 50))]);
    }
    throw new Error('drain timeout');
  }

  isRunning(taskId: string): boolean { return this.running.has(taskId); }

  /** Interrupt active planner turns after owner control has advanced task authority. */
  abort(taskIds: string[] | 'all'): number {
    let n = 0;
    for (const [taskId, controllers] of this.stepControllers) {
      if (taskIds !== 'all' && !taskIds.includes(taskId)) continue;
      for (const controller of controllers) if (!controller.signal.aborted) { controller.abort(); n++; }
    }
    return n;
  }

  history(taskId: string, revision: number): StepRecord[] {
    // All revisions: a revised goal must know which effects already happened (T-ACTION-10).
    void revision;
    const rows = this.store.db.prepare(`SELECT a.attempt_id, a.tool_id, a.status, a.receipt_json, a.error, a.task_revision,
      json_extract(a.envelope_json, '$.step_key') sk FROM attempts a WHERE a.task_id=? ORDER BY a.created_at`).all(taskId) as any[];
    return rows.map((r) => ({ step_key: r.sk ?? '', tool_id: r.tool_id, verdict: r.status, receipt: JSON.parse(r.receipt_json ?? 'null'), reason: r.error ?? '', revision: r.task_revision }));
  }

  /** Seed durable planner state at task admission (e.g. a fixed script). */
  seedPlan(taskId: string, revision: number, planner: string, state: any): void {
    this.store.tx(() => this.store.db.prepare(`INSERT INTO plans VALUES (?,?,?,?,0,?) ON CONFLICT(task_id, revision)
      DO UPDATE SET planner=excluded.planner, state_json=excluded.state_json`).run(taskId, revision, planner, JSON.stringify(state), this.store.now()));
  }

  private loadPlan(taskId: string, revision: number, planner: string): { state: any; replans: number } {
    const r = this.store.db.prepare('SELECT state_json, replans FROM plans WHERE task_id=? AND revision=?').get(taskId, revision) as any;
    if (r) return { state: JSON.parse(r.state_json), replans: r.replans };
    this.store.tx(() => this.store.db.prepare('INSERT INTO plans VALUES (?,?,?,?,0,?)').run(taskId, revision, planner, 'null', this.store.now()));
    return { state: null, replans: 0 };
  }

  private savePlan(taskId: string, revision: number, state: any, replans: number): void {
    this.store.tx(() => this.store.db.prepare('UPDATE plans SET state_json=?, replans=?, updated_at=? WHERE task_id=? AND revision=?')
      .run(JSON.stringify(state ?? null), replans, this.store.now(), taskId, revision));
  }

  private failureCount(taskId: string, sig: string, err: string): number {
    return this.store.tx(() => {
      this.store.db.prepare(`INSERT INTO step_failures VALUES (?,?,1,?,?) ON CONFLICT(task_id, signature)
        DO UPDATE SET count=count+1, last_error=excluded.last_error, updated_at=excluded.updated_at`).run(taskId, sig, err.slice(0, 500), this.store.now());
      return (this.store.db.prepare('SELECT count FROM step_failures WHERE task_id=? AND signature=?').get(taskId, sig) as any).count;
    });
  }

  /** Drive one task until it leaves RUNNING. */
  private stepState = new Map<string, { steps: number; lastFailure: PlanContext['lastFailure']; retries: Map<string, number> }>();

  /** Drive one task until it leaves RUNNING (core-driven tasks). */
  async runTask(taskId: string): Promise<void> {
    while ((await this.step(taskId)) === 'continue') { /* next step */ }
  }

  /**
   * Execute exactly one plan/act iteration for a RUNNING task. `actor` is the
   * in-process core identity by default, or a leased worker (id + generation)
   * whose lease the broker re-checks on every submission.
   */
  step(taskId: string, actor?: { actor_id: string; generation: number }): Promise<'continue' | 'stop'> {
    if (this.stopped) return Promise.resolve('stop');
    const controller = new AbortController();
    const controllers = this.stepControllers.get(taskId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.stepControllers.set(taskId, controllers);
    const signal = AbortSignal.any([this.shutdown.signal, controller.signal]);
    const pending = this.stepInner(taskId, actor, signal).finally(() => {
      this.activeSteps.delete(pending);
      controllers.delete(controller);
      if (!controllers.size) this.stepControllers.delete(taskId);
    });
    this.activeSteps.add(pending);
    return pending;
  }

  private async stepInner(taskId: string, actor: { actor_id: string; generation: number } | undefined, signal: AbortSignal): Promise<'continue' | 'stop'> {
    let st = this.stepState.get(taskId);
    if (!st) { st = { steps: 0, lastFailure: null, retries: new Map() }; this.stepState.set(taskId, st); }
    const done = (): 'stop' => { if (!this.store.db.prepare(`SELECT 1 FROM tasks WHERE task_id=? AND status='RUNNING'`).get(taskId)) this.stepState.delete(taskId); return 'stop'; };
    const task = this.d.tasks.get(taskId);
    if (!task || task.status !== 'RUNNING') return done();
    const total = (this.store.db.prepare('SELECT count(*) c FROM attempts WHERE task_id=?').get(taskId) as any).c;
    if (++st.steps > LIMITS.maxStepsPerTask || total > LIMITS.maxStepsPerTask) { this.moveTo(taskId, 'FAILED', { result_json: JSON.stringify({ error: 'step limit reached' }) }); return done(); }
    // Settle effects already dispatched (any revision) before planning anything new.
    const settleable = () => this.store.db.prepare(`SELECT attempt_id FROM attempts WHERE task_id=? AND status IN
      ('PREPARED','DISPATCHING','OBSERVED_SUCCESS','OUTCOME_UNKNOWN','RECONCILING')`).all(taskId) as any[];
    for (let i = 0; i < 100 && settleable().some((a) => this.d.broker.isInflight(a.attempt_id)); i++) await new Promise((r) => setTimeout(r, 50));
    for (const a of settleable()) {
      if (this.d.broker.isInflight(a.attempt_id)) continue;
      if (this.store.attemptStatus(a.attempt_id) === 'PREPARED') { this.store.transitionAttempt(a.attempt_id, 'CANCELLED', { error: 'never dispatched' }); continue; }
      await this.d.broker.reconcileAttempt(a.attempt_id);
    }
    const unresolved = this.store.db.prepare(`SELECT count(*) c FROM attempts WHERE task_id=? AND status IN ('UNRESOLVED','RECONCILING','OUTCOME_UNKNOWN','DISPATCHING')`).get(taskId) as any;
    if (this.stopped || signal.aborted) return done();
    if (unresolved.c) {
      this.moveTo(taskId, 'RECONCILING', { wait_reason: 'earlier effect outcome is uncertain' });
      this.moveTo(taskId, 'BLOCKED_EXTERNAL', { wait_reason: 'an earlier effect has an uncertain outcome; reconcile before continuing', wait_condition: 'reconcile' });
      return done();
    }
    const plannerId = this.d.plannerFor(task);
    const planner = this.d.planners.get(plannerId);
    if (!planner) { this.moveTo(taskId, 'BLOCKED_EXTERNAL', { wait_reason: `planner ${plannerId} unavailable`, wait_condition: 'planner_available' }); return done(); }
    const plan = this.loadPlan(taskId, task.revision, plannerId);
    const history = this.history(taskId, task.revision);
    let out: { step: PlanStep; state: any };
    try {
      out = await planner.next({ task, history, lastFailure: st.lastFailure, replans: plan.replans, state: plan.state, signal });
    } catch (e) {
      if (this.stopped || signal.aborted) return done(); // Leave RUNNING for startup recovery, without changing owner authority.
      const msg = (e as Error).message;
      const kind = (e as any).kind as string | undefined;
      if (kind === 'stopped') return done(); // control already paused the task
      const wait = kind === 'budget' ? 'WAITING_BUDGET' : kind === 'egress' ? 'WAITING_PERMISSION' : 'WAITING_PROVIDER';
      const cond = wait === 'WAITING_BUDGET' ? 'budget_changed' : wait === 'WAITING_PERMISSION' ? 'grant_changed' : kind === 'auth' || kind === 'config' ? 'provider_configured' : 'provider_available';
      this.moveTo(taskId, wait, { wait_reason: msg.slice(0, 300), wait_condition: cond });
      this.d.notify?.('blocked', taskId, `Waiting: ${msg.slice(0, 200)}`);
      return done();
    }
    // Revision or stop may have changed while the planner was thinking.
    const fresh = this.d.tasks.get(taskId);
    if (this.stopped || signal.aborted) return done();
    if (fresh.status !== 'RUNNING' || fresh.revision !== task.revision || fresh.cancellation_generation !== task.cancellation_generation) return done();
    this.savePlan(taskId, task.revision, out.state, plan.replans);
    const s = out.step;
    if (s.kind === 'done') { await this.complete(taskId, task, s.summary); return done(); }
    if (s.kind === 'blocked') {
      const to = s.wait ?? 'BLOCKED_EXTERNAL';
      const cond = to === 'WAITING_PERMISSION' ? 'grant_changed' : to === 'WAITING_USER_SESSION' ? 'session_available' : to === 'WAITING_DEPENDENCY' ? 'children_settled' : to === 'WAITING_PROVIDER' ? 'provider_available' : 'external';
      this.moveTo(taskId, to, { wait_reason: s.reason.slice(0, 500), wait_condition: cond });
      if (to !== 'WAITING_DEPENDENCY') this.d.notify?.('blocked', taskId, s.reason);
      return done();
    }
    if (s.kind === 'fail') {
      this.moveTo(taskId, 'FAILED', { result_json: JSON.stringify({ error: s.reason }) });
      this.d.notify?.('failed', taskId, s.reason);
      return done();
    }
    const proposal: Proposal = {
      task_id: taskId, task_revision: task.revision, cancellation_generation: task.cancellation_generation,
      ...(actor ? { actor_id: actor.actor_id, worker_generation: actor.generation } : { actor_id: `core:${taskId}`, core_key: this.d.broker.coreKey }),
      tool_id: s.tool_id, arguments: s.arguments, step_key: s.step_key, postconditions: s.postconditions,
    };
    const r = await this.d.broker.submit(proposal);
    if (this.stopped || signal.aborted) return done();
    if (r.verdict === 'REJECTED' && /^authentication:/.test(r.reason)) return done(); // fenced or stale worker: never act
    const handled = this.handleVerdict(taskId, task, s, r, st.retries);
    if (handled === 'continue') { st.lastFailure = null; return 'continue'; }
    if (handled === 'retry') { await new Promise((res) => setTimeout(res, 50 * (st!.retries.get(s.step_key) ?? 1))); return 'continue'; }
    if (handled === 'replan') {
      st.lastFailure = { step_key: s.step_key, reason: r.reason, verdict: r.verdict };
      const p2 = this.loadPlan(taskId, task.revision, plannerId);
      const sig = digest({ tool: s.tool_id, args: s.arguments, err: r.reason.replace(/[0-9a-f-]{36}/g, '') });
      const n = this.failureCount(taskId, sig, r.reason);
      if (n >= LIMITS.equivalentFailures) {
        if (p2.replans >= LIMITS.replans) {
          this.moveTo(taskId, 'RECOVERING');
          this.moveTo(taskId, 'BLOCKED_EXTERNAL', { wait_reason: `recovery exhausted: ${r.reason}`.slice(0, 500), wait_condition: 'owner_input' });
          this.d.notify?.('blocked', taskId, `I tried ${LIMITS.replans + 1} different approaches; last error: ${r.reason}`);
          return done();
        }
        this.savePlan(taskId, task.revision, p2.state, p2.replans + 1);
      }
      this.moveTo(taskId, 'RECOVERING');
      this.moveTo(taskId, 'READY');
      this.moveTo(taskId, 'RUNNING');
      return 'continue';
    }
    return done(); // task moved to a waiting/terminal state
  }

  private handleVerdict(taskId: string, task: any, s: Extract<PlanStep, { kind: 'action' }>, r: SubmitResult, retries: Map<string, number>): 'continue' | 'retry' | 'replan' | 'stop' {
    switch (r.verdict) {
      case 'COMMITTED':
      case 'DEDUPLICATED':
        return 'continue';
      case 'RETRY_ELIGIBLE': {
        const n = (retries.get(s.step_key) ?? 0) + 1;
        retries.set(s.step_key, n);
        return n < LIMITS.retriesPerStep ? 'retry' : 'replan';
      }
      case 'FAILED':
      case 'REJECTED':
      case 'DENIED':
        return 'replan';
      case 'NEEDS_AUTHORITY':
        this.moveTo(taskId, 'WAITING_PERMISSION', { wait_reason: `needs new owner authority: ${r.reason}`, wait_condition: 'grant_changed' });
        this.d.notify?.('needs_authority', taskId, `This needs authority you haven't granted: ${r.reason}`);
        return 'stop';
      case 'WAIT_PREREQUISITE':
        this.moveTo(taskId, 'WAITING_PERMISSION', { wait_reason: r.reason, wait_condition: 'grant_changed' });
        return 'stop';
      case 'WAIT_BUDGET':
        this.moveTo(taskId, 'WAITING_BUDGET', { wait_reason: r.reason, wait_condition: 'budget_changed' });
        this.d.notify?.('budget', taskId, `Paused for budget: ${r.reason}`);
        return 'stop';
      case 'WAIT_SESSION':
        this.moveTo(taskId, 'WAITING_USER_SESSION', { wait_reason: r.reason, wait_condition: 'session_available' });
        return 'stop';
      case 'WAIT_RESOURCE':
        this.moveTo(taskId, 'WAITING_RESOURCE', { wait_reason: r.reason, wait_condition: 'resource_released' });
        return 'stop';
      case 'UNRESOLVED':
        this.moveTo(taskId, 'RECONCILING', { wait_reason: r.reason });
        this.moveTo(taskId, 'BLOCKED_EXTERNAL', { wait_reason: `uncertain effect needs reconciliation: ${r.reason}`, wait_condition: 'reconcile' });
        this.d.notify?.('uncertain', taskId, 'An external effect has an uncertain outcome; I will check the destination before trying again.');
        return 'stop';
      case 'STALE':
        // Revision/cancellation advanced: the owner changed the task; replanning happens on the new revision.
        if (this.store.taskStatus(taskId) === 'RUNNING') this.moveTo(taskId, 'PLANNING');
        return 'stop';
      case 'STOPPED':
      default:
        return 'stop';
    }
  }

  private async complete(taskId: string, task: any, summary: string): Promise<void> {
    if (!this.moveTo(taskId, 'VERIFYING')) return;
    const unresolved = this.store.db.prepare(`SELECT count(*) c FROM attempts WHERE task_id=? AND status IN
      ('UNRESOLVED','OUTCOME_UNKNOWN','RECONCILING','DISPATCHING')`).get(taskId) as any;
    const kids = this.store.db.prepare(`SELECT count(*) c FROM task_edges e JOIN tasks t ON t.task_id=e.child_task_id
      WHERE e.parent_task_id=? AND e.kind='child' AND t.status <> 'COMPLETED'`).get(taskId) as any;
    const pendingKids = this.store.db.prepare(`SELECT count(*) c FROM task_edges e JOIN tasks t ON t.task_id=e.child_task_id
      WHERE e.parent_task_id=? AND e.kind='child' AND t.status NOT IN ('COMPLETED','FAILED','CANCELLED')`).get(taskId) as any;
    if (pendingKids.c > 0) {
      // Children still working: wait durably (woken when children settle), not a failed completion.
      this.moveTo(taskId, 'WAITING_DEPENDENCY', { wait_reason: `${pendingKids.c} child task(s) still running`, wait_condition: 'children_settled' });
      return;
    }
    const history = this.history(taskId, task.revision);
    const v = await this.d.verifier.verify(this.d.tasks.get(taskId), history);
    const p = this.loadPlan(taskId, task.revision, this.d.plannerFor(task));
    // A model's "done" alone is never evidence. Checked criteria can establish an already-satisfied
    // goal; read-only answers need explicit criteria tied to their broker observation. A deterministic empty
    // script is an authoritative no-op plan, retained for owner automation and recovery fixtures.
    const hasEvidence = (task.success_criteria?.postconditions ?? []).length > 0
      || (p.state?.frozen_criteria ?? []).length > 0
      || (this.d.plannerFor(task) !== 'model' && history.some((h) => h.verdict === 'COMMITTED'))
      || (this.d.plannerFor(task) === 'scripted' && Array.isArray(p.state?.steps) && p.state.steps.length === 0);
    if (v.ok && hasEvidence && unresolved.c === 0 && kids.c === 0) {
      this.moveTo(taskId, 'COMPLETED', { result_json: JSON.stringify({ summary, evidence: v.evidence }) });
      this.d.notify?.('completed', taskId, summary);
      return;
    }
    const why = !v.ok ? `task postconditions not met: ${v.reason ?? ''}` : !hasEvidence ? 'completion has no independently verified evidence' : unresolved.c ? 'unresolved effects remain' : 'required children incomplete';
    if (p.replans >= LIMITS.replans) {
      this.moveTo(taskId, 'FAILED', { result_json: JSON.stringify({ error: why, evidence: v.evidence }) });
      this.d.notify?.('failed', taskId, why);
      return;
    }
    this.savePlan(taskId, task.revision, p.state, p.replans + 1);
    this.moveTo(taskId, 'RECOVERING', { wait_reason: why });
    this.moveTo(taskId, 'READY');
  }
}
