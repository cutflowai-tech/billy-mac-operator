import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store, InstanceLockedError, UnsafeLocationError } from '../../src/store/db.ts';
import { openTempStore, tempDir } from '../helpers.ts';

function insertTask(s: Store, id: string, status = 'RECEIVED') {
  s.tx(() => s.db.prepare(`INSERT INTO tasks(task_id, owner_id, project_scope, revision, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?)`).run(id, 'owner', 'p', 1, status, s.now(), s.now()));
}

test('pragmas are durable-by-default and recorded', () => {
  const { store, cleanup } = openTempStore();
  try {
    const p = store.pragmas();
    assert.equal(p.journal_mode, 'wal');
    assert.equal(p.synchronous, 2); // FULL
    assert.equal(p.foreign_keys, 1);
    assert.equal(store.schemaVersion(), 3);
  } finally { cleanup(); }
});

test('second instance on the same data dir is refused', () => {
  const { store, dir, cleanup } = openTempStore();
  try {
    assert.throws(() => Store.open({ dir: join(dir, 'data'), allowUnsafeLocation: true }), InstanceLockedError);
  } finally { cleanup(); }
  void store;
});

test('live DB under an external volume or cloud folder is refused', () => {
  assert.throws(() => Store.open({ dir: '/Volumes/Zeno/Billy/should-not-exist-db' }), UnsafeLocationError);
});

test('illegal task transition fails and leaves state unchanged', () => {
  const { store, cleanup } = openTempStore();
  try {
    insertTask(store, 't1');
    assert.throws(() => store.transitionTask('t1', 'COMPLETED'));
    assert.equal(store.taskStatus('t1'), 'RECEIVED');
    store.transitionTask('t1', 'PLANNING');
    assert.equal(store.taskStatus('t1'), 'PLANNING');
    const ev = store.db.prepare(`SELECT count(*) c FROM events WHERE entity_id='t1'`).get() as any;
    assert.equal(ev.c, 1);
  } finally { cleanup(); }
});

test('cycle-free edge constraints: self edge rejected by DB', () => {
  const { store, cleanup } = openTempStore();
  try {
    insertTask(store, 'a');
    assert.throws(() => store.db.prepare(`INSERT INTO task_edges VALUES ('a','a','child')`).run());
  } finally { cleanup(); }
});

test('only one live attempt per semantic operation', () => {
  const { store, cleanup } = openTempStore();
  try {
    insertTask(store, 't');
    const ins = (aid: string, n: number, status: string) => store.db.prepare(`INSERT INTO attempts(attempt_id, action_id,
      semantic_operation_id, attempt_no, task_id, task_revision, cancellation_generation, actor_id, tool_id, tool_version,
      effect_class, target_json, arguments_digest, arguments_json, envelope_json, status, created_at, updated_at)
      VALUES (?,?,?,?,?,1,0,'w','fs.write',1,'IDEMPOTENT_WRITE','{}','d','{}','{}',?,?,?)`)
      .run(aid, 'act', 'sem', n, 't', status, store.now(), store.now());
    ins('a1', 1, 'PREPARED');
    assert.throws(() => ins('a2', 2, 'PROPOSED'));
    store.db.prepare(`UPDATE attempts SET status='RETRY_ELIGIBLE' WHERE attempt_id='a1'`).run();
    ins('a2', 2, 'PROPOSED');
  } finally { cleanup(); }
});

test('backup is consistent with WAL activity and verified', async () => {
  const { store, dir, cleanup } = openTempStore();
  try {
    for (let i = 0; i < 50; i++) insertTask(store, `t${i}`);
    const b = await store.backupTo(join(dir, 'backup.db'));
    assert.equal(b.schema, 3);
    const t = tempDir();
    try {
      const { copyFileSync } = await import('node:fs');
      copyFileSync(b.path, join(t.dir, 'billy.db'));
      const restored = Store.open({ dir: t.dir, allowUnsafeLocation: true });
      const c = restored.db.prepare('SELECT count(*) c FROM tasks').get() as any;
      assert.equal(c.c, 50);
      restored.close();
    } finally { t.cleanup(); }
  } finally { cleanup(); }
});
