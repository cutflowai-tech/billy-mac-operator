import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../fixtures.ts';
import { costMicros, ModelGateway, type CompletionRequest, type ProviderDriver } from '../../src/ai/gateway.ts';

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

test('Haiku long-context pricing counts cache tokens in the 100K threshold', () => {
  assert.equal(costMicros('claude-haiku-5-5', { input_tokens: 100_000, output_tokens: 10 }), 10_005);
  assert.equal(costMicros('claude-haiku-5-5', { input_tokens: 1, cache_read_input_tokens: 100_000, output_tokens: 10 }), 5026);
  assert.equal(costMicros('claude-haiku-5-5', { input_tokens: 100_001, output_tokens: 10 }), 50_026);
});

test('an unpriced provider response retains uncertain spend instead of inventing a price', async () => {
  const fx = fixture();
  const driver: ProviderDriver = { id: 'anthropic', async listModels() { return []; }, async call() {
    return { model: 'future-unpriced-model', text: '{}', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
  } };
  const gw = new ModelGateway(fx.core.store, fx.core.budget, driver, { roles: { planner: 'claude-opus-5-5' }, refusalFallback: false });
  try {
    fx.core.budget.setCeiling('test', 1_000_000, 'total', 'owner');
    await assert.rejects(gw.complete({ role: 'planner', system: '', messages: [], schema: {}, max_tokens: 10, effort: 'low',
      task_id: null, grant_egress: ['anthropic'], budget_scopes: ['test'] }), (e: any) => e.kind === 'config');
    assert.ok(fx.core.budget.remaining('test')! < 1_000_000, 'uncertain billing is retained');
  } finally { fx.cleanup(); }
});
