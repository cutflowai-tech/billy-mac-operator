// T-ACTION-03, T-DUR-01..04, part of T-REL-08: real SIGKILL at each named
// broker persistence boundary, then a fresh process recovers. The external
// receiver (separate process) is the authority on effect counts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, existsSync, appendFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../helpers.ts';

const HERE = import.meta.dirname;
const PROC = join(HERE, '..', 'harness', 'broker-proc.ts');
const RECV = join(HERE, '..', 'harness', 'receiver.ts');
const RESULTS = join(HERE, '..', '..', '..', 'artifacts', 'fault');
const INJECTIONS = Number(process.env.BILLY_FAULT_INJECTIONS ?? 10);

let recv: ChildProcess; let recvUrl = ''; let base: { dir: string; cleanup: () => void };

before(async () => {
  base = tempDir('billy-fault-');
  recv = spawn(process.execPath, [RECV, join(base.dir, 'receiver.jsonl'), '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  recvUrl = await new Promise<string>((res) => recv.stdout!.on('data', (d) => {
    const m = /LISTENING (\d+)/.exec(String(d)); if (m) res(`http://127.0.0.1:${m[1]}`);
  }));
  mkdirSync(RESULTS, { recursive: true });
});
after(() => { recv.kill(); base.cleanup(); });

function run(dataDir: string, fx: object, faults?: string) {
  const env = { ...process.env, BILLY_FAULT_POINTS: faults ?? '' };
  const r = spawnSync(process.execPath, [PROC, dataDir, JSON.stringify(fx)], { env, encoding: 'utf8', timeout: 30_000 });
  return { status: r.status, signal: r.signal, out: r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).pop(), err: r.stderr };
}
async function stats() { return (await fetch(`${recvUrl}/stats`)).json() as Promise<any>; }
async function control(c: object) { await fetch(`${recvUrl}/control`, { method: 'POST', body: JSON.stringify(c) }); }

const SCENARIO: Record<string, string> = {
  'broker.before_intent_commit': 'T-ACTION-03 T-DUR-01', 'broker.after_prepared': 'T-ACTION-03 T-DUR-02', 'broker.after_dispatching': 'T-ACTION-03 T-DUR-03',
  'broker.after_adapter_call': 'T-ACTION-03 T-DUR-04', 'broker.after_outcome_record': 'T-ACTION-03', 'broker.after_verify': 'T-ACTION-03', 'broker.before_commit': 'T-ACTION-03',
};
const BOUNDARIES = [
  'broker.before_intent_commit', 'broker.after_prepared', 'broker.after_dispatching', 'broker.after_adapter_call',
  'broker.after_outcome_record', 'broker.after_verify', 'broker.before_commit',
];

function record(row: object) { appendFileSync(join(RESULTS, 'broker-boundaries.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n'); }

for (const tool of ['api.send_message', 'fs.write'] as const) {
  for (const b of BOUNDARIES) {
    test(`${SCENARIO[b]} T-REL-08: ${tool}: SIGKILL at ${b} x${INJECTIONS} -> exactly one effect after recovery`, async () => {
      for (let i = 0; i < INJECTIONS; i++) {
        const t = tempDir('billy-fault-case-');
        try {
          const dir = realpathSync(t.dir);
          const root = join(dir, 'root'); mkdirSync(root);
          const dataDir = join(dir, 'data');
          const setup = run(dataDir, { mode: 'setup', receiver: recvUrl, root });
          assert.equal(setup.status, 0, setup.err);
          const step = `step-${b}-${i}`;
          const target = join(root, `${b}-${i}.txt`);
          const args = tool === 'api.send_message'
            ? { endpoint_id: 'fixture', account_id: 'acct-fixture', to: 'fixture-recipient', body: `hello ${step}` }
            : { path: target, content: `content ${step}`, mode: 'create' };
          const fx = { receiver: recvUrl, root, task_id: setup.out.task_id, tool, args, step };
          const before = await stats();
          const crashed = run(dataDir, { ...fx, mode: 'submit' }, b);
          assert.equal(crashed.signal, 'SIGKILL', `expected injected crash at ${b}: ${crashed.err}`);
          const rec = run(dataDir, { ...fx, mode: 'recover' });
          assert.equal(rec.status, 0, rec.err);
          const final = rec.out.verdicts[rec.out.verdicts.length - 1];
          assert.ok(['COMMITTED', 'DEDUPLICATED'].includes(final), `final verdict ${JSON.stringify(rec.out)}`);
          const committed = rec.out.attempts.filter((a: any) => a.status === 'COMMITTED').length;
          assert.equal(committed, 1, 'exactly one committed attempt for the semantic operation');
          if (tool === 'api.send_message') {
            const after = await stats();
            assert.equal(after.effects - before.effects, 1, `receiver effects at ${b}: ${JSON.stringify(rec.out)}`);
          } else {
            assert.equal(readFileSync(target, 'utf8'), `content ${step}`);
            assert.deepEqual(readdirSync(root).filter((f) => f.includes('.billy-')), [], 'no stray temp files');
          }
          record({ tool, boundary: b, injection: i, crash_signal: crashed.signal, recovered: rec.out.recovered, verdicts: rec.out.verdicts, attempts: rec.out.attempts, result: 'PASS' });
        } finally { t.cleanup(); }
      }
    });
  }
}

test('T-DUR-04 T-REL-08: receiver commits but drops the response; recovery reconciles, never resends', async () => {
  for (let i = 0; i < INJECTIONS; i++) {
    const t = tempDir('billy-fault-case-');
    try {
      const dir = realpathSync(t.dir);
      const root = join(dir, 'root'); mkdirSync(root);
      const dataDir = join(dir, 'data');
      const setup = run(dataDir, { mode: 'setup', receiver: recvUrl, root });
      const fx = { receiver: recvUrl, root, task_id: setup.out.task_id, tool: 'api.send_message', step: `drop-${i}`,
        args: { endpoint_id: 'fixture', account_id: 'acct-fixture', to: 'r', body: `drop ${i}` } };
      const before = await stats();
      await control({ mode: 'drop_after_commit', n: 1 });
      const first = run(dataDir, { ...fx, mode: 'submit' });
      await control({ mode: 'normal' });
      assert.equal(first.status, 0, first.err);
      // In-line reconciliation found the effect by operation identity.
      assert.deepEqual(first.out.verdicts, ['COMMITTED']);
      // Simulate a worker restart: recover + resubmit must not resend.
      const again = run(dataDir, { ...fx, mode: 'recover' });
      assert.deepEqual(again.out.verdicts, ['DEDUPLICATED']);
      const after = await stats();
      assert.equal(after.effects - before.effects, 1);
      record({ tool: 'api.send_message', boundary: 'receiver.drop_after_commit', injection: i, verdicts: [...first.out.verdicts, ...again.out.verdicts], result: 'PASS' });
    } finally { t.cleanup(); }
  }
});

test('T-ACTION-07: same key retried is not duplicated; changed payload under same key is a surfaced conflict', async () => {
  const k = `billy-${'a'.repeat(64)}`;
  const send = (body: string) => fetch(`${recvUrl}/messages`, { method: 'POST', headers: { 'idempotency-key': k }, body });
  const before = await stats();
  const a = await send('{"x":1}'); const b = await send('{"x":1}'); const c = await send('{"x":2}');
  assert.equal(a.status, 200); assert.equal((await b.json() as any).deduped, true); assert.equal(c.status, 409);
  assert.equal((await stats()).effects - before.effects, 1);
});

test('fail_before_commit (definite 5xx) is reconciled as not applied, retried under the same key, one effect', async () => {
  const t = tempDir('billy-fault-case-');
  try {
    const dir = realpathSync(t.dir);
    const root = join(dir, 'root'); mkdirSync(root);
    const dataDir = join(dir, 'data');
    const setup = run(dataDir, { mode: 'setup', receiver: recvUrl, root });
    const fx = { receiver: recvUrl, root, task_id: setup.out.task_id, tool: 'api.send_message', step: 'flaky',
      args: { endpoint_id: 'fixture', account_id: 'acct-fixture', to: 'r', body: 'flaky' } };
    const before = await stats();
    await control({ mode: 'fail_before_commit', n: 1 });
    const r = run(dataDir, { ...fx, mode: 'submit' });
    await control({ mode: 'normal' });
    assert.deepEqual(r.out.verdicts, ['RETRY_ELIGIBLE', 'COMMITTED'], JSON.stringify(r.out));
    assert.equal((await stats()).effects - before.effects, 1);
  } finally { t.cleanup(); }
});
