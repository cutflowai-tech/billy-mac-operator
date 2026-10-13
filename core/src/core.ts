// Composition root for the Billy core. Every product entry point (daemon,
// tests, CLI) builds the same graph so there is exactly one broker path.
import { Store, type OpenOptions } from './store/db.ts';
import { PolicyStore } from './policy/policy.ts';
import { Budget } from './budget/budget.ts';
import { Claims } from './scheduler/claims.ts';
import { Broker, ToolRegistry } from './broker/broker.ts';
import { FILE_TOOLS } from './tools/fs.ts';
import type { ToolAdapter } from './broker/types.ts';
import { Tasks } from './tasks/tasks.ts';
import { Control } from './tasks/control.ts';
import { Inbox } from './inbox/inbox.ts';
import { Outbox } from './notify/outbox.ts';
import { Executor, type Planner, type TaskVerifier } from './scheduler/executor.ts';
import { scriptedPlanner } from './planner/scripted.ts';
import { CriteriaVerifier } from './verify/taskVerifier.ts';
import { killOwnedProcesses } from './tools/proc.ts';
import { digest } from './util/canon.ts';

export interface CoreOptions extends OpenOptions {
  deviceId?: string;
  extraTools?: ToolAdapter[];
  includeFileTools?: boolean;
  services?: Record<string, unknown>;
  planners?: Planner[];
  verifier?: TaskVerifier;
  maxConcurrent?: number;
  ownerNotifyChannel?: { channel: string; destination: string } | null;
}

export class Core {
  readonly store: Store;
  readonly policy: PolicyStore;
  readonly budget: Budget;
  readonly claims: Claims;
  readonly registry: ToolRegistry;
  readonly broker: Broker;
  readonly tasks: Tasks;
  readonly control: Control;
  readonly inbox: Inbox;
  readonly outbox: Outbox;
  readonly executor: Executor;
  readonly planners = new Map<string, Planner>();
  readonly deviceId: string;
  notifyTargets: { channel: string; destination: string }[] = [];

  constructor(opts: CoreOptions) {
    this.store = Store.open(opts);
    this.policy = new PolicyStore(this.store);
    this.budget = new Budget(this.store);
    this.claims = new Claims(this.store);
    this.registry = new ToolRegistry();
    if (opts.includeFileTools !== false) for (const t of FILE_TOOLS) this.registry.register(t);
    for (const t of opts.extraTools ?? []) this.registry.register(t);
    this.deviceId = opts.deviceId ?? 'mac-local';
    this.broker = new Broker({ store: this.store, registry: this.registry, policy: this.policy, budget: this.budget,
      claims: this.claims, deviceId: this.deviceId, services: opts.services });
    this.tasks = new Tasks(this.store);
    this.control = new Control(this.store, this.tasks);
    this.inbox = new Inbox(this.store);
    this.outbox = new Outbox(this.store);
    for (const p of [scriptedPlanner, ...(opts.planners ?? [])]) this.planners.set(p.id, p);
    if (opts.ownerNotifyChannel) this.notifyTargets.push(opts.ownerNotifyChannel);
    this.executor = new Executor({
      store: this.store, broker: this.broker, tasks: this.tasks, control: this.control, planners: this.planners,
      plannerFor: (t) => (this.store.db.prepare('SELECT planner FROM plans WHERE task_id=? AND revision=?').get(t.task_id, t.revision) as any)?.planner ?? 'model',
      verifier: opts.verifier ?? new CriteriaVerifier([], this.policy), maxConcurrent: opts.maxConcurrent,
      notify: (kind, taskId, text) => this.notify(kind, taskId, text),
      readOnlyTools: () => this.registry.list().filter((t) => t.spec.effect_class === 'READ_ONLY').map((t) => t.spec.tool_id),
    });
    this.control.onStop.push((ack) => {
      for (const id of ack.tasks_paused) this.claims.withdraw(`task:${id}`);
      this.executor.abort('all');
      this.broker.abort('all');
      killOwnedProcesses(this.store, (this.store.db.prepare(`SELECT DISTINCT task_id FROM processes WHERE ended_at IS NULL`).all() as any[]).map((r) => r.task_id));
    });
    const interrupt = (ids: string[]) => {
      for (const id of ids) this.claims.withdraw(`task:${id}`);
      this.executor.abort(ids);
      this.broker.abort(ids); killOwnedProcesses(this.store, ids);
    };
    this.control.onCancel.push(interrupt);
    this.control.onPause.push(interrupt);
    this.control.onRevise.push((ids) => {
      for (const id of ids) this.claims.withdraw(`task:${id}`);
      // Replace the plan immediately; already-dispatched effects must still settle.
      this.executor.abort(ids);
    });
    this.claims.onRelease.push(() => this.executor.wake('resource_released'));
  }

  /**
   * Event-driven owner updates (§16.3): one message per meaningful state, deduplicated by
   * (task, kind, revision, text digest) so an unchanged blocker is never re-sent.
   */
  notify(kind: string, taskId: string, text: string): void {
    const t = this.store.db.prepare('SELECT revision FROM tasks WHERE task_id=?').get(taskId) as any;
    const title = { completed: 'Done', failed: 'Failed', blocked: 'Blocked', needs_authority: 'Needs your authority',
      budget: 'Paused for budget', uncertain: 'Checking an uncertain result', admitted: 'Got it', progress: 'Progress' }[kind] ?? kind;
    for (const target of this.notifyTargets) {
      const key = `${taskId}:${t?.revision ?? 0}:${kind}:${digest(text).slice(0, 32)}:${target.channel}`;
      this.outbox.enqueue(key, target.channel, target.destination, title, text, taskId);
    }
  }

  /** Startup recovery sequence (handoff §9.4). */
  async recover(): Promise<{ attempts: unknown[]; outbox: number; workers: number; cancellations: unknown[] }> {
    const attempts = await this.broker.recover();
    this.claims.clearAll();
    const workers = Number(this.store.tx(() => this.store.db.prepare(`UPDATE workers SET status='LOST', ended_at=? WHERE status IN ('STARTING','RUNNING')`).run(this.store.now())).changes);
    const outbox = this.outbox.recover();
    // Tasks that were RUNNING when the process died go back through READY; their last
    // actions were already reconciled above, and the planner sees the true history.
    this.store.tx(() => {
      // RECOVERING too: a crash between the two halves of a RECOVERING hop must not strand the task.
      const rows = this.store.db.prepare(`SELECT task_id, status FROM tasks WHERE status IN ('RUNNING','VERIFYING','RECOVERING')`).all() as any[];
      const stopped = this.store.stopLatch().stopped;
      for (const r of rows) {
        if (r.status !== 'RECOVERING') this.store.transitionTask(r.task_id, 'RECOVERING', {}, 'process restart');
        // F-13: under an active stop latch recovered work stays paused until explicit resume.
        this.store.transitionTask(r.task_id, stopped ? 'PAUSED_BY_OWNER' : 'READY', {}, stopped ? 'recovered under stop latch' : 'recovered');
      }
      const rec = this.store.db.prepare(`SELECT task_id FROM tasks WHERE status='RECONCILING'`).all() as any[];
      for (const r of rec) this.store.transitionTask(r.task_id, stopped ? 'PAUSED_BY_OWNER' : 'READY', {}, 'reconciled at startup');
    });
    // Tasks blocked only on reconciliation are retried once the attempts above are settled.
    const blocked = this.store.db.prepare(`SELECT task_id FROM tasks WHERE status='BLOCKED_EXTERNAL' AND wait_condition='reconcile'`).all() as any[];
    for (const b of blocked) {
      const open = this.store.db.prepare(`SELECT count(*) c FROM attempts WHERE task_id=? AND status IN ('UNRESOLVED','RECONCILING','OUTCOME_UNKNOWN')`).get(b.task_id) as any;
      if (!open.c) this.store.transitionTask(b.task_id, 'READY', { wait_reason: null, wait_condition: null }, 'reconciliation settled');
    }
    // Claims and their FIFO queues were cleared above: tasks waiting for a resource will never see a release
    // event for it, so they retry now (and queue again in arrival order if the resource is still contended).
    this.executor.wake('resource_released');
    const cancellations = this.control.finalizeCancellations();
    this.store.tx(() => this.store.event('core', 'recovery', 'completed', { attempts: attempts.length, outbox, workers, cancellations: cancellations.length }));
    return { attempts, outbox, workers, cancellations };
  }

  close(): void { this.store.close(); }
}
