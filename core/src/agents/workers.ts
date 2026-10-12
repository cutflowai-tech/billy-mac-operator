// Multi-agent delegation (handoff §13, REQ-19/20, ADR-0004).
// Child tasks are driven by separate OS worker processes that hold a lease
// (worker id + per-task generation + heartbeat). Each step a worker requests
// runs through the core executor/broker under the worker's identity, so there
// is still one broker, one retry owner and one budget. Lost or stalled workers
// are fenced (generation advanced) and their identity-verified process group is
// killed before a replacement is admitted. Child authority is always the
// intersection of the parent's effective grant and the request.
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import type { Core } from '../core.ts';
import { intersectScope, type GrantScope } from '../policy/policy.ts';
import { processStart, killGroup } from '../sandbox/seatbelt.ts';
import type { Condition } from '../contracts/action.ts';
import { TASK_TERMINAL } from '../domain/machines.ts';
import { fault } from '../util/fault.ts';

export interface DelegationRequest {
  goal: string;
  scope: Partial<GrantScope>;           // requested subset (never more than the parent)
  success_criteria: Condition[];
  planner: 'model' | 'scripted';
  script?: unknown;                     // scripted plan state
}

export interface WorkerOptions { leaseMs: number; heartbeatMs: number; maxWorkers: number; killFenced: boolean; workerEntry?: string; nodePath?: string }
export const DEFAULT_WORKERS: WorkerOptions = { leaseMs: 5000, heartbeatMs: 1000, maxWorkers: 3, killFenced: true };

const digestToken = (t: string) => createHash('sha256').update(t).digest('hex');

export class WorkerManager {
  private core: Core;
  readonly opts: WorkerOptions;
  readonly socketPath: string;
  private server: Server | null = null;
  private timer: NodeJS.Timeout | null = null;
  private executing = new Map<string, number>(); // task_id -> in-flight core steps
  /** Monotonic heartbeat times (immune to wall-clock jumps); wall time is display-only. */
  private beats = new Map<string, number>();
  onChildSettled: ((parent: string, child: string) => void)[] = [];
  private settledSeen = -1;

  constructor(core: Core, runDir: string, opts: Partial<WorkerOptions> = {}) {
    this.core = core;
    this.opts = { ...DEFAULT_WORKERS, ...opts };
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    this.socketPath = join(runDir, 'workers.sock');
    core.control.onCancel.push((ids) => this.fenceTasks(ids, 'cancelled'));
    core.control.onStop.push(() => this.fenceTasks(this.liveTaskIds(), 'owner stop'));
  }

  // ---------- delegation (called from the agent.delegate tool inside the broker) ----------

  delegate(parentId: string, semId: string, req: DelegationRequest): { child_task_id: string; created: boolean } {
    const { store, policy, tasks } = this.core;
    return store.tx(() => {
      const prior = store.db.prepare('SELECT child_task_id FROM child_links WHERE semantic_operation_id=?').get(semId) as any;
      if (prior) return { child_task_id: prior.child_task_id, created: false };
      const parent = tasks.get(parentId);
      if (!parent?.grant_id) throw new Error('parent has no grant');
      const pg = policy.effective(parent.grant_id);
      if (!pg) throw new Error('parent grant revoked or expired');
      if (!pg.scope.delegation.allowed) throw new Error('parent grant does not allow delegation');
      const depth = ((store.db.prepare('SELECT depth FROM child_links WHERE child_task_id=?').get(parentId) as any)?.depth ?? 0) + 1;
      // Depth is bounded by the grant chain: each child grant gets max_depth - 1 (intersectScope).
      if (pg.scope.delegation.max_depth < 1) throw new Error('delegation depth exhausted');
      const requested: GrantScope = { ...pg.scope, ...req.scope, delegation: req.scope.delegation ?? { allowed: false, max_depth: 0 } } as GrantScope;
      const childScope = intersectScope(pg.scope, requested);
      const gid = crypto.randomUUID();
      policy.putGrant({ grant_id: gid, owner_id: parent.owner_id, scope: childScope, parent_grant_id: pg.grant_id, task_id: null, expires_at: pg.expires_at, source: `delegation:${parentId}` });
      const child = tasks.create({ owner_id: parent.owner_id, goal: req.goal, project_scope: parent.project_scope, grant_id: gid,
        budget_scope: parent.budget_scope, parent_task_id: parentId, success_criteria: { description: req.goal, postconditions: req.success_criteria } });
      store.db.prepare(`UPDATE tasks SET driver='worker' WHERE task_id=?`).run(child);
      store.db.prepare('INSERT INTO child_links VALUES (?,?,?,?,?)').run(semId, parentId, child, depth, store.now());
      this.core.executor.seedPlan(child, 1, req.planner, req.planner === 'scripted' ? req.script : null);
      store.event('delegation', child, 'admitted', { parent: parentId, depth, scope_digest: policy.current(gid)!.scope_digest });
      return { child_task_id: child, created: true };
    });
  }

  // ---------- worker lifecycle ----------

  private liveTaskIds(): string[] {
    return (this.core.store.db.prepare(`SELECT DISTINCT task_id FROM workers WHERE status IN ('STARTING','RUNNING')`).all() as any[]).map((r) => r.task_id);
  }

  private nextGeneration(taskId: string): number {
    return ((this.core.store.db.prepare('SELECT max(generation) g FROM workers WHERE task_id=?').get(taskId) as any)?.g ?? 0) + 1;
  }

  spawnWorker(taskId: string): { worker_id: string; generation: number } {
    const token = randomBytes(32).toString('base64url');
    const workerId = `worker:${crypto.randomUUID()}`;
    const gen = this.core.store.tx(() => {
      const g = this.nextGeneration(taskId);
      this.core.store.db.prepare(`INSERT INTO workers(worker_id, task_id, generation, pid, pid_start, status, heartbeat_at, started_at, token_digest)
        VALUES (?,?,?,NULL,NULL,'STARTING',?,?,?)`).run(workerId, taskId, g, this.core.store.now(), this.core.store.now(), digestToken(token));
      this.core.store.event('worker', workerId, 'admitted', { task_id: taskId, generation: g });
      return g;
    });
    fault('worker.after_spawn_record');
    const entry = this.opts.workerEntry ?? join(import.meta.dirname, 'worker-main.ts');
    // Clean environment: the worker gets only its own capability (socket + token), nothing else.
    const child = spawn(this.opts.nodePath ?? process.execPath, [entry], {
      env: { PATH: '/usr/bin:/bin', BILLY_WORKER_SOCK: this.socketPath, BILLY_WORKER_ID: workerId, BILLY_WORKER_TOKEN: token,
        BILLY_WORKER_HEARTBEAT_MS: String(this.opts.heartbeatMs), BILLY_FAULT_POINTS: process.env.BILLY_WORKER_FAULT_POINTS ?? '' },
      detached: true, stdio: 'ignore',
    });
    child.unref();
    const start = child.pid ? processStart(child.pid) : null;
    this.core.store.tx(() => this.core.store.db.prepare(`UPDATE workers SET pid=?, pid_start=?, pgid=? WHERE worker_id=?`).run(child.pid ?? null, start, child.pid ?? null, workerId));
    return { worker_id: workerId, generation: gen };
  }

  /** Fence every live worker of these tasks and kill identity-verified processes. */
  fenceTasks(taskIds: string[], reason: string): number {
    let n = 0;
    for (const t of taskIds) {
      const rows = this.core.store.db.prepare(`SELECT * FROM workers WHERE task_id=? AND status IN ('STARTING','RUNNING','FENCED','LOST')`).all(t) as any[];
      for (const w of rows) {
        if (w.status === 'STARTING' || w.status === 'RUNNING') {
          this.core.store.tx(() => {
            this.core.store.db.prepare(`UPDATE workers SET status='FENCED', ended_at=? WHERE worker_id=?`).run(this.core.store.now(), w.worker_id);
            this.core.store.event('worker', w.worker_id, 'fenced', { reason, generation: w.generation });
          });
          n++;
        }
        if (this.opts.killFenced && w.pid && w.pid_start && processStart(w.pid) === w.pid_start) killGroup(w.pgid ?? w.pid);
      }
    }
    return n;
  }

  /** Periodic supervision: expire leases, fence, admit replacements, start workers for ready child tasks. */
  supervise(): void {
    const { store } = this.core;
    const now = store.clock();
    const stale = store.db.prepare(`SELECT * FROM workers WHERE status IN ('STARTING','RUNNING')`).all() as any[];
    for (const w of stale) {
      const mono = this.beats.get(w.worker_id);
      const age = mono !== undefined ? performance.now() - mono : Math.max(0, now - Date.parse(w.heartbeat_at));
      const dead = w.pid && w.pid_start && processStart(w.pid) !== w.pid_start;
      if (age > this.opts.leaseMs || dead) {
        store.tx(() => {
          store.db.prepare(`UPDATE workers SET status='LOST', ended_at=? WHERE worker_id=?`).run(store.now(), w.worker_id);
          store.event('worker', w.worker_id, 'lease_expired', { task_id: w.task_id, generation: w.generation, heartbeat_age_ms: age, process_gone: !!dead });
        });
        // Lease expiry is not proof the worker stopped: kill only if the identity still matches.
        if (this.opts.killFenced && w.pid && w.pid_start && processStart(w.pid) === w.pid_start) killGroup(w.pgid ?? w.pid);
      }
    }
    // Tasks left RUNNING by a lost worker go back through RECOVERING once no core step is executing.
    const orphaned = store.db.prepare(`SELECT t.task_id FROM tasks t WHERE t.driver='worker' AND t.status='RUNNING'
      AND NOT EXISTS (SELECT 1 FROM workers w WHERE w.task_id=t.task_id AND w.status IN ('STARTING','RUNNING'))`).all() as any[];
    for (const o of orphaned) {
      if ((this.executing.get(o.task_id) ?? 0) > 0) continue;
      store.transitionTask(o.task_id, 'RECOVERING', {}, 'worker lost');
      store.transitionTask(o.task_id, store.stopLatch().stopped ? 'PAUSED_BY_OWNER' : 'READY', {}, 'awaiting replacement worker');
    }
    if (store.stopLatch().stopped) return;
    this.core.executor.admitNew();
    const live = (store.db.prepare(`SELECT count(*) c FROM workers WHERE status IN ('STARTING','RUNNING')`).get() as any).c;
    let free = this.opts.maxWorkers - live;
    const ready = store.db.prepare(`SELECT task_id FROM tasks WHERE driver='worker' AND status='READY' ORDER BY updated_at`).all() as any[];
    for (const r of ready) {
      if (free <= 0) break;
      const hasLive = store.db.prepare(`SELECT 1 FROM workers WHERE task_id=? AND status IN ('STARTING','RUNNING')`).get(r.task_id);
      if (hasLive || (this.executing.get(r.task_id) ?? 0) > 0) continue;
      this.spawnWorker(r.task_id);
      free--;
    }
    // Wake parents whose children all settled.
    // Wake parents only when a child newly settled (no wake churn).
    const settled = (store.db.prepare(`SELECT count(*) c FROM child_links l JOIN tasks t ON t.task_id=l.child_task_id
      WHERE t.status IN ('COMPLETED','FAILED','CANCELLED')`).get() as any).c as number;
    if (settled !== this.settledSeen) { this.settledSeen = settled; this.core.executor.wake('children_settled'); }
  }

  start(intervalMs = 250): Promise<void> {
    this.timer = setInterval(() => { try { this.supervise(); } catch (e) { this.core.store.tx(() => this.core.store.event('worker', 'manager', 'error', { error: String(e).slice(0, 300) })); } }, intervalMs);
    return this.listen();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.fenceTasks(this.liveTaskIds(), 'manager stopping');
    this.core.broker.abort([...this.executing.keys()]);
    const end = Date.now() + 10_000;
    while ([...this.executing.values()].some((n) => n > 0) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  // ---------- internal worker API (Unix socket, per-worker token, generation fenced) ----------

  private authWorker(workerId: string, token: string): any | null {
    const w = this.core.store.db.prepare('SELECT * FROM workers WHERE worker_id=?').get(workerId) as any;
    if (!w || !w.token_digest) return null;
    const a = Buffer.from(w.token_digest, 'hex'), b = Buffer.from(digestToken(token), 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return w;
  }

  private listen(): Promise<void> {
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    this.server = createServer(async (req, res) => {
      const send = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      let raw = ''; for await (const c of req) { raw += c; if (raw.length > 64_000) return send(413, {}); }
      let body: any; try { body = JSON.parse(raw || '{}'); } catch { return send(400, {}); }
      const w = this.authWorker(String(req.headers['x-billy-worker'] ?? ''), String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (!w) return send(401, { error: 'unauthenticated worker' });
      const { store } = this.core;
      if (req.url === '/w/heartbeat') {
        const ok = store.tx(() => Number(store.db.prepare(`UPDATE workers SET heartbeat_at=?, status=CASE WHEN status='STARTING' THEN 'RUNNING' ELSE status END
          WHERE worker_id=? AND status IN ('STARTING','RUNNING')`).run(store.now(), w.worker_id).changes));
        if (ok) this.beats.set(w.worker_id, performance.now());
        return send(ok ? 200 : 409, { ok: !!ok, status: ok ? 'RUNNING' : 'FENCED' });
      }
      if (req.url === '/w/step') {
        const cur = store.db.prepare('SELECT status, generation FROM workers WHERE worker_id=?').get(w.worker_id) as any;
        if (!['STARTING', 'RUNNING'].includes(cur.status)) return send(409, { done: true, reason: 'fenced' });
        const t = this.core.tasks.get(w.task_id);
        if (!t || TASK_TERMINAL.has(t.status)) { this.retire(w.worker_id); return send(200, { done: true, status: t?.status }); }
        if (t.status === 'READY') store.transitionTask(w.task_id, 'RUNNING', {}, `worker ${w.worker_id} gen ${w.generation}`);
        else if (t.status !== 'RUNNING') { this.retire(w.worker_id); return send(200, { done: true, status: t.status }); }
        this.executing.set(w.task_id, (this.executing.get(w.task_id) ?? 0) + 1);
        try {
          const r = await this.core.executor.step(w.task_id, { actor_id: w.worker_id, generation: w.generation });
          fault('worker.before_result');
          const after = this.core.tasks.get(w.task_id);
          if (r === 'stop') {
            this.retire(w.worker_id);
            if (TASK_TERMINAL.has(after.status) && after.parent_task_id) for (const f of this.onChildSettled) f(after.parent_task_id, w.task_id);
          }
          return send(200, { done: r === 'stop', status: after.status });
        } finally {
          this.executing.set(w.task_id, (this.executing.get(w.task_id) ?? 1) - 1);
        }
      }
      send(404, {});
    });
    return new Promise((r) => this.server!.listen(this.socketPath, () => { chmodSync(this.socketPath, 0o600); r(); }));
  }

  private retire(workerId: string): void {
    this.core.store.tx(() => this.core.store.db.prepare(`UPDATE workers SET status='EXITED', ended_at=? WHERE worker_id=? AND status IN ('STARTING','RUNNING')`).run(this.core.store.now(), workerId));
  }
}
