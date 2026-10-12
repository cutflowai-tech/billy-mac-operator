// Moved from planner.test.ts into the lane that matches the scenario's kind (handoff §19.1); assertions unchanged.
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

test('T-SEC-12: provider not authorized for the data class -> waits, zero calls', async () => {
  const f = modelFixture([{ json: step({ kind: 'done' }) }], []);
  try {
    const id = f.mk('BILLY_CANARY_privatepayload1 summarize');
    await f.fx.core.executor.drain();
    assert.equal(f.fx.core.store.taskStatus(id), 'WAITING_PERMISSION');
    assert.equal(f.driver.calls.length, 0);
  } finally { f.fx.cleanup(); }
});

