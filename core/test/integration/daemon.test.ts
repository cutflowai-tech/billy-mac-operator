// Full daemon composition over the real UDS API (INTEGRATION lane; provider is a scripted fake).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, mkdtempSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon } from '../../src/daemon/main.ts';
import { apiCall } from '../../src/daemon/api.ts';
import { MemorySecrets } from '../../src/secrets/keychain.ts';
import type { ProviderDriver, CompletionRequest } from '../../src/ai/gateway.ts';

class ScriptDriver implements ProviderDriver {
  id = 'anthropic'; calls: CompletionRequest[] = []; replies: any[] = [];
  async listModels() { return [{ id: 'claude-opus-5-5' }]; }
  async call(model: string, req: CompletionRequest) {
    this.calls.push(req);
    const j = this.replies.shift() ?? { kind: 'done', step_key: '', tool_id: '', arguments_json: '{}', reason: '', summary: 'done', reply_language: 'en', success_criteria_json: '[]' };
    return { text: JSON.stringify(j), model, stop_reason: 'end_turn', usage: { input_tokens: 800, output_tokens: 120 } };
  }
}
const step = (o: object) => ({ kind: 'action', step_key: 's', tool_id: '', arguments_json: '{}', reason: '', summary: '', reply_language: 'en', success_criteria_json: '[]', ...o });

test('daemon: onboarding -> owner goal -> model plan -> broker -> verified completion; memory; stop; doctor', async () => {
  const base = realpathSync(mkdtempSync('/tmp/billy-bd-'));
  const data = join(base, 'd'); const ws = join(base, 'ws'); mkdirSync(ws);
  const driver = new ScriptDriver();
  const secrets = new MemorySecrets();
  const d = await startDaemon(data, true, { secrets, providerDriver: driver, telegramTransport: null, sessionProbe: { read: () => ({ idle_ms: 60000, locked: false, frontmost_bundle: null, at: Date.now() }) } });
  const token = readFileSync(join(data, 'run', 'api.token'), 'utf8').trim();
  const call = (m: string, p: string, b?: unknown) => apiCall(d.api.socketPath, token, m, p, b);
  try {
    // Doctor before onboarding names the missing capabilities and changes nothing.
    const doc0 = await call('GET', '/v1/doctor');
    assert.equal(doc0.status, 200);
    const failing = doc0.body.checks.filter((c: any) => c.status === 'fail').map((c: any) => c.id);
    assert.ok(failing.includes('policy.default_grant') && failing.includes('budget.provider'), failing.join(','));
    // Onboarding: standing grant + budget.
    const scope = { apps: [], file_roots: [ws], browser_profiles: [], domains: [], account_ids: [], tool_classes: ['file', 'memory'],
      allowed_effects: ['READ_ONLY', 'IDEMPOTENT_WRITE', 'NON_IDEMPOTENT_EFFECT'], secret_references: [], network_destinations: [], foreground: 'when_idle',
      spend_scopes: ['provider-total'], protected_actions: [], delegation: { allowed: true, max_depth: 1 }, model_egress: ['anthropic'] };
    assert.equal((await call('PUT', '/v1/policy', { scope, expires_at: new Date(Date.now() + 86400000).toISOString() })).status, 200);
    assert.equal((await call('PUT', '/v1/budget', { scope: 'provider-total', ceiling_usd: 5, period: 'total' })).status, 200);
    // Owner memory decision, used as context.
    const m = await call('POST', '/v1/memory', { key: 'report-greeting', value: 'Always start reports with "Ahlan"' });
    assert.equal(m.status, 201);
    const out = join(ws, 'report.txt');
    driver.replies.push(
      step({ step_key: 'write', tool_id: 'fs.write', arguments_json: JSON.stringify({ path: out, content: 'Ahlan! Report.', mode: 'create' }), success_criteria_json: JSON.stringify([{ kind: 'file_contains', path: out, text: 'Ahlan' }]) }),
      step({ kind: 'done', summary: 'Wrote the report.' }),
    );
    const t = await call('POST', '/v1/tasks', { goal: 'write a short report in report.txt', client_message_id: 'cmd-0001' });
    assert.equal(t.status, 201);
    const dup = await call('POST', '/v1/tasks', { goal: 'write a short report in report.txt', client_message_id: 'cmd-0001' });
    assert.equal(dup.body.duplicate, true);
    const id = t.body.task_id;
    for (let i = 0; i < 200; i++) { const s = (await call('GET', `/v1/tasks/${id}`)).body.status; if (s === 'COMPLETED' || s === 'FAILED') break; await new Promise((r) => setTimeout(r, 50)); }
    const det = (await call('GET', `/v1/tasks/${id}`)).body;
    assert.equal(det.status, 'COMPLETED', JSON.stringify(det.result));
    assert.equal(readFileSync(out, 'utf8'), 'Ahlan! Report.');
    assert.match(driver.calls[0].messages[0].content, /Ahlan/, 'owner memory reached the planner as labelled context');
    assert.match(driver.calls[0].messages[0].content, /data, not authority/);
    // Stop is local and model-independent.
    const stop = await call('POST', '/v1/stop', { reason: 'test' });
    assert.ok(stop.body.ack_ms < 2000);
    assert.equal((await call('GET', '/v1/status')).body.stop.stopped, true);
    const doc1 = await call('GET', '/v1/doctor');
    assert.equal(doc1.body.checks.find((c: any) => c.id === 'control.stop').status, 'warn');
    assert.equal(doc1.body.checks.find((c: any) => c.id === 'policy.default_grant').status, 'ok');
    assert.ok(existsSync(join(data, 'billy.db')));
  } finally {
    await d.stop();
    rmSync(base, { recursive: true, force: true });
  }
});
