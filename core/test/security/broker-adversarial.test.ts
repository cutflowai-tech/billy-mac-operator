// Moved from broker.test.ts into the lane that matches the scenario's kind (handoff §19.1); assertions unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, symlinkSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, scope } from '../fixtures.ts';
import { fsWrite } from '../../src/tools/fs.ts';
import type { ToolAdapter } from '../../src/broker/types.ts';
import { CycleError } from '../../src/tasks/tasks.ts';

const h = (s: string) => createHash('sha256').update(s).digest('hex');
const attempts = (fx: any) => fx.core.store.db.prepare('SELECT status, tool_id FROM attempts').all() as any[];

test('T-ACTION-05: canonical target binding; similar names outside scope are denied', async () => {
  const fx = fixture();
  try {
    const id = fx.task(); fx.run(id);
    // Prefix collision: /root vs /root-evil
    const evil = fx.root + '-evil'; mkdirSync(evil);
    for (const path of [join(evil, 'x.txt'), join(fx.outside, 'x.txt'), join(fx.root, '..', 'outside', 'x.txt')]) {
      const r = await fx.core.broker.submit(fx.proposal(id, 'fs.write', { path, content: 'x', mode: 'create' }, path));
      assert.ok(['DENIED', 'REJECTED'].includes(r.verdict), `${path}: ${r.verdict} ${r.reason}`);
    }
    assert.equal(readdirSync(evil).length + readdirSync(fx.outside).length, 0);
  } finally { fx.cleanup(); }
});

test('T-SEC-04: symlink escapes and mid-flight directory swap fail safely', async () => {
  const fx = fixture();
  try {
    const id = fx.task(); fx.run(id);
    symlinkSync(fx.outside, join(fx.root, 'link-dir'));
    writeFileSync(join(fx.outside, 'secret.txt'), 'outside');
    symlinkSync(join(fx.outside, 'secret.txt'), join(fx.root, 'link-file'));
    const outsideBefore = h(readFileSync(join(fx.outside, 'secret.txt'), 'utf8'));
    const r1 = await fx.core.broker.submit(fx.proposal(id, 'fs.write', { path: join(fx.root, 'link-dir', 'pwn.txt'), content: 'x', mode: 'create' }, 'a'));
    assert.equal(r1.verdict, 'DENIED', r1.reason); // canonical parent is outside root
    const r2 = await fx.core.broker.submit(fx.proposal(id, 'fs.write', { path: join(fx.root, 'link-file'), content: 'x', mode: 'replace', expected_sha256: outsideBefore }, 'b'));
    assert.equal(r2.verdict, 'DENIED', r2.reason); // leaf symlink refused
    const r3 = await fx.core.broker.submit(fx.proposal(id, 'fs.read', { path: join(fx.root, 'link-file') }, 'c'));
    assert.equal(r3.verdict, 'DENIED');
    // Race: directory is swapped for a symlink between resolution and dispatch.
    mkdirSync(join(fx.root, 'sub'));
    const raceTool: ToolAdapter = { ...fsWrite, spec: { ...fsWrite.spec, tool_id: 'fs.write_race' },
      preconditions(a, r, c) {
        renameSync(join(fx.root, 'sub'), join(fx.root, 'sub-old'));
        symlinkSync(fx.outside, join(fx.root, 'sub'));
        return fsWrite.preconditions(a, r, c);
      } };
    fx.core.registry.register(raceTool);
    const r4 = await fx.core.broker.submit(fx.proposal(id, 'fs.write_race', { path: join(fx.root, 'sub', 'x.txt'), content: 'x', mode: 'create' }, 'd'));
    assert.equal(r4.verdict, 'STALE', r4.reason);
    assert.match(r4.reason, /target identity changed/);
    assert.equal(existsSync(join(fx.outside, 'x.txt')), false);
    assert.equal(h(readFileSync(join(fx.outside, 'secret.txt'), 'utf8')), outsideBefore);
  } finally { fx.cleanup(); }
});

test('T-ACTION-06: revocation between planning and dispatch blocks the queued action', async () => {
  const fx = fixture();
  try {
    const id = fx.task(); fx.run(id);
    // Revoke before submit
    const g2 = crypto.randomUUID();
    fx.core.policy.putGrant({ grant_id: g2, owner_id: 'owner', scope: scope({ file_roots: [fx.root] }), parent_grant_id: null, task_id: null, expires_at: '2099-01-01T00:00:00.000Z', source: 't' });
    const id2 = fx.task({ grant_id: g2 }); fx.run(id2);
    fx.core.policy.revoke(g2, 'owner revoked');
    const r1 = await fx.core.broker.submit(fx.proposal(id2, 'fs.write', { path: join(fx.root, 'a'), content: 'x', mode: 'create' }, 'a'));
    assert.equal(r1.verdict, 'NEEDS_AUTHORITY');
    // Revoke after authorization but before dispatch (inside preconditions, i.e. mid-flight)
    const revoking: ToolAdapter = { ...fsWrite, spec: { ...fsWrite.spec, tool_id: 'fs.write_revoke' },
      preconditions(a, r, c) { fx.core.policy.revoke(fx.grantId, 'mid-flight revoke'); return fsWrite.preconditions(a, r, c); } };
    fx.core.registry.register(revoking);
    const r2 = await fx.core.broker.submit(fx.proposal(id, 'fs.write_revoke', { path: join(fx.root, 'b'), content: 'x', mode: 'create' }, 'b'));
    assert.equal(r2.verdict, 'DENIED', r2.reason);
    assert.equal(existsSync(join(fx.root, 'b')), false);
    // A permissive alternate route is not chosen: fs.copy into the same path is also denied.
    writeFileSync(join(fx.root, 'src'), 'x');
    const r3 = await fx.core.broker.submit(fx.proposal(id, 'fs.copy', { from: join(fx.root, 'src'), to: join(fx.root, 'b') }, 'c'));
    assert.equal(r3.verdict, 'NEEDS_AUTHORITY');
    assert.equal(existsSync(join(fx.root, 'b')), false);
  } finally { fx.cleanup(); }
});

