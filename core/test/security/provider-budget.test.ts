import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../fixtures.ts';
import { ModelGateway, type CompletionRequest, type ProviderDriver } from '../../src/ai/gateway.ts';

test('multibyte prompts cannot bypass the spending ceiling through an average token estimate', async () => {
  const fx = fixture(); let calls = 0;
  const driver: ProviderDriver = { id: 'anthropic', async listModels() { return []; },
    async call(model) { calls++; return { model, text: '{}', stop_reason: 'end_turn', usage: { input_tokens: 10000, output_tokens: 1 } }; } };
  const gw = new ModelGateway(fx.core.store, fx.core.budget, driver, { roles: { planner: 'claude-opus-5-5' }, refusalFallback: false });
  const req: CompletionRequest = { role: 'planner', system: '🚀'.repeat(3000), messages: [{ role: 'user', content: 'اشرح' }],
    schema: { type: 'object', properties: {} }, max_tokens: 1, effort: 'low', task_id: null, grant_egress: ['anthropic'], budget_scopes: ['test'] };
  try {
    fx.core.budget.setCeiling('test', 30000, 'total', 'owner');
    await assert.rejects(gw.complete(req), (e: any) => e.kind === 'budget');
    assert.equal(calls, 0, 'request whose potential input charge exceeds the ceiling is never dispatched');
    assert.equal(fx.core.budget.remaining('test'), 30000);
  } finally { fx.cleanup(); }
});
