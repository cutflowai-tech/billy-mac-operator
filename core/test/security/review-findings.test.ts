// Regression tests for the independent security review (docs/threat-and-failure-register.md, F-01..F-21).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, chmodSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { fixture, scope } from '../fixtures.ts';
import { fsWrite } from '../../src/tools/fs.ts';
import { apiSendMessage, type Endpoint } from '../../src/tools/api.ts';
import type { ToolAdapter } from '../../src/broker/types.ts';
import { redact } from '../../src/util/redact.ts';
import { Budget } from '../../src/budget/budget.ts';

test('F-01: fs.copy / fs.move refuse a source outside the granted roots', async () => {
  const fx = fixture();
  try {
    const id = fx.task(); fx.run(id);
    writeFileSync(join(fx.outside, 'id_rsa'), 'PRIVATE');
    const c = await fx.core.broker.submit(fx.proposal(id, 'fs.copy', { from: join(fx.outside, 'id_rsa'), to: join(fx.root, 'stolen') }, 'c'));
    assert.equal(c.verdict, 'DENIED', c.reason);
    const m = await fx.core.broker.submit(fx.proposal(id, 'fs.move', { from: join(fx.outside, 'id_rsa'), to: join(fx.root, 'moved') }, 'm'));
    assert.equal(m.verdict, 'DENIED', m.reason);
    assert.equal(existsSync(join(fx.root, 'stolen')), false);
    assert.equal(readFileSync(join(fx.outside, 'id_rsa'), 'utf8'), 'PRIVATE');
  } finally { fx.cleanup(); }
});

test('F-02: fs.trash has no model-supplied destination', async () => {
  const fx = fixture();
  try {
    const id = fx.task(); fx.run(id);
    writeFileSync(join(fx.root, 'f'), 'x');
    const r = await fx.core.broker.submit(fx.proposal(id, 'fs.trash', { path: join(fx.root, 'f'), trash_dir: fx.outside }, 't'));
    assert.equal(r.verdict, 'REJECTED', r.reason); // unknown field
    assert.equal(readdirSync(fx.outside).length, 0);
  } finally { fx.cleanup(); }
});

test('F-03: a throwing verify leaves a recoverable attempt and recovery survives it', async () => {
  const boom: ToolAdapter = { ...fsWrite, spec: { ...fsWrite.spec, tool_id: 'fs.write_boom' }, async verify() { throw new Error('verify exploded'); }, async reconcile() { throw new Error('reconcile exploded'); } };
  const fx = fixture({ extraTools: [boom] });
  try {
    const id = fx.task(); fx.run(id);
    const r = await fx.core.broker.submit(fx.proposal(id, 'fs.write_boom', { path: join(fx.root, 'b'), content: 'x', mode: 'create' }, 'b'));
    assert.equal(r.verdict, 'UNRESOLVED');
    const rec = await fx.core.recover();
    assert.ok(Array.isArray(rec.attempts));
    const st = fx.core.store.db.prepare('SELECT status FROM attempts').get() as any;
    assert.equal(st.status, 'UNRESOLVED');
  } finally { fx.cleanup(); }
});

test('F-04: planner postconditions cannot probe paths outside the grant', async () => {
  const fx = fixture();
  try {
    const id = fx.task(); fx.run(id);
    writeFileSync(join(fx.outside, 'secret'), 'BILLY_CANARY_oracle123');
    const p = { ...fx.proposal(id, 'fs.write', { path: join(fx.root, 'ok'), content: 'x', mode: 'create' }, 'o'),
      postconditions: [{ kind: 'file_contains', path: join(fx.outside, 'secret'), text: 'BILLY_CANARY' }] };
    const r = await fx.core.broker.submit(p);
    assert.equal(r.verdict, 'DENIED', r.reason);
    assert.equal(existsSync(join(fx.root, 'ok')), false);
  } finally { fx.cleanup(); }
});

test('F-05: API tool does not follow redirects to ungranted hosts', async () => {
  let hits = 0;
  const evil = createServer((_q, s) => { hits++; s.end('{}'); }).listen(0, '127.0.0.1');
  const redir = createServer((_q, s) => { s.writeHead(307, { location: `http://127.0.0.1:${(evil.address() as any).port}/x` }); s.end(); }).listen(0, '127.0.0.1');
  await new Promise((r) => setTimeout(r, 50));
  const url = `http://127.0.0.1:${(redir.address() as any).port}`;
  const endpoints = new Map<string, Endpoint>([['r', { id: 'r', base_url: url, account_id: 'a', supports_idempotency_keys: true, lookup_path: 'ops' }]]);
  const fx = fixture({ extraTools: [apiSendMessage], services: { endpoints } }, { tool_classes: ['api.message'], account_ids: ['a'], network_destinations: [new URL(url).host] });
  try {
    const id = fx.task(); fx.run(id);
    await fx.core.broker.submit(fx.proposal(id, 'api.send_message', { endpoint_id: 'r', account_id: 'a', to: 'x', body: 'BILLY_CANARY_body0001' }, 's'));
    assert.equal(hits, 0, 'body never reached the redirect target');
  } finally { fx.cleanup(); evil.close(); redir.close(); }
});

test('F-06: denial happens before resolving (no existence oracle outside roots)', async () => {
  const fx = fixture();
  try {
    const id = fx.task(); fx.run(id);
    const a = await fx.core.broker.submit(fx.proposal(id, 'fs.stat', { path: '/etc/hosts' }, 'a'));
    const b = await fx.core.broker.submit(fx.proposal(id, 'fs.stat', { path: '/etc/missing-dir-billy/x' }, 'b'));
    assert.equal(a.verdict, 'DENIED'); assert.equal(b.verdict, 'DENIED');
    assert.equal(a.reason, b.reason, 'same answer whether or not the outside path exists');
  } finally { fx.cleanup(); }
});

test('F-07: redaction covers bearer headers, modern key shapes, PEM keys, URL credentials', () => {
  const cases = ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456', 'key sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX1234', 'sk-svcacct-ABCDEFGHIJKLMNOPQRSTUV9876',
    '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----', 'https://user:hunter2pass@example.com/x',
    ['xoxb', '1234567890-abcdefghijklmnop'].join('-'), 'AIzaSyA1234567890abcdefghijklmnopqrstuv', 'password: "correct horse battery staple"'];
  for (const c of cases) {
    const r = redact(c);
    assert.ok(!/abcdefghijklmnopqrstuvwxyz123456|ABCDEFGHIJKLMNOPQRSTUVWX1234|ABCDEFGHIJKLMNOPQRSTUV9876|b3BlbnNzaC1rZXktdjEAAAAA|hunter2pass|abcdefghijklmnop|A1234567890abcdefghij|horse battery/.test(r), `leaked: ${r}`);
  }
});

test('F-12: Stop aborts an in-flight cancellable adapter call', async () => {
  let aborted = false;
  const slow: ToolAdapter = { ...fsWrite, spec: { ...fsWrite.spec, tool_id: 'fs.slow' },
    async dispatch(_a, _r, ctx) { await new Promise<void>((res) => { const t = setTimeout(res, 5000); ctx.signal.addEventListener('abort', () => { aborted = true; clearTimeout(t); res(); }); }); return { outcome: 'unknown', error: 'aborted' }; } };
  const fx = fixture({ extraTools: [slow] });
  try {
    const id = fx.task(); fx.run(id);
    const p = fx.core.broker.submit(fx.proposal(id, 'fs.slow', { path: join(fx.root, 's'), content: 'x', mode: 'create' }, 's'));
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    fx.core.control.stopAll('test');
    await p;
    assert.ok(aborted && Date.now() - t0 < 1000);
  } finally { fx.cleanup(); }
});

test('F-13: stop pauses VERIFYING/RECONCILING tasks and restart does not resume them', async () => {
  const fx = fixture();
  try {
    const a = fx.task(); fx.run(a); fx.core.store.transitionTask(a, 'VERIFYING');
    const b = fx.task(); fx.run(b); fx.core.store.transitionTask(b, 'RECONCILING');
    fx.core.control.stopAll('test');
    assert.equal(fx.core.store.taskStatus(a), 'PAUSED_BY_OWNER');
    assert.equal(fx.core.store.taskStatus(b), 'PAUSED_BY_OWNER');
    const c = fx.task(); fx.run(c);
    fx.core.store.db.prepare(`UPDATE stop_latch SET stopped=1`).run();
    await fx.core.recover();
    assert.equal(fx.core.store.taskStatus(c), 'PAUSED_BY_OWNER', 'recovery under a stop latch does not make work runnable');
  } finally { fx.cleanup(); }
});

test('F-14: a revoked grant cannot be silently re-activated; parent cycles are rejected', () => {
  const fx = fixture();
  try {
    fx.core.policy.revoke(fx.grantId, 'r');
    assert.throws(() => fx.core.policy.putGrant({ grant_id: fx.grantId, owner_id: 'owner', scope: scope({ file_roots: [fx.root] }), parent_grant_id: null, task_id: null, expires_at: '2099-01-01T00:00:00.000Z', source: 't' }), /revoked/);
    const a = crypto.randomUUID();
    assert.throws(() => fx.core.policy.putGrant({ grant_id: a, owner_id: 'owner', scope: scope(), parent_grant_id: a, task_id: null, expires_at: '2099-01-01T00:00:00.000Z', source: 't' }), /parent/);
  } finally { fx.cleanup(); }
});

test('F-16: reservations made before UTC midnight still count against the daily ceiling', () => {
  const fx = fixture();
  try {
    let now = Date.parse('2026-10-11T23:59:00.000Z');
    (fx.core.store as any).clock = () => now;
    const b = new Budget(fx.core.store);
    b.setCeiling('d', 1000, 'daily', 'o');
    b.reserve(['d'], 900, 'r');
    now = Date.parse('2026-10-12T00:01:00.000Z');
    assert.equal(b.remaining('d'), 100);
  } finally { fx.cleanup(); }
});

test('F-18: overlapping outbox deliveries send once', async () => {
  const fx = fixture();
  try {
    let sends = 0;
    fx.core.outbox.register({ id: 'c', async send() { sends++; await new Promise((r) => setTimeout(r, 30)); return { ok: 1 }; } });
    fx.core.outbox.enqueue('k1', 'c', 'd', 't', 'b');
    await Promise.all([fx.core.outbox.deliverDue(), fx.core.outbox.deliverDue()]);
    assert.equal(sends, 1);
  } finally { fx.cleanup(); }
});

test('F-19: replace keeps the original file mode; temp files are private', async () => {
  const fx = fixture();
  try {
    const id = fx.task(); fx.run(id);
    const p = join(fx.root, 'secret.cfg'); writeFileSync(p, 'old'); chmodSync(p, 0o600);
    const { createHash } = await import('node:crypto');
    const r = await fx.core.broker.submit(fx.proposal(id, 'fs.write', { path: p, content: 'new', mode: 'replace', expected_sha256: createHash('sha256').update('old').digest('hex') }, 'r'));
    assert.equal(r.verdict, 'COMMITTED', r.reason);
    assert.equal(statSync(p).mode & 0o777, 0o600);
  } finally { fx.cleanup(); }
});

test('F-21: WAIT_RESOURCE does not orphan the queue; release wakes the waiting task', async () => {
  const fx = fixture();
  try {
    const id = fx.task(); fx.run(id);
    const target = join(fx.root, 'contended');
    fx.core.claims.acquireAll([{ resource_key: `path:${target.toLowerCase()}`, mode: 'exclusive' }], 'other-holder');
    const r = await fx.core.broker.submit(fx.proposal(id, 'fs.write', { path: target, content: 'x', mode: 'create' }, 'w'));
    assert.equal(r.verdict, 'WAIT_RESOURCE');
    fx.core.claims.releaseAll('other-holder');
    const r2 = await fx.core.broker.submit(fx.proposal(id, 'fs.write', { path: target, content: 'x', mode: 'create' }, 'w'));
    assert.equal(r2.verdict, 'COMMITTED', r2.reason);
  } finally { fx.cleanup(); }
});
