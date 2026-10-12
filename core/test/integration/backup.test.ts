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

test('backup is encrypted at rest: canary absent from .billybak, present after verified restore; 0600/0700 modes', async () => {
  const fx = fixture();
  try {
    const canary = `CANARY-${randomBytes(8).toString('hex')}`;
    fx.tasks.create({ owner_id: 'owner', goal: `secret goal ${canary}`, project_scope: 'fx', grant_id: fx.grantId,
      success_criteria: { description: 'x', postconditions: [] } });
    const mgr = new BackupManager({ dataDir: join(fx.dir, 'data'), keys: new StaticKeyProvider(), store: fx.core.store });
    const m = await mgr.create('canary');
    const files = readdirSync(mgr.dir).sort();
    assert.deepEqual(files, [`${m.id}.billybak`, `${m.id}.manifest.json`].sort(), 'no plaintext temp left behind');
    const blob = readFileSync(join(mgr.dir, `${m.id}.billybak`));
    assert.equal(blob.includes(Buffer.from(canary)), false, 'canary must not appear in ciphertext');
    assert.equal(readFileSync(join(mgr.dir, `${m.id}.manifest.json`), 'utf8').includes(canary), false);
    assert.equal(statSync(join(mgr.dir, `${m.id}.billybak`)).mode & 0o777, 0o600);
    assert.equal(statSync(mgr.dir).mode & 0o777, 0o700);
    assert.equal(m.ciphertext_sha256, h(blob));
    assert.equal(m.schema_version, fx.core.store.schemaVersion());
    assert.equal(m.counts.tasks, 1);
    assert.deepEqual(mgr.verify(m.id), { ok: true, manifest: m });
    // Sanity: the restored plaintext DB really does contain the canary.
    const target = join(fx.dir, 'restored');
    mgr.restore(m.id, target);
    assert.ok(readFileSync(join(target, 'billy.db')).includes(Buffer.from(canary)));
    assert.equal(statSync(join(target, 'billy.db')).mode & 0o777, 0o600);
    // Wrong key and a flipped ciphertext byte both fail verification.
    const wrong = new BackupManager({ dataDir: join(fx.dir, 'data'), keys: new StaticKeyProvider() });
    assert.equal(wrong.verify(m.id).ok, false);
    blob[blob.length - 5] ^= 0xff;
    writeFileSync(join(mgr.dir, `${m.id}.billybak`), blob);
    const bad = mgr.verify(m.id);
    assert.equal(bad.ok, false);
  } finally { fx.cleanup(); }
});

test('list/prune keep the newest N backups', async () => {
  const fx = fixture();
  try {
    let t = Date.parse('2026-01-01T00:00:00Z');
    const mgr = new BackupManager({ dataDir: join(fx.dir, 'data'), keys: new StaticKeyProvider(), store: fx.core.store, clock: () => (t += 1000) });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await mgr.create(`n${i}`)).id);
    assert.deepEqual(mgr.list().map((m) => m.id), [...ids].reverse());
    assert.deepEqual(mgr.prune(2).sort(), ids.slice(0, 2).sort());
    assert.deepEqual(mgr.list().map((m) => m.id), [ids[3], ids[2]]);
    assert.equal(readdirSync(mgr.dir).length, 4);
  } finally { fx.cleanup(); }
});

test('T-REL-04: backup under WAL activity and mid-dispatch; separate restore keeps COMMITTED, recover() never re-dispatches', async () => {
  const g = gatedWrite();
  const fx = fixture({ extraTools: [g.tool] });
  try {
    const dataDir = join(fx.dir, 'data');
    const id = fx.task(); fx.run(id);
    const pA = fx.proposal(id, 'fs.write_gated', { path: join(fx.root, 'a.txt'), content: 'A', mode: 'create' }, 'a');
    const rA = await fx.core.broker.submit(pA);
    assert.equal(rA.verdict, 'COMMITTED', rA.reason);
    fx.core.outbox.enqueue('k1', 'test', 'owner', 'Done', 'body', id);

    // Second connection writes without checkpointing: rows live only in the WAL.
    const c2 = new DatabaseSync(join(dataDir, 'billy.db'), { timeout: 2000 });
    c2.exec('PRAGMA wal_autocheckpoint=0');
    for (let i = 0; i < 3; i++) addMemory(c2, `k${i}`, `wal-value-${i}`);
    c2.close();
    assert.ok(statSync(join(dataDir, 'billy.db-wal')).size > 0, 'WAL holds uncheckpointed frames');

    // Op B is mid-dispatch (DISPATCHING persisted) when the backup is taken.
    g.hold();
    const pB = fx.proposal(id, 'fs.write_gated', { path: join(fx.root, 'b.txt'), content: 'B', mode: 'create' }, 'b');
    const bDone = fx.core.broker.submit(pB);
    await until(() => (fx.core.store.db.prepare(`SELECT count(*) c FROM attempts WHERE status='DISPATCHING'`).get() as any).c === 1);
    const mgr = new BackupManager({ dataDir, keys: new StaticKeyProvider(), store: fx.core.store });
    const m = await mgr.create('t-rel-04');
    g.release();
    assert.equal((await bDone).verdict, 'COMMITTED'); // effect B lands after the backup point
    assert.equal(g.dispatches, 2);
    assert.deepEqual(m.counts, { tasks: 1, attempts: 2, memory: 3, outbox: 1 });

    // Restore refuses the live data dir (instance lock) and goes to a separate location.
    assert.throws(() => mgr.restore(m.id, dataDir), InstanceLockedError);
    const target = join(fx.dir, 'restored');
    mgr.restore(m.id, target);
    assert.throws(() => mgr.restore(m.id, target), RestoreRefusedError, 'never overwrites an existing DB');

    const core2 = new Core({ dir: target, allowUnsafeLocation: true, extraTools: [g.tool] });
    try {
      const db = core2.store.db;
      const n = (t: string) => (db.prepare(`SELECT count(*) c FROM ${t}`).get() as any).c;
      assert.deepEqual({ tasks: n('tasks'), attempts: n('attempts'), memory: n('memory'), outbox: n('outbox') }, m.counts);
      assert.deepEqual((db.prepare('SELECT value FROM memory ORDER BY key').all() as any[]).map((r) => r.value), ['wal-value-0', 'wal-value-1', 'wal-value-2']);
      assert.equal((db.prepare('PRAGMA quick_check').get() as any).quick_check, 'ok');

      const rep = postRestoreReport(core2.store);
      assert.equal(rep.committed, 1);
      assert.equal(rep.last_event_seq, m.last_event_seq);
      assert.equal(rep.restore?.backup_id, m.id);
      assert.deepEqual(rep.needs_reconciliation.map((r) => [r.attempt_id, r.status]), [[(await bDone).attempt_id, 'DISPATCHING']]);
      assert.equal(core2.store.attemptStatus(rA.attempt_id!), 'COMMITTED');

      // Reconciliation discovers the post-backup effect instead of replaying it.
      await core2.recover();
      assert.equal(g.dispatches, 2, 'recover() must not re-dispatch');
      assert.equal(core2.store.attemptStatus((await bDone).attempt_id!), 'COMMITTED');
      assert.equal(core2.store.attemptStatus(rA.attempt_id!), 'COMMITTED');

      // Resubmitting either operation on the restored core is deduplicated.
      core2.store.transitionTask(id, 'RUNNING');
      for (const p of [pA, pB]) {
        const r = await core2.broker.submit({ ...p, core_key: core2.broker.coreKey });
        assert.equal(r.verdict, 'DEDUPLICATED', r.reason);
      }
      assert.equal(g.dispatches, 2);
      assert.equal(n('attempts'), 2);
      assert.equal(readFileSync(join(fx.root, 'a.txt'), 'utf8'), 'A');
      assert.equal(readFileSync(join(fx.root, 'b.txt'), 'utf8'), 'B');
    } finally { core2.close(); }
  } finally { g.release(); fx.cleanup(); }
});

test('KeychainKeyProvider: creates only with allowCreate; reads back; uses fake runner (no real Keychain)', () => {
  const items = new Map<string, string>();
  const calls: string[][] = [];
  const run: SecurityRunner = (argv, stdin) => {
    calls.push(argv);
    const args = argv[0] === '-i' ? stdin!.trim().split(/\s+/) : argv; // interactive mode: command arrives on stdin
    const s = args[args.indexOf('-s') + 1];
    if (args[0] === 'find-generic-password') {
      return items.has(s) ? { status: 0, stdout: items.get(s)! + '\n', stderr: '' } : { status: 44, stdout: '', stderr: 'not found' };
    }
    if (args[0] === 'add-generic-password') { items.set(s, args[args.indexOf('-w') + 1]); return { status: 0, stdout: '', stderr: '' }; }
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };
  assert.throws(() => new KeychainKeyProvider({ run }).getKey(), KeyUnavailableError);
  assert.equal(calls.some((c) => c[0] === '-i'), false, 'no creation without allowCreate');
  const k1 = new KeychainKeyProvider({ run, allowCreate: true }).getKey();
  assert.equal(k1.length, 32);
  assert.ok(!calls.some((c) => c.includes(k1.toString('base64'))), 'the key never appears on argv');
  assert.deepEqual(calls.find((c) => c[0] === '-i'), ['-i'], 'creation goes through interactive mode with the command on stdin');
  assert.ok(items.has('com.billy.backup-key'));
  assert.deepEqual(new KeychainKeyProvider({ run }).getKey(), k1, 'existing key is reused, not regenerated');
  items.set('com.billy.backup-key', Buffer.alloc(8).toString('base64'));
  assert.throws(() => new KeychainKeyProvider({ run }).getKey(), KeyUnavailableError, 'wrong-length key rejected');
});

