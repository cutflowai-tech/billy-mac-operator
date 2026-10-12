import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../fixtures.ts';
import { FrozenCriteriaVerifier } from '../../src/verify/frozen.ts';

test('task completion criteria cannot read outside the effective grant, including a symlinked parent', async () => {
  const fx = fixture();
  try {
    const secret = join(fx.outside, 'secret'); writeFileSync(secret, 'private-canary');
    const link = join(fx.root, 'escape'); symlinkSync(fx.outside, link);
    const id = fx.task();
    const verifier = new FrozenCriteriaVerifier(fx.core.store);
    for (const path of [secret, join(link, 'secret')]) {
      for (const kind of ['file_sha256', 'file_contains', 'file_absent']) {
        fx.core.executor.seedPlan(id, 1, 'model', { frozen_criteria: [{ kind, path, sha256: '0'.repeat(64), text: 'private-canary' }] });
        const r = await verifier.verify(fx.core.tasks.get(id), []);
        assert.equal(r.ok, false);
        assert.match(JSON.stringify(r.evidence), /criterion outside current file authority/);
        assert.doesNotMatch(JSON.stringify(r.evidence), /"got":true|"got":"present"|"got":"[a-f0-9]{64}"/);
      }
    }
  } finally { fx.cleanup(); }
});

test('criteria obey grant revocation and narrowing while ordinary and absent nested paths still verify', async () => {
  const fx = fixture();
  try {
    const file = join(fx.root, 'result'); writeFileSync(file, 'done');
    const id = fx.task(); const verifier = new FrozenCriteriaVerifier(fx.core.store);
    fx.core.executor.seedPlan(id, 1, 'model', { frozen_criteria: [{ kind: 'file_contains', path: file, text: 'done' },
      { kind: 'file_absent', path: join(fx.root, 'missing', 'nested') }] });
    assert.equal((await verifier.verify(fx.core.tasks.get(id), [])).ok, true);
    const grant = fx.core.policy.current(fx.grantId)!;
    const narrow = join(fx.root, 'narrow'); mkdirSync(narrow);
    fx.core.policy.putGrant({ ...grant, scope: { ...grant.scope, file_roots: [narrow] } });
    assert.equal((await verifier.verify(fx.core.tasks.get(id), [])).ok, false);
    fx.core.policy.revoke(fx.grantId, 'owner revoked');
    assert.equal((await verifier.verify(fx.core.tasks.get(id), [])).ok, false);
  } finally { fx.cleanup(); }
});
