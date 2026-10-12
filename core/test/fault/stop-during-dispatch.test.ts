// Moved from spine.test.ts into the lane that matches the scenario's kind (handoff §19.1); assertions unchanged.
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

test('T-ACTION-09: stop during dispatch -> no new old-generation effect after ack; in-flight reported', async () => {
  const fx = apiFixture();
  try {
    const steps = [1, 2, 3, 4, 5].map((i) => ({ kind: 'action', step_key: `send-${i}`, tool_id: 'api.send_message',
      arguments: { endpoint_id: 'fixture', account_id: 'acct', to: 'r', body: `stop test ${i} ${Math.random()}` } }));
    const id = scripted(fx, steps);
    await control({ mode: 'delay', n: 1, delay_ms: 400 });
    const before = await stats();
    fx.core.executor.tick();
    // Wait until the first attempt is DISPATCHING (in flight at the receiver).
    for (let i = 0; i < 200; i++) {
      const r = fx.core.store.db.prepare(`SELECT count(*) c FROM attempts WHERE status='DISPATCHING'`).get() as any;
      if (r.c) break; await new Promise((x) => setTimeout(x, 5));
    }
    const ack = fx.core.control.stopAll('local-button');
    assert.ok(ack.ack_ms < 2000, `ack ${ack.ack_ms}ms`);
    const { writeFileSync: wf, mkdirSync: md } = await import('node:fs');
    const mdir = join(import.meta.dirname, '..', '..', '..', 'artifacts', 'measurements'); md(mdir, { recursive: true });
    wf(join(mdir, 'T-ACTION-09.json'), JSON.stringify({ test_id: 'T-ACTION-09', measurements: { ack_seconds: ack.ack_ms / 1000 }, at: new Date().toISOString(), ...(await import('../stamp.ts')).STAMP }));
    assert.equal(ack.in_flight.length, 1, 'the in-flight effect is reported, not hidden');
    await fx.core.executor.stop();
    await new Promise((x) => setTimeout(x, 600));
    const after = await stats();
    assert.equal(after.effects - before.effects, 1, 'only the already in-flight effect landed');
    const late = fx.core.store.db.prepare(`SELECT count(*) c FROM attempts WHERE dispatched_at > ?`).get(ack.acknowledged_at) as any;
    assert.equal(late.c, 0, 'zero dispatches after the acknowledgement point');
    assert.equal(fx.core.store.taskStatus(id), 'PAUSED_BY_OWNER');
    await control({ mode: 'normal' });
  } finally { fx.cleanup(); }
});

