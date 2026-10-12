// Owner control: emergency stop, pause, resume, cancel, revise (REQ-27, §7.4, §16.4).
// Stop is model-independent: one synchronous SQLite transaction sets the
// latch and advances every live task's cancellation generation. The broker
// re-reads both inside the same transaction that persists DISPATCHING, so
// after this transaction commits (the acknowledgement point) no action admitted
// under an older generation can dispatch.
import type { Store } from '../store/db.ts';
import { TASK_TERMINAL, TASK_TRANSITIONS, type TaskState } from '../domain/machines.ts';
import { fault } from '../util/fault.ts';
import type { Tasks } from './tasks.ts';

export interface StopAck {
  generation: number;
  acknowledged_at: string;
  ack_ms: number;
  tasks_paused: string[];
  in_flight: { attempt_id: string; task_id: string; tool_id: string; status: string }[];
}

export class Control {
  private store: Store;
  private tasks: Tasks;
  /** Called after state changes so cancellable owned work (processes, desktop input) can be stopped. */
  onStop: ((ack: StopAck) => void)[] = [];
  onCancel: ((taskIds: string[]) => void)[] = [];
  onPause: ((taskIds: string[]) => void)[] = [];
  onRevise: ((taskIds: string[]) => void)[] = [];

  constructor(store: Store, tasks: Tasks) { this.store = store; this.tasks = tasks; }

  stopAll(source: string, reason = 'owner stop'): StopAck {
    const t0 = performance.now();
    const ack = this.store.tx(() => {
      const latch = this.store.stopLatch();
      const gen = latch.generation + 1;
      this.store.db.prepare(`UPDATE stop_latch SET generation=?, stopped=1, reason=?, source=?, updated_at=? WHERE id=1`)
        .run(gen, reason, source, this.store.now());
      const live = this.store.db.prepare(`SELECT task_id, status FROM tasks WHERE status NOT IN ('COMPLETED','CANCELLED','FAILED')`).all() as any[];
      const paused: string[] = [];
      for (const t of live) {
        this.store.db.prepare('UPDATE tasks SET cancellation_generation = cancellation_generation + 1 WHERE task_id=?').run(t.task_id);
        if (TASK_TRANSITIONS[t.status as TaskState].includes('PAUSED_BY_OWNER')) {
          this.store.transitionTask(t.task_id, 'PAUSED_BY_OWNER', { wait_reason: `stopped by ${source}` }, 'owner stop');
          paused.push(t.task_id);
        }
      }
      const inFlight = this.store.db.prepare(`SELECT attempt_id, task_id, tool_id, status FROM attempts
        WHERE status IN ('DISPATCHING','OBSERVED_SUCCESS','OUTCOME_UNKNOWN','RECONCILING','UNRESOLVED')`).all() as any[];
      this.store.event('control', 'stop_latch', 'stop', { generation: gen, source, reason, paused: paused.length, in_flight: inFlight.length });
      return { generation: gen, acknowledged_at: this.store.now(), ack_ms: 0, tasks_paused: paused, in_flight: inFlight };
    });
    ack.ack_ms = performance.now() - t0;
    fault('stop.after_latch');
    for (const f of this.onStop) { try { f(ack); } catch { /* best effort: latch is already durable */ } }
    return ack;
  }

  /** Clears the latch. Paused tasks stay paused until resumed individually or with resumeTasks. */
  clearStop(source: string): void {
    this.store.tx(() => {
      this.store.db.prepare(`UPDATE stop_latch SET stopped=0, reason=NULL, source=?, updated_at=? WHERE id=1`).run(source, this.store.now());
      this.store.event('control', 'stop_latch', 'clear', { source });
    });
  }

  pause(taskId: string, source: string): void {
    this.store.tx(() => {
      this.store.db.prepare('UPDATE tasks SET cancellation_generation = cancellation_generation + 1 WHERE task_id=?').run(taskId);
      this.store.transitionTask(taskId, 'PAUSED_BY_OWNER', { wait_reason: `paused by ${source}` }, 'owner pause');
    });
    for (const f of this.onPause) { try { f([taskId]); } catch { /* state is already durable */ } }
  }

  resume(taskId: string, source: string): void {
    this.store.tx(() => {
      if (this.store.stopLatch().stopped) throw new Error('global stop is active; clear it first');
      this.store.transitionTask(taskId, 'READY', { wait_reason: null }, `owner resume (${source})`);
    });
  }

  /** Cancel a task and all descendants; terminal CANCELLED once no unsettled effects remain. */
  cancel(taskId: string, source: string): string[] {
    const ids = [taskId, ...this.tasks.descendants(taskId)];
    const affected: string[] = [];
    this.store.tx(() => {
      for (const id of ids) {
        const st = this.store.taskStatus(id);
        if (TASK_TERMINAL.has(st)) continue;
        this.store.db.prepare('UPDATE tasks SET cancellation_generation = cancellation_generation + 1 WHERE task_id=?').run(id);
        if (st !== 'CANCEL_REQUESTED') this.store.transitionTask(id, 'CANCEL_REQUESTED', {}, `cancel by ${source}`);
        // Child grants lose authority with the parent task.
        this.store.db.prepare(`UPDATE workers SET status='FENCED', ended_at=? WHERE task_id=? AND status IN ('STARTING','RUNNING')`).run(this.store.now(), id);
        affected.push(id);
      }
    });
    for (const f of this.onCancel) { try { f(affected); } catch { /* best effort */ } }
    return affected;
  }

  /** Settle CANCEL_REQUESTED tasks whose effects are all settled; report effects truthfully. */
  finalizeCancellations(): { task_id: string; effects: Record<string, number> }[] {
    const out: { task_id: string; effects: Record<string, number> }[] = [];
    const rows = this.store.db.prepare(`SELECT task_id FROM tasks WHERE status='CANCEL_REQUESTED'`).all() as any[];
    for (const r of rows) {
      const unsettled = this.store.db.prepare(`SELECT count(*) c FROM attempts WHERE task_id=? AND status IN
        ('PREPARED','DISPATCHING','OBSERVED_SUCCESS','OUTCOME_UNKNOWN','RECONCILING')`).get(r.task_id) as any;
      if (unsettled.c > 0) continue;
      const counts = Object.fromEntries((this.store.db.prepare(`SELECT status, count(*) c FROM attempts WHERE task_id=? GROUP BY status`).all(r.task_id) as any[]).map((x) => [x.status, x.c]));
      const report = { committed_effects: counts.COMMITTED ?? 0, uncertain_effects: counts.UNRESOLVED ?? 0, stopped_before_dispatch: counts.CANCELLED ?? 0 };
      this.store.transitionTask(r.task_id, 'CANCELLED', { result_json: JSON.stringify({ cancelled: true, ...report, note: 'cancellation is not rollback' }) });
      out.push({ task_id: r.task_id, effects: report });
    }
    return out;
  }

  revise(taskId: string, goal: string, criteria: any, sourceCommandId: string | null): number {
    const revision = this.store.tx(() => {
      const rev = this.tasks.revise(taskId, goal, criteria, sourceCommandId);
      this.store.db.prepare('UPDATE tasks SET cancellation_generation = cancellation_generation + 1 WHERE task_id=?').run(taskId);
      const st = this.store.taskStatus(taskId);
      if (TASK_TRANSITIONS[st].includes('PLANNING')) this.store.transitionTask(taskId, 'PLANNING', {}, 'revised by owner');
      return rev;
    });
    for (const f of this.onRevise) { try { f([taskId]); } catch { /* revision is already durable */ } }
    return revision;
  }
}
