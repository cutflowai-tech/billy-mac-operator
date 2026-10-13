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

test('waiters that queued for keys in different orders cannot deadlock each other', () => {
  const fx = fixture();
  try {
    const a = fx.task(), b = fx.task(); fx.run(a); fx.run(b);
    const k1 = { resource_key: 'k1', mode: 'exclusive' as const }, k2 = { resource_key: 'k2', mode: 'exclusive' as const };
    // h1 holds k1, h2 holds k2.
    assert.equal(fx.core.claims.acquireAll([k1], 'h1').ok, true);
    assert.equal(fx.core.claims.acquireAll([k2], 'h2').ok, true);
    // A first waits for k2 alone; B then waits for k1 alone.
    assert.equal(fx.core.claims.acquireAll([k2], 'a', `task:${a}`).ok, false);
    assert.equal(fx.core.claims.acquireAll([k1], 'b', `task:${b}`).ok, false);
    // Both later need both keys (a new step), so each would otherwise head one queue and wait behind the other.
    assert.equal(fx.core.claims.acquireAll([k1, k2], 'a', `task:${a}`).ok, false);
    assert.equal(fx.core.claims.acquireAll([k1, k2], 'b', `task:${b}`).ok, false);
    fx.core.claims.releaseAll('h1'); fx.core.claims.releaseAll('h2');
    const ra = fx.core.claims.acquireAll([k1, k2], 'a', `task:${a}`).ok;
    const rb = fx.core.claims.acquireAll([k1, k2], 'b', `task:${b}`).ok;
    assert.equal(ra || rb, true, 'one waiter makes progress once holders release');
    if (ra) { fx.core.claims.releaseAll('a'); assert.equal(fx.core.claims.acquireAll([k1, k2], 'b', `task:${b}`).ok, true); }
  } finally { fx.cleanup(); }
});

test('a waiter that moves on to other keys no longer blocks the queue it left', () => {
  const fx = fixture();
  try {
    const a = fx.task(), b = fx.task(); fx.run(a); fx.run(b);
    const k1 = { resource_key: 'k1', mode: 'exclusive' as const }, k2 = { resource_key: 'k2', mode: 'exclusive' as const };
    fx.core.claims.acquireAll([k1], 'h1'); fx.core.claims.acquireAll([k2], 'h2');
    assert.equal(fx.core.claims.acquireAll([k1], 'a', `task:${a}`).ok, false);   // A queued at the head of k1
    assert.equal(fx.core.claims.acquireAll([k2], 'a', `task:${a}`).ok, false);   // A's step changed: now waits on k2 only
    fx.core.claims.releaseAll('h1');
    assert.equal(fx.core.claims.acquireAll([k1], 'b', `task:${b}`).ok, true, 'B is not blocked by the stale k1 entry');
  } finally { fx.cleanup(); }
});

test('acquiring clears the queue entries of the acquired keys', () => {
  const fx = fixture();
  try {
    const a = fx.task(); fx.run(a);
    const k1 = { resource_key: 'k1', mode: 'exclusive' as const }, k2 = { resource_key: 'k2', mode: 'exclusive' as const };
    fx.core.claims.acquireAll([k1, k2], 'h');
    assert.equal(fx.core.claims.acquireAll([k1, k2], 'a', `task:${a}`).ok, false);
    fx.core.claims.releaseAll('h');
    assert.equal(fx.core.claims.acquireAll([k1, k2], 'a', `task:${a}`).ok, true);
    assert.equal((fx.core.store.db.prepare('SELECT count(*) c FROM resource_waiters').get() as any).c, 0);
  } finally { fx.cleanup(); }
});

for (const control of ['pause', 'cancel', 'revise'] as const) {
  test(`${control} during completion verification neither completes, fails nor un-pauses the task`, async () => {
    const fx = fixture();
    const d = (fx.core.executor as any).d;
    const notes: string[] = [];
    let release!: () => void, entered = false;
    d.notify = (kind: string) => { notes.push(kind); };
    const real = d.verifier;
    d.verifier = { async verify(t: any, h: any) { entered = true; await new Promise<void>((r) => { release = r; }); return real.verify(t, h); } };
    try {
      const id = fx.task();
      fx.core.executor.seedPlan(id, 1, 'scripted', { steps: [] });
      fx.core.executor.tick();
      const deadline = Date.now() + 5000;
      while (!entered && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
      assert.equal(fx.core.store.taskStatus(id), 'VERIFYING');
      if (control === 'pause') fx.core.control.pause(id, 'owner');
      else if (control === 'cancel') fx.core.control.cancel(id, 'owner');
      else fx.core.control.revise(id, 'revised', { description: 'revised', postconditions: [] }, null);
      release();
      d.verifier = real;
      await fx.core.executor.drain();
      assert.equal(notes.includes('completed') && control !== 'revise', false, `no false completion notice: ${notes}`);
      if (control === 'pause') assert.equal(fx.core.store.taskStatus(id), 'PAUSED_BY_OWNER');
      if (control === 'cancel') { fx.core.control.finalizeCancellations(); assert.equal(fx.core.store.taskStatus(id), 'CANCELLED'); }
      if (control === 'revise') assert.equal(fx.core.tasks.get(id).revision, 2);
    } finally { release?.(); await fx.core.executor.stop(); fx.cleanup(); }
  });
}
