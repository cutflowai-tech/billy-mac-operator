// T-REL-08 (continued), T-DUR-05, T-DUR-07, T-DUR-12, T-FOUND-04, T-AGENT-03:
// SIGKILL the core at outbox, stop-latch, scheduler, reconciliation and worker
// boundaries; a fresh process recovers with exactly-once external effects.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, realpathSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../helpers.ts';

const HERE = import.meta.dirname;
const PROC = join(HERE, '..', 'harness', 'core-proc.ts');
const RECV = join(HERE, '..', 'harness', 'receiver.ts');
const RESULTS = join(HERE, '..', '..', '..', 'artifacts', 'fault');
const N = Number(process.env.BILLY_FAULT_INJECTIONS ?? 10);
let recv: ChildProcess; let url = '';
before(async () => {
  recv = spawn(process.execPath, [RECV, '', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  url = await new Promise((res) => recv.stdout!.on('data', (d) => { const m = /LISTENING (\d+)/.exec(String(d)); if (m) res(`http://127.0.0.1:${m[1]}`); }));
  mkdirSync(RESULTS, { recursive: true });
});
after(() => recv.kill());
const stats = async () => (await fetch(`${url}/stats`)).json() as Promise<any>;
const control = (c: object) => fetch(`${url}/control`, { method: 'POST', body: JSON.stringify(c) });
function run(data: string, fx: object, faults = '', extraEnv: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [PROC, data, JSON.stringify(fx)], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, BILLY_FAULT_POINTS: faults, ...extraEnv } });
  const last = r.stdout.trim().split('\n').filter(Boolean).pop();
  return { status: r.status, signal: r.signal, out: last ? JSON.parse(last) : null, err: r.stderr };
}
const record = (row: object) => appendFileSync(join(RESULTS, 'broker-boundaries.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n');
function caseDir() { const t = tempDir('billy-core-fault-'); const d = realpathSync(t.dir); const root = join(d, 'root'); mkdirSync(root); return { t, data: join(d, 'data'), root }; }

for (const b of ['outbox.after_sending_mark', 'outbox.after_send']) {
  test(`T-DUR-05 T-REL-08: SIGKILL at ${b} x${N} -> notification delivered exactly once after recovery`, async () => {
    for (let i = 0; i < N; i++) {
      const { t, data, root } = caseDir();
      try {
        const key = `k-${b}-${i}-${Math.random()}`;
        assert.equal(run(data, { mode: 'outbox-setup', receiver: url, root, key }).status, 0);
        const s0 = await stats();
        const c = run(data, { mode: 'outbox-run', receiver: url, root }, b);
        assert.equal(c.signal, 'SIGKILL', c.err);
        const r = run(data, { mode: 'outbox-recover', receiver: url, root });
        assert.equal(r.status, 0, r.err);
        assert.equal(r.out.outbox[0].status, 'DELIVERED');
        assert.equal((await stats()).effects - s0.effects, 1);
        record({ tool: 'outbox', boundary: b, injection: i, result: 'PASS' });
      } finally { t.cleanup(); }
    }
  });
}

test(`T-REL-08: SIGKILL at scheduler.after_task_running x${N} -> task completes, each send exactly once`, async () => {
  for (let i = 0; i < N; i++) {
    const { t, data, root } = caseDir();
    try {
      const s = run(data, { mode: 'task-setup', receiver: url, root, steps: 2, tag: `sched-${i}-${Math.random()}` });
      const s0 = await stats();
      const c = run(data, { mode: 'run', receiver: url, root, task_id: s.out.task_id }, 'scheduler.after_task_running');
      assert.equal(c.signal, 'SIGKILL');
      const r = run(data, { mode: 'run', receiver: url, root, task_id: s.out.task_id });
      assert.equal(r.out.status, 'COMPLETED', r.err);
      assert.equal((await stats()).effects - s0.effects, 2);
      record({ tool: 'scheduler', boundary: 'scheduler.after_task_running', injection: i, result: 'PASS' });
    } finally { t.cleanup(); }
  }
});

test(`T-REL-08: crash in dispatch then SIGKILL again at reconcile.mid during recovery x${N} -> exactly once`, async () => {
  for (let i = 0; i < N; i++) {
    const { t, data, root } = caseDir();
    try {
      const s = run(data, { mode: 'task-setup', receiver: url, root, steps: 1, tag: `rec-${i}-${Math.random()}` });
      const s0 = await stats();
      assert.equal(run(data, { mode: 'run', receiver: url, root, task_id: s.out.task_id }, 'broker.after_adapter_call').signal, 'SIGKILL');
      assert.equal(run(data, { mode: 'run', receiver: url, root, task_id: s.out.task_id }, 'reconcile.mid').signal, 'SIGKILL');
      const r = run(data, { mode: 'run', receiver: url, root, task_id: s.out.task_id });
      assert.equal(r.out.status, 'COMPLETED', r.err);
      assert.equal((await stats()).effects - s0.effects, 1);
      record({ tool: 'reconcile', boundary: 'reconcile.mid', injection: i, result: 'PASS' });
    } finally { t.cleanup(); }
  }
});

test(`T-DUR-12 T-REL-08: SIGKILL right after the stop latch commits x${N} -> latch persists, no later dispatch`, async () => {
  for (let i = 0; i < N; i++) {
    const { t, data, root } = caseDir();
    try {
      const s = run(data, { mode: 'task-setup', receiver: url, root, steps: 4, tag: `stop-${i}-${Math.random()}` });
      await control({ mode: 'delay', n: 1, delay_ms: 300 });
      const s0 = await stats();
      const c = run(data, { mode: 'run-stop', receiver: url, root, task_id: s.out.task_id }, 'stop.after_latch');
      assert.equal(c.signal, 'SIGKILL');
      await new Promise((r) => setTimeout(r, 400));
      const r = run(data, { mode: 'recover-only', receiver: url, root, task_id: s.out.task_id, after: '0000' });
      assert.equal(r.out.stopped, true);
      assert.equal(r.out.status, 'PAUSED_BY_OWNER');
      assert.ok((await stats()).effects - s0.effects <= 1, 'at most the single in-flight effect landed');
      const att = run(data, { mode: 'recover-only', receiver: url, root, task_id: s.out.task_id, after: new Date().toISOString() });
      assert.equal(att.out.dispatched_after, 0, 'nothing dispatched after restart under the latch');
      record({ tool: 'stop', boundary: 'stop.after_latch', injection: i, result: 'PASS' });
    } finally { await control({ mode: 'normal' }); t.cleanup(); }
  }
});

for (const b of ['worker.after_spawn_record', 'worker.before_result']) {
  test(`T-DUR-07 T-FOUND-04 T-REL-08: core SIGKILL at ${b} x${N} -> children settle, parent completes, child effect exactly once`, async () => {
    for (let i = 0; i < N; i++) {
      const { t, data, root } = caseDir();
      const sock = mkdtempSync('/tmp/billy-bcw-');
      try {
        const s = run(data, { mode: 'agents-setup', receiver: url, root, tag: `ag-${i}-${Math.random()}` });
        const s0 = await stats();
        const c = run(data, { mode: 'agents-run', receiver: url, root, task_id: s.out.task_id, sock }, b);
        assert.equal(c.signal, 'SIGKILL', c.err);
        const r = run(data, { mode: 'agents-run', receiver: url, root, task_id: s.out.task_id, sock });
        assert.equal(r.out?.status, 'COMPLETED', r.err + JSON.stringify(r.out));
        assert.equal((await stats()).effects - s0.effects, 1);
        record({ tool: 'workers', boundary: b, injection: i, result: 'PASS' });
      } finally { t.cleanup(); rmSync(sock, { recursive: true, force: true }); }
    }
  });
}
