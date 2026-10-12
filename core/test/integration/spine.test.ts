// P2 spine: executor, stop, budget, outbox, inbox, contention.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture, scope } from '../fixtures.ts';
import { apiSendMessage, type Endpoint } from '../../src/tools/api.ts';
import { tempDir } from '../helpers.ts';
import { Core } from '../../src/core.ts';
import type { Channel } from '../../src/notify/outbox.ts';
import type { ToolAdapter } from '../../src/broker/types.ts';

const RECV = join(import.meta.dirname, '..', 'harness', 'receiver.ts');
let recv: ChildProcess; let url = '';
before(async () => {
  recv = spawn(process.execPath, [RECV, '', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  url = await new Promise((res) => recv.stdout!.on('data', (d) => { const m = /LISTENING (\d+)/.exec(String(d)); if (m) res(`http://127.0.0.1:${m[1]}`); }));
});
after(() => recv.kill());
const stats = async () => (await fetch(`${url}/stats`)).json() as Promise<any>;
const control = (c: object) => fetch(`${url}/control`, { method: 'POST', body: JSON.stringify(c) });

function apiFixture(extra: object = {}) {
  const endpoints = new Map<string, Endpoint>([['fixture', { id: 'fixture', base_url: url, account_id: 'acct', supports_idempotency_keys: true, lookup_path: 'ops' }]]);
  return fixture({ extraTools: [apiSendMessage], services: { endpoints }, ...extra },
    { tool_classes: ['file', 'api.message'], account_ids: ['acct'], network_destinations: [new URL(url).host] });
}

function scripted(fx: any, steps: any[], criteria: any[] = []) {
  const id = fx.core.tasks.create({ owner_id: 'owner', goal: 'scripted', project_scope: 'fx', grant_id: fx.grantId,
    success_criteria: { description: 'scripted', postconditions: criteria } });
  fx.core.executor.seedPlan(id, 1, 'scripted', { steps });
  return id;
}

test('executor completes a multi-step task with independent final verification, no prompts', async () => {
  const fx = fixture();
  try {
    const a = join(fx.root, 'a.txt'), b = join(fx.root, 'b.txt');
    const id = scripted(fx, [
      { kind: 'action', step_key: 'w1', tool_id: 'fs.write', arguments: { path: a, content: 'one', mode: 'create' } },
      { kind: 'action', step_key: 'c1', tool_id: 'fs.copy', arguments: { from: a, to: b } },
    ], [{ kind: 'file_contains', path: b, text: 'one' }]);
    await fx.core.executor.drain();
    assert.equal(fx.core.store.taskStatus(id), 'COMPLETED');
    const prompts = fx.core.store.db.prepare(`SELECT count(*) c FROM events WHERE kind='decision'`).get() as any;
    assert.equal(prompts.c, 0, 'no policy decision other than ALLOW was needed');
  } finally { fx.cleanup(); }
});

test('T-UX-03: in-scope job needs no approval; out-of-scope job requests new authority once', async () => {
  const fx = fixture();
  fx.core.notifyTargets.push({ channel: 'test', destination: 'owner' });
  try {
    const ok = scripted(fx, [{ kind: 'action', step_key: 's', tool_id: 'fs.write', arguments: { path: join(fx.root, 'x'), content: 'x', mode: 'create' } }]);
    const bad = scripted(fx, [{ kind: 'action', step_key: 's', tool_id: 'api.unknown_class_probe', arguments: {} }]);
    void bad;
    const outOfScope = scripted(fx, [{ kind: 'action', step_key: 's', tool_id: 'fs.copy', arguments: { from: join(fx.root, 'x'), to: join(fx.root, 'y') } }]);
    // Remove the needed effect class for the third task by giving it a read-only grant.
    const g = crypto.randomUUID();
    fx.core.policy.putGrant({ grant_id: g, owner_id: 'owner', scope: scope({ file_roots: [fx.root], allowed_effects: ['READ_ONLY'] }), parent_grant_id: null, task_id: null, expires_at: '2099-01-01T00:00:00.000Z', source: 't' });
    fx.core.store.db.prepare('UPDATE tasks SET grant_id=? WHERE task_id=?').run(g, outOfScope);
    await fx.core.executor.drain();
    assert.equal(fx.core.store.taskStatus(ok), 'COMPLETED');
    assert.equal(fx.core.store.taskStatus(outOfScope), 'WAITING_PERMISSION');
    const msgs = fx.core.store.db.prepare(`SELECT payload_json FROM outbox`).all() as any[];
    const authorityAsks = msgs.filter((m) => JSON.parse(m.payload_json).title === 'Needs your authority');
    assert.equal(authorityAsks.length, 1);
    // Unchanged blocker is not re-requested.
    fx.core.executor.wake('grant_changed');
    await fx.core.executor.drain();
    const again = (fx.core.store.db.prepare(`SELECT payload_json FROM outbox`).all() as any[]).filter((m) => JSON.parse(m.payload_json).title === 'Needs your authority');
    assert.equal(again.length, 1);
  } finally { fx.cleanup(); }
});

test('T-DUR-12: stop latch survives restart; old work stays stopped until explicit resume', async () => {
  const t = tempDir();
  try {
    const dir = join(t.dir, 'data');
    let core = new Core({ dir, allowUnsafeLocation: true });
    const id = core.tasks.create({ owner_id: 'o', goal: 'g', project_scope: 'p', grant_id: null, success_criteria: { description: '', postconditions: [] } });
    core.executor.seedPlan(id, 1, 'scripted', { steps: [] });
    core.control.stopAll('test');
    core.close();
    core = new Core({ dir, allowUnsafeLocation: true });
    await core.recover();
    assert.equal(core.store.stopLatch().stopped, true);
    assert.deepEqual(core.executor.tick(), []);
    assert.equal(core.store.taskStatus(id), 'PAUSED_BY_OWNER');
    core.control.clearStop('owner');
    core.executor.tick();
    assert.equal(core.store.taskStatus(id), 'PAUSED_BY_OWNER', 'clearing the latch does not resume old work by itself');
    core.control.resume(id, 'owner');
    await core.executor.drain();
    assert.equal(core.store.taskStatus(id), 'COMPLETED');
    core.close();
  } finally { t.cleanup(); }
});

test('T-BOOT-05: no explicit budget -> chargeable dispatch waits; no-cost work proceeds; zero billed dispatches', async () => {
  let billed = 0;
  const paid: ToolAdapter = { ...apiSendMessage, spec: { ...apiSendMessage.spec, tool_id: 'model.fake_paid', tool_class: 'file' },
    resolve: () => ({ resource_id: 'model:x', account_id: null, facts: {}, claims: [] }), estimateMicros: () => 5000,
    async dispatch() { billed++; return { outcome: 'success', usage_micros: 4000 }; }, async verify() { return { verdict: 'verified', evidence: {} }; } };
  const fx = fixture({ extraTools: [paid] });
  try {
    const p = scripted(fx, [{ kind: 'action', step_key: 'p', tool_id: 'model.fake_paid', arguments: { endpoint_id: 'x', account_id: 'a', to: 't', body: 'b' } }]);
    fx.core.store.db.prepare(`UPDATE tasks SET budget_scope='daily-total' WHERE task_id=?`).run(p);
    const free = scripted(fx, [{ kind: 'action', step_key: 'f', tool_id: 'fs.write', arguments: { path: join(fx.root, 'free'), content: 'x', mode: 'create' } }]);
    await fx.core.executor.drain();
    assert.equal(fx.core.store.taskStatus(p), 'WAITING_BUDGET');
    assert.equal(fx.core.store.taskStatus(free), 'COMPLETED');
    assert.equal(billed, 0);
    fx.core.budget.setCeiling('daily-total', 10_000, 'total', 'owner');
    fx.core.executor.wake('budget_changed');
    await fx.core.executor.drain();
    assert.equal(fx.core.store.taskStatus(p), 'COMPLETED');
    assert.equal(billed, 1);
  } finally { fx.cleanup(); }
});

test('T-AI-04: concurrent reservations + unknown billing cannot over-admit; restart keeps the ceiling', async () => {
  const t = tempDir();
  try {
    const dir = join(t.dir, 'data');
    let core = new Core({ dir, allowUnsafeLocation: true });
    core.budget.setCeiling('proj', 10_000, 'total', 'owner');
    const ok: string[] = []; let waits = 0;
    for (let i = 0; i < 20; i++) { try { ok.push(core.budget.reserve(['proj'], 3000, `c${i}`)); } catch { waits++; } }
    assert.equal(ok.length, 3); assert.equal(waits, 17);
    core.budget.settle(ok[0], 'unknown');   // billing unknown: keep full reservation as spend
    core.budget.settle(ok[1], 1000);
    assert.equal(core.budget.remaining('proj'), 10_000 - 3000 - 1000 - 3000);
    core.close();
    core = new Core({ dir, allowUnsafeLocation: true });
    assert.equal(core.budget.remaining('proj'), 3000);
    assert.throws(() => core.budget.reserve(['proj'], 3001, 'x'));
    core.close();
  } finally { t.cleanup(); }
});

test('T-DUR-05: failed notification is retried alone; the completed task is not re-run', async () => {
  const fx = fixture();
  let fail = true; const sent: string[] = [];
  const ch: Channel = { id: 'flaky', async send(_d, p, k) { if (fail) throw new Error('channel down'); sent.push(k); return { ok: true }; } };
  fx.core.outbox.register(ch);
  fx.core.notifyTargets.push({ channel: 'flaky', destination: 'owner' });
  try {
    const id = scripted(fx, [{ kind: 'action', step_key: 'w', tool_id: 'fs.write', arguments: { path: join(fx.root, 'n'), content: 'x', mode: 'create' } }]);
    await fx.core.executor.drain();
    assert.equal(fx.core.store.taskStatus(id), 'COMPLETED');
    await fx.core.outbox.deliverDue();
    assert.equal(sent.length, 0);
    fail = false;
    fx.core.store.db.prepare(`UPDATE outbox SET next_attempt_at='1970-01-01T00:00:00.000Z'`).run();
    await fx.core.outbox.deliverDue();
    assert.equal(sent.length, 1);
    const attempts = fx.core.store.db.prepare('SELECT count(*) c FROM attempts').get() as any;
    assert.equal(attempts.c, 1, 'task effect executed exactly once');
  } finally { fx.cleanup(); }
});

test('T-REMOTE-03 (core part): duplicate message admission returns the original task', () => {
  const fx = fixture();
  try {
    let created = 0;
    const mk = () => { created++; return { task_id: fx.task(), revision: 1 }; };
    const a = fx.core.inbox.admit('telegram', 'msg-1', 'owner-123', 'ADMITTED', mk);
    const b = fx.core.inbox.admit('telegram', 'msg-1', 'owner-123', 'ADMITTED', mk);
    assert.equal(created, 1); assert.equal(b.duplicate, true); assert.equal(b.task_id, a.task_id);
  } finally { fx.cleanup(); }
});

test('T-DUR-09: write contention is bounded, consistent and never spins', async () => {
  const fx = fixture({ busyTimeoutMs: 200 });
  try {
    const other = new DatabaseSync(join(fx.dir, 'data', 'billy.db'), { timeout: 10 });
    other.exec('BEGIN IMMEDIATE');
    const t0 = Date.now();
    assert.throws(() => fx.task(), /locked|busy/);
    const waited = Date.now() - t0;
    assert.ok(waited >= 150 && waited < 2000, `bounded wait ${waited}ms`);
    other.exec('ROLLBACK'); other.close();
    const id = fx.task();
    assert.ok(id);
    const ic = fx.core.store.db.prepare('PRAGMA integrity_check').get() as any;
    assert.equal(ic.integrity_check, 'ok');
  } finally { fx.cleanup(); }
});

test('T-ACTION-10: goal revised during an in-flight effect -> stale rev-1 action rejected, dispatched effect settled before rev-2 planning', async () => {
  const fx = apiFixture();
  try {
    const id = scripted(fx, [{ kind: 'action', step_key: 'send-1', tool_id: 'api.send_message', arguments: { endpoint_id: 'fixture', account_id: 'acct', to: 'r', body: `rev1 ${Math.random()}` } }]);
    const before = await stats();
    await control({ mode: 'delay', n: 1, delay_ms: 400 });
    fx.core.executor.tick();
    for (let i = 0; i < 200 && !(fx.core.store.db.prepare(`SELECT count(*) c FROM attempts WHERE status='DISPATCHING'`).get() as any).c; i++) await new Promise((x) => setTimeout(x, 5));
    const rev1 = fx.core.tasks.get(id);
    // Owner changes the goal while send-1 is in flight.
    const rev = fx.core.control.revise(id, 'revised goal', { description: 'v2', postconditions: [] }, 'cmd-rev2');
    fx.core.executor.seedPlan(id, rev, 'scripted', { steps: [{ kind: 'action', step_key: 'note', tool_id: 'fs.write', arguments: { path: join(fx.root, 'v2.txt'), content: 'v2', mode: 'create' } }] });
    // A late rev-1 action is rejected at the broker.
    const late = await fx.core.broker.submit({ ...fx.proposal(id, 'fs.write', { path: join(fx.root, 'late.txt'), content: 'x', mode: 'create' }, 'late'), task_revision: rev1.revision, cancellation_generation: rev1.cancellation_generation });
    assert.equal(late.verdict, 'STALE');
    await fx.core.executor.drain();
    assert.equal(fx.core.store.taskStatus(id), 'COMPLETED');
    const a = fx.core.store.db.prepare(`SELECT task_revision, status, json_extract(envelope_json,'$.step_key') k FROM attempts ORDER BY created_at`).all() as any[];
    assert.deepEqual(a.map((x) => [x.task_revision, x.k, x.status]), [[1, 'send-1', 'COMMITTED'], [2, 'note', 'COMMITTED']], 'rev-1 effect reconciled (committed) before rev-2 work');
    assert.equal(existsSync(join(fx.root, 'late.txt')), false);
    assert.equal((await stats()).effects - before.effects, 1);
  } finally { await control({ mode: 'normal' }); fx.cleanup(); }
});
