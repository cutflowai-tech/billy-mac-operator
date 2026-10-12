// Provider/planner CONTRACT + INTEGRATION tests with a scripted fake driver.
// These are NOT PROVIDER_LIVE evidence: no real model is called here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { fixture } from '../fixtures.ts';
import { ModelGateway, type ProviderDriver, type CompletionRequest } from '../../src/ai/gateway.ts';
import { ModelPlanner } from '../../src/planner/model.ts';
import { FrozenCriteriaVerifier } from '../../src/verify/frozen.ts';

type Reply = { json?: unknown; text?: string; status?: number; retryAfter?: number; stop?: string };

class FakeDriver implements ProviderDriver {
  id = 'anthropic';
  calls: CompletionRequest[] = [];
  replies: Reply[];
  constructor(replies: Reply[]) { this.replies = replies; }
  async listModels() { return [{ id: 'claude-opus-5-5' }, { id: 'claude-haiku-5-5' }]; }
  async call(model: string, req: CompletionRequest) {
    this.calls.push(req);
    const r = this.replies.shift() ?? { json: { kind: 'fail', step_key: '', tool_id: '', arguments_json: '{}', reason: 'script exhausted', summary: '', reply_language: 'en', success_criteria_json: '[]' } };
    if (r.status) { const e: any = new Error(`status ${r.status}`); e.status = r.status; e.headers = { 'retry-after': String(r.retryAfter ?? '') }; throw e; }
    return { text: r.text ?? JSON.stringify(r.json), model, stop_reason: r.stop ?? 'end_turn', usage: { input_tokens: 1000, output_tokens: 200 } };
  }
}

const step = (o: Partial<Record<string, string>>) => ({ kind: 'action', step_key: 's', tool_id: '', arguments_json: '{}', reason: 'r', summary: '', reply_language: 'en', success_criteria_json: '[]', ...o });

function modelFixture(replies: Reply[], egress = ['anthropic']) {
  const fx = fixture({}, { model_egress: egress });
  const driver = new FakeDriver(replies);
  const gw = new ModelGateway(fx.core.store, fx.core.budget, driver, { roles: { planner: 'claude-opus-5-5' }, refusalFallback: true });
  const planner = new ModelPlanner({ gateway: gw, registry: fx.core.registry, policy: fx.core.policy, egress: () => egress });
  fx.core.planners.set('model', planner);
  (fx.core.executor as any).d.verifier = new FrozenCriteriaVerifier(fx.core.store);
  fx.core.budget.setCeiling('prov', 50_000_000, 'total', 'test-owner');
  const mk = (goal: string) => {
    const id = fx.core.tasks.create({ owner_id: 'owner', goal, project_scope: 'fx', grant_id: fx.grantId, budget_scope: 'prov', success_criteria: { description: goal, postconditions: [] } });
    fx.core.executor.seedPlan(id, 1, 'model', null);
    return id;
  };
  return { fx, driver, gw, mk };
}

test('model-driven multi-step task: plans, acts through the broker, verifies frozen criteria', async () => {
  const f = modelFixture([]);
  const p = join(f.fx.root, 'notes.txt');
  f.driver.replies.push(
    { json: step({ step_key: 'write', tool_id: 'fs.write', arguments_json: JSON.stringify({ path: p, content: 'hello Billy', mode: 'create' }), success_criteria_json: JSON.stringify([{ kind: 'file_contains', path: p, text: 'hello Billy' }]) }) },
    { json: step({ step_key: 'check', tool_id: 'fs.read', arguments_json: JSON.stringify({ path: p }) }) },
    { json: step({ kind: 'done', summary: 'Wrote notes.txt' }) },
  );
  try {
    const id = f.mk('write hello Billy into notes.txt');
    await f.fx.core.executor.drain();
    assert.equal(f.fx.core.store.taskStatus(id), 'COMPLETED');
    assert.equal(readFileSync(p, 'utf8'), 'hello Billy');
    assert.equal(f.driver.calls.length, 3);
    // Untrusted tool output is labelled as such in the next planner input.
    assert.match(f.driver.calls[2].messages[0].content, /<untrusted_tool_output>/);
    // Usage settled into the budget ledger.
    assert.ok(f.fx.core.budget.remaining('prov')! < 50_000_000);
  } finally { f.fx.cleanup(); }
});

test('planner receives actionable desktop element tokens while credentials are redacted', async () => {
  const f = modelFixture([{ json: step({ kind: 'done', summary: 'Read the screen' }) }]);
  try {
    const id = f.mk('inspect the Save button');
    const planner = f.fx.core.planners.get('model')!;
    await planner.next({ task: f.fx.core.tasks.get(id), state: null, lastFailure: null, replans: 0,
      signal: new AbortController().signal, history: [{ step_key: 'observe', tool_id: 'desktop.observe', verdict: 'COMMITTED',
        reason: '',
        receipt: { observation_ref: 'observation-id', elements: [{ element_token: 'snapshot:7', label: 'Save' }], token: 'credential-value' } }] });
    const prompt = f.driver.calls[0].messages[0].content;
    assert.ok(prompt.includes('"element_token"') && prompt.includes('"snapshot:7"'));
    assert.ok(!prompt.includes('credential-value'));
    assert.match(prompt, /<untrusted_tool_output>/);
  } finally { f.fx.cleanup(); }
});

test('latest desktop observation exposes all 400 normal rows without cutting tokens', async () => {
  const f = modelFixture([{ json: step({ kind: 'done', summary: 'Read the screen' }) }]);
  try {
    const id = f.mk('inspect the last control');
    const elements = Array.from({ length: 400 }, (_, i) => ({ element_token: `snapshot:${i}`, role: 'AXButton', label: `Button ${i}`, value: '' }));
    await f.fx.core.planners.get('model')!.next({ task: f.fx.core.tasks.get(id), state: null, lastFailure: null, replans: 0,
      signal: new AbortController().signal, history: [{ step_key: 'observe', tool_id: 'desktop.observe', verdict: 'COMMITTED', reason: '',
        receipt: { observation_ref: 'observation-id', elements } }] });
    const prompt = f.driver.calls[0].messages[0].content;
    const body = prompt.split('<untrusted_tool_output>')[1].split('</untrusted_tool_output>')[0];
    const context = JSON.parse(body);
    assert.equal(context.element_rows.length, 400);
    assert.equal(context.omitted_elements, 0);
    assert.equal(context.element_rows[399][0], 'snapshot:399');
    assert.equal(context.element_rows[399][2], 'Button 399');
    assert.ok(body.length <= 25_000);
  } finally { f.fx.cleanup(); }
});

test('oversized desktop observation reports omitted complete rows within context budget', async () => {
  const f = modelFixture([{ json: step({ kind: 'done', summary: 'Read the screen' }) }]);
  try {
    const id = f.mk('inspect the last control');
    const elements = Array.from({ length: 400 }, (_, i) => ({ element_token: `snapshot:${i}`, role: 'AXButton',
      label: 'l'.repeat(120), value: 'v'.repeat(200), frame: { x: 1, y: 2, w: 3, h: 4 } }));
    await f.fx.core.planners.get('model')!.next({ task: f.fx.core.tasks.get(id), state: null, lastFailure: null, replans: 0,
      signal: new AbortController().signal, history: [{ step_key: 'observe', tool_id: 'desktop.observe', verdict: 'COMMITTED', reason: '',
        receipt: { observation_ref: 'observation-id', elements } }] });
    const body = f.driver.calls[0].messages[0].content.split('<untrusted_tool_output>')[1].split('</untrusted_tool_output>')[0];
    const context = JSON.parse(body);
    assert.ok(context.omitted_elements > 0);
    assert.equal(context.element_rows.at(-1)[0], 'snapshot:399');
    assert.match(context.next_observation, /desktop.observe query/);
    assert.ok(body.length <= 25_000);
  } finally { f.fx.cleanup(); }
});

test('false "done" claim is rejected by frozen criteria (independent verification)', async () => {
  const f = modelFixture([]);
  const p = join(f.fx.root, 'promised.txt');
  const done = { json: step({ kind: 'done', summary: 'All done (not really)' }) };
  f.driver.replies.push({ json: step({ kind: 'done', summary: 'done', success_criteria_json: JSON.stringify([{ kind: 'file_contains', path: p, text: 'x' }]) }) }, done, done, done, done);
  try {
    const id = f.mk('create promised.txt');
    await f.fx.core.executor.drain();
    assert.equal(f.fx.core.store.taskStatus(id), 'FAILED');
    assert.equal(existsSync(p), false);
    assert.match(JSON.parse(f.fx.core.tasks.get(id).result_json).error, /postconditions not met/);
  } finally { f.fx.cleanup(); }
});

test('T-AI-02: malformed/truncated output never executes; bounded repair -> truthful waiting state', async () => {
  const f = modelFixture([
    { text: '{"kind":"action","step_key":"x","tool_id":"fs.write","arguments_json":"{\\"path\\":' },     // truncated
    { json: step({ step_key: 'bad key!', tool_id: 'fs.write', arguments_json: '{}' }) },                 // invalid step key
    { json: { kind: 'action' }, stop: 'max_tokens' },                                                    // truncated by max_tokens
  ]);
  try {
    const id = f.mk('do something');
    await f.fx.core.executor.drain();
    assert.equal(f.fx.core.store.taskStatus(id), 'WAITING_PROVIDER');
    assert.match(f.fx.core.tasks.get(id).wait_reason, /invalid output 3 times/);
    const attempts = f.fx.core.store.db.prepare('SELECT count(*) c FROM attempts').get() as any;
    assert.equal(attempts.c, 0, 'no partially parsed action reached the broker');
  } finally { f.fx.cleanup(); }
});

test('T-AI-02: repeated equivalent failing strategy is bounded (no infinite loop)', async () => {
  const outside = '/etc/hosts-billy-test';
  const bad = { json: step({ step_key: 'w', tool_id: 'fs.write', arguments_json: JSON.stringify({ path: outside, content: 'x', mode: 'create' }), success_criteria_json: JSON.stringify([{ kind: 'file_contains', path: outside, text: 'x' }]) }) };
  const f = modelFixture(Array.from({ length: 30 }, () => bad));
  try {
    const id = f.mk('write outside the root');
    await f.fx.core.executor.drain();
    const st = f.fx.core.store.taskStatus(id);
    assert.equal(st, 'BLOCKED_EXTERNAL');
    assert.ok(f.driver.calls.length <= 12, `bounded model calls: ${f.driver.calls.length}`);
    assert.match(f.fx.core.tasks.get(id).wait_reason, /recovery exhausted/);
  } finally { f.fx.cleanup(); }
});

test('T-AI-03: 429 with retry-after -> WAITING_PROVIDER, gateway honours backoff, no other vendor used', async () => {
  const f = modelFixture([{ status: 429, retryAfter: 30 }]);
  try {
    const id = f.mk('anything');
    await f.fx.core.executor.drain();
    assert.equal(f.fx.core.store.taskStatus(id), 'WAITING_PROVIDER');
    f.fx.core.executor.wake('provider_available');
    await f.fx.core.executor.drain();
    assert.equal(f.driver.calls.length, 1, 'no call during the retry-after window');
    const r = f.fx.core.store.db.prepare(`SELECT payload_json FROM events WHERE domain='model_call' AND kind='failed'`).get() as any;
    assert.equal(JSON.parse(r.payload_json).retry_in_ms, 30_000);
  } finally { f.fx.cleanup(); }
});

test('T-AI-08: routine deterministic monitoring makes zero model calls', async () => {
  const f = modelFixture([]);
  try {
    for (let i = 0; i < 50; i++) { f.fx.core.executor.tick(); f.fx.core.control.finalizeCancellations(); await f.fx.core.outbox.deliverDue(); }
    f.fx.core.budget.remaining('prov');
    assert.equal(f.gw.calls, 0);
    const id = f.mk('a meaningful event');
    f.driver.replies.push({ json: step({ kind: 'done', summary: 'ok' }) });
    await f.fx.core.executor.drain();
    assert.equal(f.gw.calls, 1, 'a real task still triggers reasoning');
    assert.equal(f.fx.core.store.taskStatus(id), 'COMPLETED');
  } finally { f.fx.cleanup(); }
});

test('model discovery validates configured role models against the account', async () => {
  const f = modelFixture([]);
  try {
    f.gw.cfg.roles.summarizer = 'claude-made-up-9';
    const d = await f.gw.discover();
    assert.equal(d.roles.planner.ok, true);
    assert.equal(d.roles.summarizer.ok, false);
  } finally { f.fx.cleanup(); }
});

test('T-AI-02: no state-changing effect is dispatched before checkable success criteria exist', async () => {
  const f = modelFixture([]);
  const p = join(f.fx.root, 'x.txt');
  const noCriteria = { json: step({ step_key: 'w', tool_id: 'fs.write', arguments_json: JSON.stringify({ path: p, content: 'x', mode: 'create' }) }) };
  f.driver.replies.push(noCriteria, noCriteria, noCriteria, noCriteria, noCriteria, noCriteria);
  try {
    const id = f.mk('write x');
    await f.fx.core.executor.drain();
    assert.equal(existsSync(p), false);
    assert.equal((f.fx.core.store.db.prepare('SELECT count(*) c FROM attempts').get() as any).c, 0);
    assert.match(f.driver.calls[1].messages[0].content, /declare success_criteria_json/);
    f.fx.core.executor.wake('provider_available'); await f.fx.core.executor.drain();
    assert.equal(f.fx.core.store.taskStatus(id), 'BLOCKED_EXTERNAL', 'second invalid cycle stops auto-retry (no billed loop)');
  } finally { f.fx.cleanup(); }
});
