// T-DUR-10 (corruption -> quarantine -> verified restore, never a blank DB) and
// T-REL-05 (failed migration rolls back; newer schema refused by older code; the
// documented rollback path is: move newer DB aside, restore pre-upgrade backup, recover()).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, gatedWrite, until } from '../fixtures.ts';
import { Core } from '../../src/core.ts';
import { CompatibilityError, CorruptionError, Store } from '../../src/store/db.ts';
import { MIGRATIONS, type Migration } from '../../src/store/schema.ts';
import {
  BackupManager, StaticKeyProvider, openOrQuarantine, postRestoreReport, restoreLatestVerified,
} from '../../src/store/backup.ts';

const h = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Logical state used for before/after comparison. */
function logical(db: Store['db']) {
  const q = (sql: string) => db.prepare(sql).all().map((r) => ({ ...r }));
  return {
    tasks: q('SELECT task_id, status, revision FROM tasks ORDER BY task_id'),
    attempts: q('SELECT attempt_id, semantic_operation_id, status FROM attempts ORDER BY attempt_id'),
    outbox: q('SELECT dedup_key, status FROM outbox ORDER BY dedup_key'),
    last_event_seq: (db.prepare('SELECT max(seq) s FROM events').get() as any).s,
  };
}

/** Overwrite every page after the first with garbage: header stays valid, b-trees are destroyed. */
function corruptPages(path: string): void {
  const size = statSync(path).size;
  const fd = openSync(path, 'r+');
  try {
    for (let off = 4096; off < size; off += 4096) writeSync(fd, Buffer.alloc(Math.min(4096, size - off), 0xa5), 0, Math.min(4096, size - off), off);
  } finally { closeSync(fd); }
}

test('T-DUR-10: corruption stops dispatch, preserves damaged bytes, restores only from a verified backup', async () => {
  const fx = fixture();
  const dataDir = join(fx.dir, 'data');
  try {
    const keys = new StaticKeyProvider();
    const id = fx.task(); fx.run(id);
    const r = await fx.core.broker.submit(fx.proposal(id, 'fs.write', { path: join(fx.root, 'x.txt'), content: 'x', mode: 'create' }, 'x'));
    assert.equal(r.verdict, 'COMMITTED');
    fx.core.outbox.enqueue('k1', 'test', 'owner', 'Done', 'body', id);
    const mgr = new BackupManager({ dataDir, keys, store: fx.core.store });
    const good = await mgr.create('good');
    const expected = logical(fx.core.store.db);
    await sleep(5);
    fx.task(); // newer state, captured only in the (to-be-tampered) newest backup
    const newest = await mgr.create('newest');
    const nb = join(mgr.dir, `${newest.id}.billybak`);
    const blob = readFileSync(nb); blob[blob.length - 1] ^= 0xff;
    const fd = openSync(nb, 'r+'); writeSync(fd, blob); closeSync(fd);
    fx.core.close(); // checkpoints WAL into billy.db

    const dbPath = join(dataDir, 'billy.db');
    corruptPages(dbPath);
    const damaged = readFileSync(dbPath);
    const damagedSha = h(damaged);

    // Dispatch stops: neither the store nor a Core comes up on corrupt state.
    assert.throws(() => Store.open({ dir: dataDir, allowUnsafeLocation: true }), CorruptionError);
    assert.throws(() => new Core({ dir: dataDir, allowUnsafeLocation: true }), CorruptionError);

    const q = openOrQuarantine(dataDir, { allowUnsafeLocation: true });
    assert.equal(q.status, 'CORRUPT');
    if (q.status !== 'CORRUPT') return;
    assert.match(q.incident.error, /integrity check/);
    assert.equal(existsSync(dbPath), false, 'damaged DB moved out of place');
    assert.equal(h(readFileSync(join(q.incident.quarantine_dir, 'billy.db'))), damagedSha, 'damaged bytes preserved');
    assert.deepEqual(q.incident.files.find((f) => f.name === 'billy.db'), { name: 'billy.db', bytes: damaged.length, sha256: damagedSha });
    assert.ok(existsSync(join(q.incident.quarantine_dir, 'incident.json')));
    // Re-invoking stays stopped and still creates no database.
    assert.equal(openOrQuarantine(dataDir, { allowUnsafeLocation: true }).status, 'CORRUPT');
    assert.equal(existsSync(dbPath), false, 'no blank DB initialized');

    // No verifiable backup (wrong key) -> nothing restored, still no DB.
    const none = restoreLatestVerified(dataDir, new BackupManager({ dataDir, keys: new StaticKeyProvider() }));
    assert.equal(none.status, 'NO_VERIFIED_BACKUP');
    assert.equal(existsSync(dbPath), false);

    const rec = restoreLatestVerified(dataDir, new BackupManager({ dataDir, keys }));
    assert.equal(rec.status, 'RESTORED');
    if (rec.status !== 'RESTORED') return;
    assert.equal(rec.backup_id, good.id, 'tampered newest backup skipped');
    assert.deepEqual(rec.skipped.map((s) => s.id), [newest.id]);
    assert.equal(rec.incident_id, q.incident.incident_id);
    const resolved = JSON.parse(readFileSync(join(q.incident.quarantine_dir, 'incident.json'), 'utf8'));
    assert.equal(resolved.restored_from_backup, good.id);

    const opened = openOrQuarantine(dataDir, { allowUnsafeLocation: true });
    assert.equal(opened.status, 'OK');
    if (opened.status !== 'OK') return;
    try {
      assert.deepEqual(logical(opened.store.db), expected, 'restored logical state equals backup point');
      assert.equal(postRestoreReport(opened.store).restore?.backup_id, good.id);
    } finally { opened.store.close(); }
    // Damaged evidence still intact after recovery.
    assert.equal(h(readFileSync(join(q.incident.quarantine_dir, 'billy.db'))), damagedSha);
  } finally { fx.cleanup(); }
});

const FAILING_V99: Migration = {
  version: 99, name: 'test-upgrade-fails-halfway',
  sql: `CREATE TABLE upgrade_probe (x INTEGER); INSERT INTO upgrade_probe VALUES (1);
        UPDATE tasks SET locale='upgraded'; INSERT INTO no_such_table VALUES (1);`,
};
const NEXT = Math.max(...MIGRATIONS.map((m) => m.version)) + 1;
const GOOD_V2: Migration = {
  version: NEXT, name: 'test-upgrade-next',
  sql: `ALTER TABLE tasks ADD COLUMN upgrade_note TEXT; CREATE TABLE upgrade_journal (at TEXT NOT NULL);`,
};

test('T-REL-05: failed migration rolls back; newer schema refused; rollback = restore pre-upgrade backup + recover()', async () => {
  const g = gatedWrite();
  const fx = fixture({ extraTools: [g.tool] });
  const dataDir = join(fx.dir, 'data');
  try {
    const keys = new StaticKeyProvider();
    const id = fx.task(); fx.run(id);
    const pA = fx.proposal(id, 'fs.write_gated', { path: join(fx.root, 'a.txt'), content: 'A', mode: 'create' }, 'a');
    assert.equal((await fx.core.broker.submit(pA)).verdict, 'COMMITTED');
    // Pre-upgrade backup taken while op B is mid-dispatch; B lands after the backup point.
    g.hold();
    const pB = fx.proposal(id, 'fs.write_gated', { path: join(fx.root, 'b.txt'), content: 'B', mode: 'create' }, 'b');
    const bDone = fx.core.broker.submit(pB);
    await until(() => (fx.core.store.db.prepare(`SELECT count(*) c FROM attempts WHERE status='DISPATCHING'`).get() as any).c === 1);
    const mgr = new BackupManager({ dataDir, keys, store: fx.core.store });
    const pre = await mgr.create('pre-upgrade');
    assert.equal(mgr.verify(pre.id).ok, true);
    g.release();
    const rB = await bDone;
    assert.equal(rB.verdict, 'COMMITTED');
    const before = logical(fx.core.store.db);
    fx.core.close();

    // 1. Upgrade with a migration that fails halfway: transaction rolls back to v1.
    assert.throws(() => Store.open({ dir: dataDir, allowUnsafeLocation: true, migrations: [...MIGRATIONS, FAILING_V99] }), /no such table/);
    const old = Store.open({ dir: dataDir, allowUnsafeLocation: true });
    try {
      assert.equal(old.schemaVersion(), NEXT - 1);
      assert.equal(old.db.prepare(`SELECT name FROM sqlite_master WHERE name='upgrade_probe'`).get(), undefined);
      assert.equal((old.db.prepare(`SELECT count(*) c FROM tasks WHERE locale='upgraded'`).get() as any).c, 0);
      assert.deepEqual(logical(old.db), before, 'old code opens the untouched v1 database');
    } finally { old.close(); }

    // 2. A successful upgrade to v2, then more work under the new build.
    const v2 = new Core({ dir: dataDir, allowUnsafeLocation: true, extraTools: [g.tool], migrations: [...MIGRATIONS, GOOD_V2] });
    assert.equal(v2.store.schemaVersion(), NEXT);
    v2.store.db.prepare(`INSERT INTO upgrade_journal VALUES (?)`).run(v2.store.now());
    const v2Backup = await new BackupManager({ dataDir, keys, store: v2.store }).create('post-upgrade');
    v2.close();

    // 3. Older code refuses the newer DB, and refuses to restore a newer-schema backup.
    assert.throws(() => Store.open({ dir: dataDir, allowUnsafeLocation: true }), CompatibilityError);
    assert.throws(() => new BackupManager({ dataDir, keys }).restore(v2Backup.id, join(fx.dir, 'never')), CompatibilityError);
    assert.equal(existsSync(join(fx.dir, 'never', 'billy.db')), false);

    // 4. Documented rollback: move the newer DB aside (preserved), restore pre-upgrade backup, recover().
    const aside = join(dataDir, 'rolled-back', 'v2');
    mkdirSync(aside, { recursive: true });
    for (const f of readdirSync(dataDir).filter((f) => f.startsWith('billy.db'))) renameSync(join(dataDir, f), join(aside, f));
    new BackupManager({ dataDir, keys }).restore(pre.id, dataDir);
    const rolled = new Core({ dir: dataDir, allowUnsafeLocation: true, extraTools: [g.tool] });
    try {
      assert.equal(rolled.store.schemaVersion(), NEXT - 1);
      const rep = postRestoreReport(rolled.store);
      assert.equal(rep.restore?.backup_id, pre.id);
      assert.deepEqual(rep.needs_reconciliation.map((r) => [r.attempt_id, r.status]), [[rB.attempt_id, 'DISPATCHING']]);
      await rolled.recover();
      assert.equal(g.dispatches, 2, 'post-backup effect reconciled, not replayed');
      assert.equal(rolled.store.attemptStatus(rB.attempt_id!), 'COMMITTED');
      rolled.store.transitionTask(id, 'RUNNING');
      assert.equal((await rolled.broker.submit({ ...pB, core_key: rolled.broker.coreKey })).verdict, 'DEDUPLICATED');
      assert.equal(g.dispatches, 2);
      assert.equal(readFileSync(join(fx.root, 'b.txt'), 'utf8'), 'B');
    } finally { rolled.close(); }
    // The newer DB is preserved for inspection, still openable by the newer build.
    const keep = Store.open({ dir: aside, allowUnsafeLocation: true, migrations: [...MIGRATIONS, GOOD_V2] });
    try { assert.equal(keep.schemaVersion(), NEXT); } finally { keep.close(); }
  } finally { g.release(); fx.cleanup(); }
});

test('T-DUR-10 (gap closure): after quarantine, a plain Store.open refuses to create a blank database', async () => {
  const { tempDir } = await import('../helpers.ts');
  const { Store, CorruptionError } = await import('../../src/store/db.ts');
  const { writeFileSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const t = tempDir();
  try {
    writeFileSync(join(t.dir, 'RECOVERY_REQUIRED.json'), '{}');
    assert.throws(() => Store.open({ dir: t.dir, allowUnsafeLocation: true }), CorruptionError);
    assert.equal(existsSync(join(t.dir, 'billy.db')), false);
  } finally { t.cleanup(); }
});
