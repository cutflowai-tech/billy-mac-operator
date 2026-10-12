// Moved from backup.test.ts into the lane that matches the scenario's kind (handoff §19.1); assertions unchanged.
// Encrypted backup, verified restore into a separate location (T-REL-04), Keychain
// key provider logic (fake `security` runner only), and update artifact admission (T-SEC-10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fixture, gatedWrite, until } from '../fixtures.ts';
import { tempDir } from '../helpers.ts';
import { Core } from '../../src/core.ts';
import { InstanceLockedError } from '../../src/store/db.ts';
import {
  BackupManager, KeychainKeyProvider, KeyUnavailableError, RestoreRefusedError, StaticKeyProvider, postRestoreReport,
  type SecurityRunner,
} from '../../src/store/backup.ts';
import { admitUpdate, verifyArtifact } from '../../src/update/verify.ts';

const h = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');

function addMemory(db: DatabaseSync, key: string, value: string): void {
  db.prepare(`INSERT INTO memory(memory_id, project_scope, kind, key, value, trust, provenance_json, confidence, created_at)
    VALUES (?, 'fx', 'fact', ?, ?, 'owner', '{}', 1, ?)`).run(crypto.randomUUID(), key, value, new Date().toISOString());
}

test('T-SEC-10: tampered update artifact is rejected and the existing installation is preserved', () => {
  const t = tempDir('billy-update-');
  try {
    const install = join(t.dir, 'install');
    mkdirSync(install);
    writeFileSync(join(install, 'billy-core.bin'), 'v1 working build');
    writeFileSync(join(install, 'config.json'), '{"keep":true}');
    const snapshot = () => readdirSync(install).sort().map((f) => [f, h(readFileSync(join(install, f)))]);
    const before = snapshot();

    const good = Buffer.from('v2 build '.repeat(1000));
    const pinned = h(good);
    const candidate = join(t.dir, 'download', 'billy-core.bin');
    mkdirSync(dirname(candidate));
    const tampered = Buffer.from(good); tampered[1234] ^= 0x01;
    writeFileSync(candidate, tampered);

    const check = verifyArtifact(candidate, pinned);
    assert.equal(check.ok, false);
    assert.equal(!check.ok && check.reason, 'mismatch');
    const res = admitUpdate(candidate, { version: '0.2.0', sha256: pinned }, install);
    assert.equal(res.admitted, false);
    assert.equal(!res.admitted && res.report.reason, 'mismatch');
    assert.equal(!res.admitted && res.report.actual, h(tampered));
    assert.deepEqual(snapshot(), before, 'install dir byte-identical');
    assert.deepEqual(readdirSync(t.dir).filter((f) => f.includes('staging')), [], 'no staging residue');

    // Team ID pinning: right bytes, wrong signer -> rejected.
    writeFileSync(candidate, good);
    const team = admitUpdate(candidate, { version: '0.2.0', sha256: pinned, teamId: 'ABCDE12345' }, install, { readTeamId: () => 'ZZZZZ99999' });
    assert.equal(!team.admitted && team.report.reason, 'team_mismatch');
    assert.deepEqual(snapshot(), before);
    assert.equal(verifyArtifact(join(t.dir, 'nope'), pinned).ok, false);

    // Control: the untampered artifact is admitted.
    const ok = admitUpdate(candidate, { version: '0.2.0', sha256: pinned, teamId: 'ABCDE12345' }, install, { readTeamId: () => 'ABCDE12345' });
    assert.equal(ok.admitted, true);
    assert.equal(h(readFileSync(join(install, 'billy-core.bin'))), pinned);
    assert.ok(existsSync(join(install, 'config.json')));
  } finally { t.cleanup(); }
});
