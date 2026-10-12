import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../fixtures.ts';

for (const interrupt of ['cancel', 'pause', 'stop'] as const) {
  test(`resource FIFO progresses after its head task is ${interrupt}ed`, () => {
    const fx = fixture();
    try {
      const a = fx.task(), b = fx.task(), c = fx.task();
      fx.run(a); fx.run(b); fx.run(c);
      const req = [{ resource_key: 'desktop:billy', mode: 'exclusive' as const }];
      assert.equal(fx.core.claims.acquireAll(req, 'attempt:a', `task:${a}`).ok, true);
      assert.equal(fx.core.claims.acquireAll(req, 'attempt:b', `task:${b}`).ok, false);
      fx.core.store.transitionTask(b, 'WAITING_RESOURCE', { wait_condition: 'resource_released' });
      assert.equal(fx.core.claims.acquireAll(req, 'attempt:c', `task:${c}`).ok, false);
      fx.core.store.transitionTask(c, 'WAITING_RESOURCE', { wait_condition: 'resource_released' });
      if (interrupt === 'cancel') { fx.core.control.cancel(b, 'owner'); fx.core.control.finalizeCancellations(); }
      else if (interrupt === 'pause') fx.core.control.pause(b, 'owner');
      else { fx.core.control.stopAll('owner'); fx.core.control.clearStop('owner'); fx.core.control.resume(c, 'owner'); }
      assert.equal(fx.core.store.db.prepare('SELECT 1 FROM resource_waiters WHERE waiter=?').get(`task:${b}`), undefined);
      fx.core.claims.releaseAll('attempt:a');
      assert.equal(fx.core.claims.acquireAll(req, 'attempt:c', `task:${c}`).ok, true);
    } finally { fx.cleanup(); }
  });
}

test('withdrawal wakes successors even when the resource has no holder left', () => {
  const fx = fixture();
  try {
    const b = fx.task(), c = fx.task(); fx.run(b); fx.run(c);
    const req = [{ resource_key: 'desktop:billy', mode: 'exclusive' as const }];
    fx.core.claims.acquireAll(req, 'holder');
    fx.core.claims.acquireAll(req, 'b', `task:${b}`); fx.core.store.transitionTask(b, 'WAITING_RESOURCE', { wait_condition: 'resource_released' });
    fx.core.claims.acquireAll(req, 'c', `task:${c}`); fx.core.store.transitionTask(c, 'WAITING_RESOURCE', { wait_condition: 'resource_released' });
    fx.core.claims.releaseAll('holder');
    // Successor retried before the FIFO head did, then the owner cancels the head.
    fx.core.store.transitionTask(c, 'RUNNING');
    assert.equal(fx.core.claims.acquireAll(req, 'c', `task:${c}`).ok, false);
    fx.core.store.transitionTask(c, 'WAITING_RESOURCE', { wait_condition: 'resource_released' });
    fx.core.control.cancel(b, 'owner');
    assert.equal(fx.core.store.taskStatus(c), 'READY');
    assert.equal(fx.core.claims.acquireAll(req, 'c', `task:${c}`).ok, true);
  } finally { fx.cleanup(); }
});
