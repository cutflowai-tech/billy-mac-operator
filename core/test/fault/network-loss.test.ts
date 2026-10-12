// Moved from operations.test.ts into the lane that matches the scenario's kind (handoff §19.1); assertions unchanged.
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

test('T-AI-05: network loss -> local-safe work progresses, cloud work waits, resumes after restore without duplicate admission', async () => {
  const fx = fixture({}, { model_egress: ['anthropic'] });
  const net = new FlakyNet();
  const gw = new ModelGateway(fx.core.store, fx.core.budget, net, { roles: { planner: 'claude-opus-5-5' }, refusalFallback: false });
  fx.core.planners.set('model', new ModelPlanner({ gateway: gw, registry: fx.core.registry, policy: fx.core.policy, egress: () => ['anthropic'] }));
  fx.core.budget.setCeiling('p', 10_000_000, 'total', 'owner');
  try {
    const admit = (mid: string, planner: string, steps?: any) => fx.core.inbox.admit('local-app', mid, 'owner', 'ADMITTED', () => {
      // The cloud reply must rely on independently checked fixture state, not its
      // own "done" claim. Local work establishes this artifact while offline.
      const id = fx.core.tasks.create({ owner_id: 'owner', goal: mid, project_scope: 'fx', grant_id: fx.grantId, budget_scope: 'p',
        success_criteria: { description: mid, postconditions: planner === 'model' ? [{ kind: 'file_contains', path: join(fx.root, 'local.txt'), text: 'ok' }] : [] } });
      fx.core.executor.seedPlan(id, 1, planner, steps ?? null); return { task_id: id, revision: 1 };
    });
    const cloud = admit('cloud-1', 'model');
    const local = admit('local-1', 'scripted', { steps: [{ kind: 'action', step_key: 'w', tool_id: 'fs.write', arguments: { path: join(fx.root, 'local.txt'), content: 'ok', mode: 'create' } }] });
    await fx.core.executor.drain();
    assert.equal(fx.core.store.taskStatus(local.task_id!), 'COMPLETED');
    assert.equal(fx.core.store.taskStatus(cloud.task_id!), 'WAITING_PROVIDER');
    net.online = true;
    gw.setDriver(net); // network restored (clears backoff), event wakes waiting work
    fx.core.executor.wake('provider_available');
    assert.equal(admit('cloud-1', 'model').duplicate, true, 'reconnect retry of the same command is not a new task');
    await fx.core.executor.drain();
    assert.equal(fx.core.store.taskStatus(cloud.task_id!), 'COMPLETED');
    assert.equal((fx.core.store.db.prepare('SELECT count(*) c FROM tasks').get() as any).c, 2);
  } finally { fx.cleanup(); }
});

