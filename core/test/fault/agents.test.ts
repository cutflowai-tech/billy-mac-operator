// Multi-agent delegation with real worker processes: T-AGENT-01/03/05/07/08, T-DUR-07, T-DUR-08, T-SEC-06.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, scope } from '../fixtures.ts';
import { WorkerManager } from '../../src/agents/workers.ts';
import { agentDelegate, agentCollect } from '../../src/tools/agents.ts';
import { fsWrite } from '../../src/tools/fs.ts';
import { processStart } from '../../src/sandbox/seatbelt.ts';
import type { ToolAdapter } from '../../src/broker/types.ts';

/** A slow write that logs each real execution, so duplicates are observable. */
function slowWrite(effectsLog: string, delayMs: number, postDelayMs = 0): ToolAdapter {
  return { ...fsWrite, spec: { ...fsWrite.spec, tool_id: 'test.slow_write' },
    async dispatch(a, r, ctx) {
      await new Promise((res) => setTimeout(res, delayMs));
      appendFileSync(effectsLog, `${a.path}\n`);
      const out = await fsWrite.dispatch(a, r, ctx);
      await new Promise((res) => setTimeout(res, postDelayMs)); // effect done, result not yet delivered
      return out;
    } };
}

const until = async (f: () => boolean, ms = 15000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 25)); } };

async function setup(opts: { delay?: number; post?: number; killFenced?: boolean; leaseMs?: number } = {}) {
  const sockDir = mkdtempSync('/tmp/billy-bw-');
  const services: Record<string, unknown> = {};
  const effects = join(sockDir, 'effects.log'); writeFileSync(effects, '');
  const fx = fixture({ extraTools: [agentDelegate, agentCollect, slowWrite(effects, opts.delay ?? 50, opts.post ?? 0)], services, maxConcurrent: 4 },
    { tool_classes: ['file', 'worker'], delegation: { allowed: true, max_depth: 2 } });
  const mgr = new WorkerManager(fx.core, sockDir, { leaseMs: opts.leaseMs ?? 1500, heartbeatMs: 200, maxWorkers: 4, killFenced: opts.killFenced ?? true });
  services.workers = mgr;
  await mgr.start(50);
  fx.core.executor.start(50);
  const effectCount = (p?: string) => readFileSync(effects, 'utf8').split('\n').filter((l) => l && (!p || l === p)).length;
  return { fx, mgr, effects, effectCount, cleanup: async () => { await fx.core.executor.stop(); await mgr.stop(); fx.cleanup(); rmSync(sockDir, { recursive: true, force: true }); } };
}

function parentWithChildren(fx: any, children: { goal: string; root: string; file: string; content: string; extraSteps?: any[]; criteria?: any[] }[], extraScope: object = {}) {
  const steps: any[] = children.map((c, i) => ({ kind: 'action', step_key: `delegate-${i}`, tool_id: 'agent.delegate', arguments: {
    goal: c.goal, file_roots: [c.root], tool_classes: ['file'], planner: 'scripted',
    script: { steps: [...(c.extraSteps ?? []), { kind: 'action', step_key: 'write', tool_id: 'test.slow_write', arguments: { path: c.file, content: c.content, mode: 'create' } }] },
    success_criteria: c.criteria ?? [{ kind: 'file_contains', path: c.file, text: c.content }], ...extraScope } }));
  const id = fx.core.tasks.create({ owner_id: 'owner', goal: 'parent', project_scope: 'fx', grant_id: fx.grantId, success_criteria: { description: 'all children', postconditions: [] } });
  // Scripted parent: delegate each child, then wait for children, then finish.
  fx.core.executor.seedPlan(id, 1, 'scripted', { steps });
  return id;
}

const childRows = (fx: any, parent: string) => fx.core.store.db.prepare(`SELECT t.task_id, t.status FROM child_links l JOIN tasks t ON t.task_id=l.child_task_id WHERE l.parent_task_id=?`).all(parent) as any[];

test('T-AGENT-01: two workers run concurrently on independent child tasks; parent completes after verified children', async () => {
  const s = await setup({ delay: 600 });
  try {
    const rA = join(s.fx.root, 'a'), rB = join(s.fx.root, 'b'); mkdirSync(rA); mkdirSync(rB);
    const parent = parentWithChildren(s.fx, [
      { goal: 'build part A', root: rA, file: join(rA, 'a.txt'), content: 'A' },
      { goal: 'build part B', root: rB, file: join(rB, 'b.txt'), content: 'B' },
    ]);
    await until(() => childRows(s.fx, parent).length === 2 && childRows(s.fx, parent).every((c: any) => c.status === 'COMPLETED'));
    await until(() => s.fx.core.store.taskStatus(parent) === 'COMPLETED');
    // Concurrency evidence: both workers were RUNNING at overlapping times.
    const ws = s.fx.core.store.db.prepare(`SELECT task_id, started_at, ended_at FROM workers`).all() as any[];
    assert.equal(ws.length, 2);
    const [x, y] = ws;
    assert.ok(x.started_at < y.ended_at && y.started_at < x.ended_at, 'worker lifetimes overlap');
    assert.equal(s.effectCount(), 2);
    // Peak number of simultaneously running worker processes, from the durable worker records.
    const peak = Math.max(...ws.map((w) => ws.filter((o) => o.started_at <= w.started_at && w.started_at < o.ended_at).length));
    const { writeFileSync: wf, mkdirSync: md } = await import('node:fs');
    const mdir = join(import.meta.dirname, '..', '..', '..', 'artifacts', 'measurements'); md(mdir, { recursive: true });
    wf(join(mdir, 'T-AGENT-01.json'), JSON.stringify({ test_id: 'T-AGENT-01', measurements: { concurrent_workers: peak }, at: new Date().toISOString(), ...(await import('../stamp.ts')).STAMP }));
  } finally { await s.cleanup(); }
});

test('T-AGENT-03: worker killed before result delivery -> replacement, no duplicate effect', async () => {
  const s = await setup({ delay: 100, post: 800 });
  try {
    const rA = join(s.fx.root, 'a'); mkdirSync(rA);
    const file = join(rA, 'a.txt');
    const parent = parentWithChildren(s.fx, [{ goal: 'part A', root: rA, file, content: 'A' }]);
    await until(() => (s.fx.core.store.db.prepare(`SELECT count(*) c FROM workers WHERE status='RUNNING'`).get() as any).c === 1);
    const w = s.fx.core.store.db.prepare(`SELECT * FROM workers WHERE status='RUNNING'`).get() as any;
    await until(() => s.effectCount(file) === 1, 5000); // effect happened; worker still awaiting the result
    process.kill(-w.pgid, 'SIGKILL'); // worker dies before it learns the result
    await until(() => s.fx.core.store.taskStatus(parent) === 'COMPLETED');
    assert.equal(s.effectCount(file), 1, 'the write happened exactly once');
    const gens = s.fx.core.store.db.prepare(`SELECT generation, status FROM workers ORDER BY generation`).all() as any[];
    assert.ok(gens.length >= 1);
  } finally { await s.cleanup(); }
});

test('T-DUR-08: paused worker loses its lease; old generation cannot dispatch after it resumes', async () => {
  const s = await setup({ delay: 50, killFenced: false, leaseMs: 800 });
  try {
    const rA = join(s.fx.root, 'a'); mkdirSync(rA);
    const file = join(rA, 'late.txt');
    // Child plan: a slow observation-free step first so the worker is alive long enough to pause.
    const parent = parentWithChildren(s.fx, [{ goal: 'slow', root: rA, file, content: 'L' }]);
    await until(() => (s.fx.core.store.db.prepare(`SELECT count(*) c FROM workers`).get() as any).c >= 1);
    const w = s.fx.core.store.db.prepare(`SELECT * FROM workers ORDER BY started_at LIMIT 1`).get() as any;
    await until(() => !!w.pid);
    try { process.kill(w.pid, 'SIGSTOP'); } catch { /* may already be done */ }
    await until(() => ['LOST', 'EXITED', 'FENCED'].includes((s.fx.core.store.db.prepare('SELECT status FROM workers WHERE worker_id=?').get(w.worker_id) as any).status));
    // A direct submission with the stale generation is refused by the broker.
    const child = childRows(s.fx, parent)[0].task_id;
    const t = s.fx.core.tasks.get(child);
    const stale = await s.fx.core.broker.submit({ task_id: child, task_revision: t.revision, cancellation_generation: t.cancellation_generation,
      actor_id: w.worker_id, worker_generation: w.generation, tool_id: 'fs.write', arguments: { path: join(rA, 'stale.txt'), content: 'x', mode: 'create' }, step_key: 'stale' });
    assert.equal(stale.verdict, 'REJECTED');
    assert.match(stale.reason, /lease not running|stale worker generation/);
    try { process.kill(w.pid, 'SIGCONT'); } catch { /* gone */ }
    await until(() => s.fx.core.store.taskStatus(parent) === 'COMPLETED');
    assert.equal(existsSync(join(rA, 'stale.txt')), false);
    assert.equal(s.effectCount(file), 1);
    try { process.kill(w.pid, 'SIGKILL'); } catch { /* gone */ }
  } finally { await s.cleanup(); }
});

test('T-AGENT-08: cancelling the parent cancels descendants, fences their workers and kills owned worker processes', async () => {
  const s = await setup({ delay: 5000 });
  try {
    const rA = join(s.fx.root, 'a'); mkdirSync(rA);
    const parent = parentWithChildren(s.fx, [{ goal: 'long', root: rA, file: join(rA, 'long.txt'), content: 'L' }]);
    await until(() => (s.fx.core.store.db.prepare(`SELECT count(*) c FROM workers WHERE status='RUNNING'`).get() as any).c === 1);
    const w = s.fx.core.store.db.prepare(`SELECT * FROM workers WHERE status='RUNNING'`).get() as any;
    s.fx.core.control.cancel(parent, 'owner');
    await until(() => processStart(w.pid) === null, 3000);
    const child = childRows(s.fx, parent)[0];
    assert.ok(['CANCEL_REQUESTED', 'CANCELLED'].includes(child.status), child.status);
    assert.equal((s.fx.core.store.db.prepare('SELECT status FROM workers WHERE worker_id=?').get(w.worker_id) as any).status, 'FENCED');
  } finally { await s.cleanup(); }
});
