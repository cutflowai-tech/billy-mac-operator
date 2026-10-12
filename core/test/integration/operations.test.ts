// T-AI-05 (offline independent work), T-UX-02 (meaningful non-repetitive updates),
// T-BOOT-04 (one consolidated prerequisite packet; independent work continues).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, mkdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { fixture, scope } from '../fixtures.ts';
import { ModelGateway, type ProviderDriver, type CompletionRequest } from '../../src/ai/gateway.ts';
import { ModelPlanner } from '../../src/planner/model.ts';

class FlakyNet implements ProviderDriver {
  id = 'anthropic'; online = false; calls = 0;
  async listModels() { return [{ id: 'claude-opus-5-5' }]; }
  async call(model: string, _r: CompletionRequest) {
    this.calls++;
    if (!this.online) { const e: any = new Error('getaddrinfo ENOTFOUND api.anthropic.com'); throw e; }
    return { text: JSON.stringify({ kind: 'done', step_key: '', tool_id: '', arguments_json: '{}', reason: '', summary: 'cloud step done', reply_language: 'en', success_criteria_json: '[]' }), model, stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
  }
}

test('T-UX-02: one admission ack, one notice per distinct blocker (no repeats), one evidence-backed completion', async () => {
  const fx = fixture();
  fx.core.notifyTargets.push({ channel: 'phone', destination: 'owner' });
  try {
    const g = crypto.randomUUID();
    fx.core.policy.putGrant({ grant_id: g, owner_id: 'owner', scope: scope({ file_roots: [fx.root], allowed_effects: ['READ_ONLY'] }), parent_grant_id: null, task_id: null, expires_at: '2099-01-01T00:00:00.000Z', source: 'owner' });
    const id = fx.core.tasks.create({ owner_id: 'owner', goal: 'write report', project_scope: 'fx', grant_id: g, success_criteria: { description: 'x', postconditions: [{ kind: 'file_contains', path: join(fx.root, 'r.txt'), text: 'done' }] } });
    fx.core.notify('admitted', id, 'Got it: write report');
    fx.core.executor.seedPlan(id, 1, 'scripted', { steps: [{ kind: 'action', step_key: 'w', tool_id: 'fs.write', arguments: { path: join(fx.root, 'r.txt'), content: 'done', mode: 'create' } }] });
    for (let i = 0; i < 5; i++) { fx.core.executor.wake('grant_changed'); await fx.core.executor.drain(); }  // unchanged blocker x5
    fx.core.policy.putGrant({ grant_id: g, owner_id: 'owner', scope: scope({ file_roots: [fx.root] }), parent_grant_id: null, task_id: null, expires_at: '2099-01-01T00:00:00.000Z', source: 'owner' });
    fx.core.executor.wake('grant_changed'); await fx.core.executor.drain();
    assert.equal(fx.core.store.taskStatus(id), 'COMPLETED');
    const msgs = (fx.core.store.db.prepare('SELECT payload_json FROM outbox ORDER BY created_at').all() as any[]).map((m) => JSON.parse(m.payload_json));
    const titles = msgs.map((m) => m.title);
    assert.deepEqual(titles, ['Got it', 'Needs your authority', 'Done'], JSON.stringify(titles));
    const result = JSON.parse(fx.core.tasks.get(id).result_json);
    assert.ok(Array.isArray(result.evidence) && result.evidence[0].ok === true, 'completion carries verification evidence');
  } finally { fx.cleanup(); }
});

test('T-BOOT-04: missing provider, permission and budget -> one consolidated doctor packet; no-cost work continues; no repeated request', async () => {
  const { startDaemon } = await import('../../src/daemon/main.ts');
  const { apiCall } = await import('../../src/daemon/api.ts');
  const { MemorySecrets } = await import('../../src/secrets/keychain.ts');
  const base = realpathSync(mkdtempSync('/tmp/billy-bboot-'));
  const data = join(base, 'd'); const ws = join(base, 'ws'); mkdirSync(ws);
  const d = await startDaemon(data, true, { secrets: new MemorySecrets(), providerDriver: null, telegramTransport: null, sessionProbe: { read: () => ({ idle_ms: 9e9, locked: false, frontmost_bundle: null, at: Date.now() }) } });
  const token = readFileSync(join(data, 'run', 'api.token'), 'utf8').trim();
  const call = (m: string, p: string, b?: unknown) => apiCall(d.api.socketPath, token, m, p, b);
  try {
    await call('PUT', '/v1/policy', { scope: { ...scope({ file_roots: [ws] }), recipients: [] }, expires_at: new Date(Date.now() + 864e5).toISOString() });
    const doc = (await call('GET', '/v1/doctor')).body;
    const blockers = doc.checks.filter((c: any) => c.status === 'fail').map((c: any) => c.id).sort();
    assert.ok(['budget.provider', 'provider.credential', 'provider.models'].every((b) => blockers.includes(b)), blockers.join(','));
    assert.ok(doc.checks.filter((c: any) => c.status === 'fail').every((c: any) => c.fix || c.detail), 'each blocker names its fix');
    // A model task blocks; a no-cost local task (scripted) completes.
    d.core.notifyTargets.push({ channel: 'phone', destination: 'owner' });
    const m = await call('POST', '/v1/tasks', { goal: 'needs the model', client_message_id: 'boot-model-1' });
    const localId = d.core.tasks.create({ owner_id: 'owner', goal: 'local', project_scope: 'general', grant_id: d.cfg.default_grant_id, success_criteria: { description: 'x', postconditions: [] } });
    d.core.executor.seedPlan(localId, 1, 'scripted', { steps: [{ kind: 'action', step_key: 'w', tool_id: 'fs.write', arguments: { path: join(ws, 'free.txt'), content: 'x', mode: 'create' } }] });
    for (let i = 0; i < 60 && d.core.store.taskStatus(localId) !== 'COMPLETED'; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(d.core.store.taskStatus(localId), 'COMPLETED');
    for (let i = 0; i < 4; i++) { d.core.executor.wake('provider_configured'); d.core.executor.wake('provider_available'); await new Promise((r) => setTimeout(r, 300)); }
    const st = d.core.store.taskStatus(m.body.task_id);
    assert.ok(['WAITING_PROVIDER', 'BLOCKED_EXTERNAL'].includes(st), st);
    const blocked = (d.core.store.db.prepare(`SELECT payload_json FROM outbox WHERE json_extract(payload_json,'$.task_id')=?`).all(m.body.task_id) as any[])
      .map((r) => JSON.parse(r.payload_json)).filter((p) => p.title !== 'Got it');
    assert.ok(blocked.length <= 1, `unchanged blocker requested ${blocked.length} times`);
  } finally { await d.stop(); rmSync(base, { recursive: true, force: true }); }
});
