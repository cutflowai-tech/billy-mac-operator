// The single admitted-action boundary (handoff §8.3, REQ-05/08/09/10).
// Every side-effecting operation from planners, children, recovery, remote
// commands and scheduled jobs goes through Broker.submit(). The broker never
// retries on its own: it returns a terminal attempt verdict and the executor
// (single retry owner) decides whether to submit a new attempt of the same
// semantic operation.
import { ACTION_ENVELOPE_SCHEMA, type ActionEnvelope, type Condition } from '../contracts/action.ts';
import { validate } from '../contracts/schema.ts';
import { canonical, digest, newId } from '../util/canon.ts';
import { fault } from '../util/fault.ts';
import type { Store } from '../store/db.ts';
import { decide, PolicyStore } from '../policy/policy.ts';
import { Budget, BudgetWait, NO_COST } from '../budget/budget.ts';
import { ACTION_UNSETTLED, type ActionState } from '../domain/machines.ts';
import type { AdapterContext, ResolvedTarget, ToolAdapter } from './types.ts';
import { TargetError } from './types.ts';
import type { Claims } from '../scheduler/claims.ts';
import { resolve as resolvePath, dirname as dirnameOf } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { pathWithinRoots } from '../policy/policy.ts';
import { randomBytes } from 'node:crypto';

export const MAX_ATTEMPTS_PER_OPERATION = 3;

export interface Proposal {
  task_id: string;
  task_revision: number;
  cancellation_generation: number;
  actor_id: string;
  worker_generation?: number;
  /** Required for the in-process executor identity `core:<task>`; never exposed over IPC. */
  core_key?: string;
  tool_id: string;
  tool_version?: number;
  arguments: Record<string, unknown>;
  /** Stable planner identity for this intended effect within the task. */
  step_key: string;
  /** Planner-declared postconditions; merged with the tool's own (never replacing them). */
  postconditions?: Condition[];
  idempotency_key?: string | null;
  deadline_at?: string | null;
  observation_ref?: string | null;
}

export type Verdict =
  | 'COMMITTED' | 'DEDUPLICATED' | 'REJECTED' | 'DENIED' | 'NEEDS_AUTHORITY' | 'WAIT_PREREQUISITE'
  | 'WAIT_BUDGET' | 'WAIT_RESOURCE' | 'WAIT_SESSION' | 'STOPPED' | 'STALE' | 'RETRY_ELIGIBLE' | 'FAILED' | 'UNRESOLVED';

export interface SubmitResult {
  verdict: Verdict;
  reason: string;
  attempt_id?: string;
  semantic_operation_id?: string;
  receipt?: unknown;
  evidence?: unknown;
}

export class ToolRegistry {
  private tools = new Map<string, ToolAdapter>();
  register(a: ToolAdapter): void {
    const key = `${a.spec.tool_id}@${a.spec.version}`;
    if (this.tools.has(key)) throw new Error(`duplicate tool ${key}`);
    this.tools.set(key, a);
  }
  get(toolId: string, version?: number): ToolAdapter | undefined {
    if (version) return this.tools.get(`${toolId}@${version}`);
    let best: ToolAdapter | undefined;
    for (const a of this.tools.values()) if (a.spec.tool_id === toolId && (!best || a.spec.version > best.spec.version)) best = a;
    return best;
  }
  list(): ToolAdapter[] { return [...this.tools.values()]; }
}

export interface BrokerDeps {
  store: Store;
  registry: ToolRegistry;
  policy: PolicyStore;
  budget: Budget;
  claims: Claims;
  deviceId: string;
  services?: Record<string, unknown>;
}

export class Broker {
  private d: BrokerDeps;
  /** Secret held only by the in-process executor; IPC paths never receive it (F-09). */
  readonly coreKey = randomBytes(24).toString('hex');
  private inflight = new Map<string, { controller: AbortController; taskId: string }>();
  constructor(d: BrokerDeps) { this.d = d; }

  isInflight(attemptId: string): boolean { return this.inflight.has(attemptId); }

  /** Abort in-flight cancellable adapter calls (F-12). Already-dispatched effects are still reconciled. */
  abort(taskIds: string[] | 'all'): number {
    let n = 0;
    for (const [, v] of this.inflight) if (taskIds === 'all' || taskIds.includes(v.taskId)) { v.controller.abort(); n++; }
    return n;
  }

  private reject(verdict: Verdict, reason: string, extra: Partial<SubmitResult> = {}): SubmitResult {
    return { verdict, reason, ...extra };
  }

  private taskRow(taskId: string): any {
    return this.d.store.db.prepare('SELECT * FROM tasks WHERE task_id=?').get(taskId);
  }

  /** Step 1: caller authentication bound to admitted task + live lease. */
  private authenticate(p: Proposal): string | null {
    if (p.actor_id.startsWith('core:')) {
      return p.actor_id === `core:${p.task_id}` && p.core_key === this.coreKey ? null : 'core identity requires the in-process key';
    }
    const w = this.d.store.db.prepare(`SELECT * FROM workers WHERE worker_id=?`).get(p.actor_id) as any;
    if (!w) return 'unknown actor';
    if (w.task_id !== p.task_id) return 'actor not admitted to this task';
    if (w.status !== 'RUNNING') return `actor lease not running (${w.status})`;
    if (w.generation !== p.worker_generation) return `stale worker generation ${p.worker_generation} != ${w.generation}`;
    return null;
  }

  /** Every refusal is auditable, whichever stage produced it. */
  async submit(p: Proposal): Promise<SubmitResult> {
    const r = await this.submitInner(p);
    if (['DENIED', 'NEEDS_AUTHORITY', 'REJECTED', 'STALE', 'STOPPED'].includes(r.verdict)) {
      try { this.d.store.tx(() => this.d.store.event('broker', p.task_id, 'refused', { verdict: r.verdict, tool: p.tool_id, step_key: p.step_key, actor: p.actor_id, reason: r.reason.slice(0, 300) })); } catch { /* audit is best effort if the store is closing */ }
    }
    return r;
  }

  private async submitInner(p: Proposal): Promise<SubmitResult> {
    const { store, registry, policy } = this.d;
    // 1. authenticate
    const authErr = this.authenticate(p);
    if (authErr) return this.reject('REJECTED', `authentication: ${authErr}`);
    // 2. validate tool, arguments, revision, deadline, cancellation generation
    const tool = registry.get(p.tool_id, p.tool_version);
    if (!tool) return this.reject('REJECTED', `unknown tool ${p.tool_id}${p.tool_version ? '@' + p.tool_version : ''}`);
    const argErrs = validate(tool.spec.input_schema, p.arguments);
    if (argErrs.length) return this.reject('REJECTED', `invalid arguments: ${argErrs.slice(0, 3).map((e) => `${e.path} ${e.message}`).join('; ')}`);
    const task = this.taskRow(p.task_id);
    if (!task) return this.reject('REJECTED', 'unknown task');
    if (task.revision !== p.task_revision) return this.reject('STALE', `task revision ${p.task_revision} != current ${task.revision}`);
    if (task.cancellation_generation !== p.cancellation_generation) return this.reject('STALE', 'cancellation generation advanced');
    if (task.status !== 'RUNNING') return this.reject('STALE', `task not RUNNING (${task.status})`);
    if (store.stopLatch().stopped) return this.reject('STOPPED', 'owner stop latch is set');
    if (p.deadline_at && p.deadline_at <= store.now()) return this.reject('REJECTED', 'deadline passed');
    // 3. canonical target + authority scope
    const grantEarly = task.grant_id ? policy.effective(task.grant_id) : null;
    const roots = grantEarly?.scope.file_roots ?? [];
    // F-06: authorize named paths lexically before touching the filesystem (no existence oracle).
    const named = tool.paths?.(p.arguments) ?? [];
    for (const raw of named) {
      if (!pathWithinRoots(resolvePath(raw), roots)) return this.reject(grantEarly ? 'DENIED' : 'NEEDS_AUTHORITY', 'path outside granted roots');
    }
    // F-04: planner postconditions may only reference granted paths.
    for (const c of p.postconditions ?? []) {
      if (typeof c.path === 'string') {
        const lex = resolvePath(c.path);
        let canon = lex;
        try { canon = existsSync(lex) ? realpathSync(lex) : resolvePath(realpathSync(dirnameOf(lex)), lex.split('/').pop()!); } catch { /* keep lexical */ }
        if (!pathWithinRoots(lex, roots) || !pathWithinRoots(canon, roots)) return this.reject('DENIED', 'postcondition references a path outside granted roots');
      }
    }
    const controller = new AbortController();
    const ctxBase = { store, taskId: p.task_id, deviceId: this.d.deviceId, signal: controller.signal, services: this.d.services ?? {} };
    let resolved: ResolvedTarget;
    try {
      resolved = tool.resolve(p.arguments, ctxBase);
    } catch (e) {
      return this.reject(e instanceof TargetError ? 'DENIED' : 'REJECTED', `target: ${(e as Error).message}`);
    }
    const grant = task.grant_id ? policy.effective(task.grant_id) : null;
    const argsDigest = digest(p.arguments);
    const semId = digest({ task_id: p.task_id, step_key: p.step_key, tool_id: tool.spec.tool_id, resource_id: resolved.resource_id, args: argsDigest });
    const toolPost = tool.postconditions(p.arguments, resolved);
    const post = [...toolPost, ...(p.postconditions ?? [])];
    const env: ActionEnvelope = {
      schema_version: 1, action_id: newId(), attempt_id: newId(), task_id: p.task_id, task_revision: p.task_revision,
      cancellation_generation: p.cancellation_generation, actor_id: p.actor_id, tool_id: tool.spec.tool_id,
      tool_version: tool.spec.version, arguments: p.arguments, arguments_digest: argsDigest,
      target: { device_id: this.d.deviceId, account_id: resolved.account_id, resource_id: resolved.resource_id },
      authority: { grant_id: grant?.grant_id ?? '00000000-0000-4000-8000-000000000000', policy_revision: grant?.revision ?? 1, expires_at: grant?.expires_at ?? '1970-01-01T00:00:00.000Z' },
      effect_class: tool.spec.effect_class, semantic_operation_id: semId, idempotency_key: p.idempotency_key ?? null,
      resource_claims: resolved.claims, fencing_generation: 0, preconditions: [], postconditions: post,
      observation_ref: p.observation_ref ?? null,
      retry_policy_id: tool.spec.effect_class === 'READ_ONLY' ? 'read_transient' : tool.spec.effect_class === 'IDEMPOTENT_WRITE' ? 'idempotent_write' : 'none',
      deadline_at: p.deadline_at ?? null, budget_reservation_id: NO_COST, compensation_ref: null,
    };
    const envErrs = validate(ACTION_ENVELOPE_SCHEMA, env);
    if (envErrs.length) return this.reject('REJECTED', `envelope: ${envErrs.slice(0, 3).map((e) => `${e.path} ${e.message}`).join('; ')}`);
    const dec = decide(env, tool.spec, grant, store.now(), resolved.facts);
    if (dec.decision !== 'ALLOW') {
      store.tx(() => store.event('policy', p.task_id, 'decision', { tool: tool.spec.tool_id, decision: dec.decision, reason: dec.reason, sem: semId }));
      const v: Verdict = dec.decision === 'DENY' ? 'DENIED' : dec.decision === 'WAIT_PREREQUISITE' ? 'WAIT_PREREQUISITE' : 'NEEDS_AUTHORITY';
      return this.reject(v, dec.reason, { semantic_operation_id: semId });
    }
    // Dedup / quarantine against prior attempts of the same semantic operation.
    const prior = store.db.prepare(`SELECT attempt_id, action_id, status, receipt_json, evidence_json FROM attempts
      WHERE semantic_operation_id=? ORDER BY attempt_no`).all(semId) as any[];
    const committed = prior.find((a) => a.status === 'COMMITTED');
    if (committed) {
      return { verdict: 'DEDUPLICATED', reason: 'semantic operation already committed', attempt_id: committed.attempt_id,
        semantic_operation_id: semId, receipt: JSON.parse(committed.receipt_json ?? 'null'), evidence: JSON.parse(committed.evidence_json ?? 'null') };
    }
    const unsettled = prior.find((a) => ACTION_UNSETTLED.has(a.status) || !['RETRY_ELIGIBLE', 'FAILED', 'REJECTED', 'CANCELLED'].includes(a.status));
    if (unsettled) return this.reject('UNRESOLVED', `prior attempt ${unsettled.attempt_id} is ${unsettled.status}; reconcile first`, { semantic_operation_id: semId });
    if (tool.spec.effect_class === 'NON_IDEMPOTENT_EFFECT') {
      // F-10: never start a reworded duplicate of an effect on the same target while one is uncertain.
      const uncertain = store.db.prepare(`SELECT attempt_id FROM attempts WHERE task_id=? AND tool_id=? AND json_extract(target_json,'$.resource_id')=?
        AND status IN ('DISPATCHING','OBSERVED_SUCCESS','OUTCOME_UNKNOWN','RECONCILING','UNRESOLVED')`).get(p.task_id, tool.spec.tool_id, resolved.resource_id) as any;
      if (uncertain) return this.reject('UNRESOLVED', `an uncertain ${tool.spec.tool_id} effect on this target (${uncertain.attempt_id}) must be reconciled first`, { semantic_operation_id: semId });
    }
    if (prior.some((a) => a.status === 'FAILED')) return this.reject('FAILED', 'semantic operation already definitively failed', { semantic_operation_id: semId });
    if (prior.length >= MAX_ATTEMPTS_PER_OPERATION) return this.reject('FAILED', 'attempt limit reached for this operation', { semantic_operation_id: semId });
    if (prior.length > 0 && env.retry_policy_id === 'none') {
      // A non-idempotent effect is only retried after reconciliation proved it was not applied.
      const last = prior[prior.length - 1];
      const neverDispatched = ['CANCELLED', 'REJECTED'].includes(last.status);
      const proven = store.db.prepare(`SELECT count(*) c FROM events WHERE entity_id=? AND kind='transition'
        AND json_extract(payload_json,'$.to')='PROVEN_NOT_APPLIED'`).get(last.attempt_id) as any;
      const definite = store.db.prepare(`SELECT count(*) c FROM events WHERE entity_id=? AND kind='transition'
        AND json_extract(payload_json,'$.to')='DEFINITE_FAILURE'`).get(last.attempt_id) as any;
      if (!neverDispatched && !proven.c && !definite.c) return this.reject('UNRESOLVED', 'non-idempotent retry without proof of non-application');
    }
    // 4. refresh preconditions
    const pre = tool.preconditions(p.arguments, resolved, ctxBase);
    if (!pre.ok) {
      const v: Verdict = pre.wait === 'WAITING_USER_SESSION' ? 'WAIT_SESSION' : pre.wait === 'WAITING_RESOURCE' ? 'WAIT_RESOURCE' : pre.wait === 'WAITING_PERMISSION' ? 'NEEDS_AUTHORITY' : 'REJECTED';
      return this.reject(v, `precondition: ${pre.reason ?? 'failed'}`, { semantic_operation_id: semId });
    }
    // 5. budget + resource claims (bounded, ordered)
    let reservation = NO_COST;
    const estimate = tool.estimateMicros?.(p.arguments) ?? 0;
    if (estimate > 0) {
      try {
        reservation = this.d.budget.reserve(resolved.facts.spend_scope ? [resolved.facts.spend_scope] : [task.budget_scope].filter(Boolean), estimate, semId);
      } catch (e) {
        if (e instanceof BudgetWait) return this.reject('WAIT_BUDGET', e.message, { semantic_operation_id: semId });
        throw e;
      }
    }
    env.budget_reservation_id = reservation;
    const holder = env.attempt_id;
    const got = this.d.claims.acquireAll(resolved.claims, holder, `task:${p.task_id}`);
    if (!got.ok) {
      this.d.budget.settle(reservation, 0);
      return this.reject('WAIT_RESOURCE', `resource busy: ${got.blocked}`, { semantic_operation_id: semId });
    }
    env.fencing_generation = got.generation;
    const attemptNo = prior.length + 1;
    const ctx: AdapterContext = { ...ctxBase, attemptId: env.attempt_id };
    try {
      fault('broker.before_intent_commit');
      // 6. persist intent through PREPARED (single transaction)
      try {
        store.tx(() => {
          store.db.prepare(`INSERT INTO attempts(attempt_id, action_id, semantic_operation_id, attempt_no, task_id, task_revision,
            cancellation_generation, actor_id, tool_id, tool_version, effect_class, target_json, arguments_digest, arguments_json,
            envelope_json, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'PROPOSED', ?, ?)`)
            .run(env.attempt_id, prior[0]?.action_id ?? env.action_id, semId, attemptNo, p.task_id, p.task_revision,
              p.cancellation_generation, p.actor_id, tool.spec.tool_id, tool.spec.version, tool.spec.effect_class,
              canonical(env.target), argsDigest, canonical(p.arguments), canonical({ ...env, arguments: undefined, step_key: p.step_key, fingerprint: resolved.fingerprint ?? null, resolved }), store.now(), store.now());
          store.event('attempt', env.attempt_id, 'created', { sem: semId, tool: tool.spec.tool_id, attempt_no: attemptNo }, p.task_id);
          store.transitionAttempt(env.attempt_id, 'VALIDATED');
          store.transitionAttempt(env.attempt_id, 'AUTHORIZED', { evidence_json: canonical({ decision: dec, pre: pre.evidence ?? null }) });
          store.transitionAttempt(env.attempt_id, 'PREPARED');
        });
      } catch (e) {
        if (/UNIQUE constraint failed: attempts.semantic_operation_id/.test((e as Error).message)) {
          return this.reject('UNRESOLVED', 'another attempt of this operation is in flight', { semantic_operation_id: semId });
        }
        throw e;
      }
      fault('broker.after_prepared');
      // 7+8. recheck barrier and persist DISPATCHING in one synchronous transaction
      const stale = store.tx(() => {
        const t = this.taskRow(p.task_id);
        const why = store.stopLatch().stopped ? 'stop latch set'
          : t.status !== 'RUNNING' ? `task ${t.status}`
            : t.cancellation_generation !== p.cancellation_generation ? 'cancellation generation advanced'
              : t.revision !== p.task_revision ? 'task revision advanced'
                : this.authenticate(p)
                  ?? (() => {
                    const g = t.grant_id ? policy.effective(t.grant_id) : null;
                    const d2 = decide(env, tool.spec, g, store.now(), resolved.facts);
                    if (d2.decision !== 'ALLOW') return `authority changed: ${d2.reason}`;
                    if (!this.d.claims.stillHeld(resolved.claims, holder, got.generation)) return 'resource claim lost';
                    const fp = tool.fingerprint?.(resolved);
                    if (fp !== resolved.fingerprint) return `target identity changed (${resolved.fingerprint} -> ${fp})`;
                    return null;
                  })();
        if (why) {
          store.transitionAttempt(env.attempt_id, 'CANCELLED', { error: why });
          return why;
        }
        store.transitionAttempt(env.attempt_id, 'DISPATCHING', { dispatched_at: store.now() });
        return null;
      });
      if (stale) {
        this.d.budget.settle(reservation, 0);
        const v: Verdict = /stop latch|cancellation/.test(stale) ? 'STOPPED' : /authority/.test(stale) ? 'DENIED' : 'STALE';
        return this.reject(v, stale, { attempt_id: env.attempt_id, semantic_operation_id: semId });
      }
      fault('broker.after_dispatching');
      let res;
      this.inflight.set(env.attempt_id, { controller, taskId: p.task_id });
      try {
        res = await tool.dispatch(p.arguments, resolved, ctx);
      } catch (e) {
        res = { outcome: 'unknown' as const, error: `adapter threw: ${(e as Error).message}` };
      }
      fault('broker.after_adapter_call');
      // 9. record outcome
      const to: ActionState = res.outcome === 'success' ? 'OBSERVED_SUCCESS' : res.outcome === 'failure' ? 'DEFINITE_FAILURE' : 'OUTCOME_UNKNOWN';
      store.transitionAttempt(env.attempt_id, to, { receipt_json: canonical(res.receipt ?? null), error: res.error ?? null,
        uncertainty: res.outcome === 'unknown' ? (res.error ?? 'outcome unknown') : null });
      if (res.usage_micros !== undefined) this.d.budget.settle(reservation, res.usage_micros);
      else if (res.outcome === 'failure') this.d.budget.settle(reservation, 0);
      else if (res.outcome === 'unknown') this.d.budget.settle(reservation, 'unknown');
      else this.d.budget.settle(reservation, estimate);
      fault('broker.after_outcome_record');
      if (to === 'DEFINITE_FAILURE') {
        const next: ActionState = res.retryable ? 'RETRY_ELIGIBLE' : 'FAILED';
        store.transitionAttempt(env.attempt_id, next);
        return { verdict: next === 'RETRY_ELIGIBLE' ? 'RETRY_ELIGIBLE' : 'FAILED', reason: res.error ?? 'definite failure', attempt_id: env.attempt_id, semantic_operation_id: semId, receipt: res.receipt };
      }
      if (to === 'OUTCOME_UNKNOWN') {
        return await this.reconcileAttempt(env.attempt_id);
      }
      // 10. independent verification
      let v;
      try { v = await tool.verify(p.arguments, resolved, post, res.receipt, ctx); }
      catch (e) {
        // F-03: a failing verifier is an unknown outcome, never a crash or a silent success.
        store.transitionAttempt(env.attempt_id, 'RECONCILING', { uncertainty: `verify threw: ${(e as Error).message}`.slice(0, 300) });
        return await this.reconcileAttempt(env.attempt_id);
      }
      fault('broker.after_verify');
      return this.settleVerification(env.attempt_id, v, res.receipt, semId);
    } finally {
      this.inflight.delete(env.attempt_id);
      this.d.claims.releaseAll(holder);
    }
  }

  private settleVerification(attemptId: string, v: { verdict: string; evidence: unknown }, receipt: unknown, semId: string): SubmitResult {
    const { store } = this.d;
    if (v.verdict === 'verified') {
      fault('broker.before_commit');
      store.tx(() => {
        store.transitionAttempt(attemptId, 'VERIFIED', { evidence_json: canonical(v.evidence ?? null) });
        store.transitionAttempt(attemptId, 'COMMITTED');
      });
      return { verdict: 'COMMITTED', reason: 'verified', attempt_id: attemptId, semantic_operation_id: semId, receipt, evidence: v.evidence };
    }
    if (v.verdict === 'failed') {
      store.transitionAttempt(attemptId, 'FAILED', { evidence_json: canonical(v.evidence ?? null), error: 'postcondition verification failed' });
      return { verdict: 'FAILED', reason: 'postcondition verification failed', attempt_id: attemptId, semantic_operation_id: semId, receipt, evidence: v.evidence };
    }
    store.transitionAttempt(attemptId, 'RECONCILING', { evidence_json: canonical(v.evidence ?? null) });
    return { verdict: 'UNRESOLVED', reason: 'verification inconclusive; reconciliation required', attempt_id: attemptId, semantic_operation_id: semId };
  }

  /** Reconcile an attempt whose effect may or may not have happened. Used inline and by recovery. */
  async reconcileAttempt(attemptId: string): Promise<SubmitResult> {
    const { store, registry } = this.d;
    const row = store.db.prepare('SELECT * FROM attempts WHERE attempt_id=?').get(attemptId) as any;
    const tool = registry.get(row.tool_id, row.tool_version);
    const envMeta = JSON.parse(row.envelope_json);
    const args = JSON.parse(row.arguments_json);
    const resolved: ResolvedTarget = envMeta.resolved;
    const post: Condition[] = envMeta.postconditions;
    const semId = row.semantic_operation_id;
    let status: ActionState = row.status;
    if (status === 'DISPATCHING') { store.transitionAttempt(attemptId, 'OUTCOME_UNKNOWN', { uncertainty: 'interrupted during dispatch' }); status = 'OUTCOME_UNKNOWN'; }
    if (status === 'OUTCOME_UNKNOWN' || status === 'OBSERVED_SUCCESS' || status === 'UNRESOLVED') {
      store.transitionAttempt(attemptId, 'RECONCILING');
      status = 'RECONCILING';
    }
    if (status !== 'RECONCILING') return { verdict: 'REJECTED', reason: `attempt in ${status}, nothing to reconcile`, attempt_id: attemptId };
    if (!tool) {
      store.transitionAttempt(attemptId, 'UNRESOLVED', { uncertainty: 'tool adapter unavailable for reconciliation' });
      return { verdict: 'UNRESOLVED', reason: 'tool adapter unavailable', attempt_id: attemptId, semantic_operation_id: semId };
    }
    const ctx: AdapterContext = { store, attemptId, taskId: row.task_id, deviceId: this.d.deviceId,
      signal: this.inflight.get(attemptId)?.controller.signal ?? new AbortController().signal, services: this.d.services ?? {} };
    fault('reconcile.mid');
    let r;
    try { r = await tool.reconcile(args, resolved, post, ctx); } catch (e) { r = { status: 'unknown' as const, evidence: { error: (e as Error).message } }; }
    if (r.status === 'applied') {
      let v: { verdict: string; evidence: unknown };
      try { v = await tool.verify(args, resolved, post, JSON.parse(row.receipt_json ?? 'null'), ctx); }
      catch (e) { v = { verdict: 'inconclusive', evidence: { error: (e as Error).message } }; }
      if (v.verdict === 'inconclusive') {
        store.transitionAttempt(attemptId, 'UNRESOLVED', { uncertainty: 'applied but verification inconclusive', evidence_json: canonical({ reconciled: r.evidence, verify: v.evidence }) });
        return { verdict: 'UNRESOLVED', reason: 'effect applied but could not be verified', attempt_id: attemptId, semantic_operation_id: semId };
      }
      if (v.verdict === 'verified') {
        store.tx(() => {
          store.transitionAttempt(attemptId, 'VERIFIED', { evidence_json: canonical({ reconciled: r.evidence, verify: v.evidence }) });
          store.transitionAttempt(attemptId, 'COMMITTED');
        });
        return { verdict: 'COMMITTED', reason: 'reconciled: effect applied and verified', attempt_id: attemptId, semantic_operation_id: semId, evidence: v.evidence };
      }
      store.transitionAttempt(attemptId, 'FAILED', { error: 'applied but postconditions not met', evidence_json: canonical({ reconciled: r.evidence, verify: v.evidence }) });
      return { verdict: 'FAILED', reason: 'reconciled effect does not satisfy postconditions', attempt_id: attemptId, semantic_operation_id: semId };
    }
    if (r.status === 'not_applied') {
      store.tx(() => {
        store.transitionAttempt(attemptId, 'PROVEN_NOT_APPLIED', { evidence_json: canonical(r.evidence ?? null) });
        store.transitionAttempt(attemptId, 'RETRY_ELIGIBLE');
      });
      return { verdict: 'RETRY_ELIGIBLE', reason: 'reconciled: proven not applied', attempt_id: attemptId, semantic_operation_id: semId };
    }
    store.transitionAttempt(attemptId, 'UNRESOLVED', { uncertainty: 'reconciliation could not determine outcome', evidence_json: canonical(r.evidence ?? null) });
    return { verdict: 'UNRESOLVED', reason: 'outcome remains unknown', attempt_id: attemptId, semantic_operation_id: semId };
  }

  /** Startup recovery for attempts (handoff §9.4 steps 4–6). */
  async recover(): Promise<{ attempt_id: string; result: string }[]> {
    const { store } = this.d;
    const out: { attempt_id: string; result: string }[] = [];
    const rows = store.db.prepare(`SELECT attempt_id, status FROM attempts WHERE status IN
      ('PROPOSED','VALIDATED','AUTHORIZED','PREPARED','DISPATCHING','OBSERVED_SUCCESS','OUTCOME_UNKNOWN','RECONCILING')
      ORDER BY created_at`).all() as any[];
    for (const r of rows) {
      if (['PROPOSED', 'VALIDATED'].includes(r.status)) {
        store.transitionAttempt(r.attempt_id, 'REJECTED', { error: 'interrupted before authorization' });
        out.push({ attempt_id: r.attempt_id, result: 'REJECTED' });
      } else if (['AUTHORIZED', 'PREPARED'].includes(r.status)) {
        // Never dispatched (DISPATCHING is persisted before any adapter call): safe to cancel; the
        // executor resubmits under the same semantic operation identity.
        store.transitionAttempt(r.attempt_id, 'CANCELLED', { error: 'interrupted before dispatch' });
        out.push({ attempt_id: r.attempt_id, result: 'CANCELLED_NOT_DISPATCHED' });
      } else {
        try {
          const res = await this.reconcileAttempt(r.attempt_id);
          out.push({ attempt_id: r.attempt_id, result: res.verdict });
        } catch (e) {
          // Recovery must survive any single attempt (F-03).
          store.tx(() => store.event('attempt', r.attempt_id, 'recovery_error', { error: String((e as Error).message).slice(0, 300) }));
          out.push({ attempt_id: r.attempt_id, result: 'RECOVERY_ERROR' });
        }
      }
    }
    return out;
  }
}
