import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture, until } from '../fixtures.ts';
import { ModelGateway, type CompletionRequest, type ProviderDriver } from '../../src/ai/gateway.ts';
import { ModelPlanner } from '../../src/planner/model.ts';

test('shutdown cancels pending provider work without dispatching, rebilling or setting the owner stop latch', async () => {
  const fx = fixture({}, { model_egress: ['anthropic'] });
  let request: CompletionRequest | undefined;
  let calls = 0;
  let aborted = false;
  const driver: ProviderDriver = {
    id: 'anthropic',
    async listModels() { return []; },
    async call(_model, req) {
      calls++; request = req;
      return new Promise((_resolve, reject) => {
        req.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('cancelled transport')); }, { once: true });
      });
    },
  };
  const gateway = new ModelGateway(fx.core.store, fx.core.budget, driver, { roles: { planner: 'claude-opus-5-5' }, refusalFallback: false });
  fx.core.planners.set('model', new ModelPlanner({ gateway, registry: fx.core.registry, policy: fx.core.policy, egress: () => ['anthropic'] }));
  fx.core.budget.setCeiling('provider', 10_000_000, 'total', 'owner');
  try {
    const id = fx.task({ budget_scope: 'provider' });
    fx.core.executor.tick();
    await until(() => calls === 1);
    await fx.core.executor.stop(1000);
    assert.equal(aborted, true);
    assert.equal(fx.core.store.taskStatus(id), 'RUNNING', 'startup recovery owns interrupted task state');
    assert.equal(fx.core.store.stopLatch().stopped, false);
    assert.deepEqual(fx.core.executor.tick(), []);
    await assert.rejects(gateway.complete(request!), (e: any) => e.kind === 'stopped');
    assert.equal(calls, 1);
    assert.equal((fx.core.store.db.prepare("SELECT count(*) c FROM budget_entries WHERE kind='RESERVE'").get() as any).c, 1);
    assert.equal((fx.core.store.db.prepare("SELECT count(*) c FROM budget_entries WHERE kind='UNCERTAIN'").get() as any).c, 1, 'already sent requests retain uncertain spend');
    assert.equal((fx.core.store.db.prepare('SELECT count(*) c FROM attempts').get() as any).c, 0);
    await fx.core.recover();
    assert.equal(fx.core.store.taskStatus(id), 'READY');
  } finally { await fx.core.executor.stop(); fx.cleanup(); }
});

test('shutdown has a deadline and a late planner result cannot dispatch', async () => {
  const fx = fixture();
  let release!: () => void;
  let started = false;
  fx.core.planners.set('pending', {
    id: 'pending',
    async next() {
      started = true;
      await new Promise<void>((resolve) => { release = resolve; });
      return { step: { kind: 'action', step_key: 'late', tool_id: 'fs.write', arguments: { path: join(fx.root, 'late.txt'), content: 'unexpected', mode: 'create' } }, state: null };
    },
  });
  try {
    const id = fx.task();
    fx.core.executor.seedPlan(id, 1, 'pending', null);
    fx.core.executor.tick();
    await until(() => started);
    await assert.rejects(fx.core.executor.stop(20), /shutdown timeout/);
    release();
    await until(() => !fx.core.executor.isRunning(id));
    assert.equal((fx.core.store.db.prepare('SELECT count(*) c FROM attempts').get() as any).c, 0);
    assert.equal(fx.core.store.taskStatus(id), 'RUNNING');
    assert.equal(fx.core.store.stopLatch().stopped, false);
  } finally { release?.(); await fx.core.executor.stop(); fx.cleanup(); }
});

for (const control of ['pause', 'cancel', 'revise'] as const) {
  test(`${control} cancels the provider turn, frees the slot and never reuses an aborted planner signal`, async () => {
    const fx = fixture({ maxConcurrent: 1 }, { model_egress: ['anthropic'] });
    const requests: CompletionRequest[] = [];
    let aborts = 0;
    const driver: ProviderDriver = {
      id: 'anthropic',
      async listModels() { return []; },
      async call(model, req) {
        requests.push(req);
        assert.equal(req.signal!.aborted, false, 'each admitted turn has a fresh signal');
        if (requests.length === 1) {
          return new Promise((_resolve, reject) => {
            req.signal!.addEventListener('abort', () => { aborts++; reject(new Error('cancelled transport')); }, { once: true });
          });
        }
        return { text: JSON.stringify({ kind: 'done', summary: 'The fixture file is absent',
          success_criteria_json: JSON.stringify([{ kind: 'file_absent', path: join(fx.root, 'missing-after-resume.txt') }]) }),
          model, stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
      },
    };
    const gateway = new ModelGateway(fx.core.store, fx.core.budget, driver, { roles: { planner: 'claude-opus-5-5' }, refusalFallback: false });
    fx.core.planners.set('model', new ModelPlanner({ gateway, registry: fx.core.registry, policy: fx.core.policy, egress: () => ['anthropic'] }));
    fx.core.budget.setCeiling('provider', 10_000_000, 'total', 'owner');
    try {
      const id = fx.task({ budget_scope: 'provider' });
      fx.core.executor.tick();
      await until(() => requests.length === 1);
      if (control === 'pause') fx.core.control.pause(id, 'owner');
      else if (control === 'cancel') fx.core.control.cancel(id, 'owner');
      else fx.core.control.revise(id, 'revised question', { description: 'revised question', postconditions: [] }, null);
      await until(() => !fx.core.executor.isRunning(id));
      assert.equal(aborts, 1);
      assert.equal(requests.length, 1, 'no repair call after owner interruption');
      assert.equal((fx.core.store.db.prepare("SELECT count(*) c FROM budget_entries WHERE kind='RESERVE'").get() as any).c, 1);
      assert.equal((fx.core.store.db.prepare('SELECT count(*) c FROM attempts').get() as any).c, 0);

      // A newly admitted task can use the released scheduling slot.
      const local = fx.task();
      fx.core.executor.seedPlan(local, 1, 'scripted', { steps: [] });
      if (control === 'cancel') fx.core.control.finalizeCancellations();
      await fx.core.executor.drain();
      assert.equal(fx.core.store.taskStatus(local), 'COMPLETED');
      if (control === 'pause') {
        assert.equal(fx.core.store.taskStatus(id), 'PAUSED_BY_OWNER');
        fx.core.control.resume(id, 'owner');
        await fx.core.executor.drain();
      }
      if (control !== 'cancel') {
        assert.equal(fx.core.store.taskStatus(id), 'COMPLETED');
        assert.equal(requests.length, 2);
        assert.notEqual(requests[1].signal, requests[0].signal);
      } else assert.equal(fx.core.store.taskStatus(id), 'CANCELLED');
    } finally { await fx.core.executor.stop(); fx.cleanup(); }
  });
}
