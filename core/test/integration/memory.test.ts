import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../src/store/db.ts';
import {
  BACKUP_RESIDUAL_NOTE, MEMORY_DATA_NOT_AUTHORITY, Memory, MemoryError, SEARCH_MAX, ownerAuth, type RecordInput,
} from '../../src/memory/memory.ts';
import { Retention } from '../../src/memory/retention.ts';
import { tempDir } from '../helpers.ts';
import { fixture } from '../fixtures.ts';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const at = '2026-10-01T00:00:00.000Z';
const owner = ownerAuth('test-owner:cli');

function openAt(dir: string): Store { return Store.open({ dir: join(dir, 'data'), allowUnsafeLocation: true }); }

function decision(scope: string, key: string, value: string): RecordInput {
  return { project_scope: scope, kind: 'decision', key, value, trust: 'owner', confidence: 1,
    provenance: { source_kind: 'owner_command', source_ref: 'telegram:msg-17', captured_at: at } };
}

test('T-MEM-01: owner decision persists across restart with provenance, distinct from execution state', () => {
  const t = tempDir();
  try {
    let s = openAt(t.dir);
    const id = new Memory(s).record(decision('proj-a', 'deploy.target', 'staging only'), owner);
    s.close();
    s = openAt(t.dir);
    try {
      const m = new Memory(s);
      const cur = m.current('proj-a', 'deploy.target');
      assert.ok(cur);
      assert.equal(cur.memory_id, id);
      assert.equal(cur.value, 'staging only');
      assert.equal(cur.trust, 'owner');
      assert.deepEqual(cur.provenance, { source_kind: 'owner_command', source_ref: 'telegram:msg-17', captured_at: at });
      assert.equal(m.current('proj-b', 'deploy.target'), null);
      // Execution state lives in tasks/attempts; recording memory touched neither.
      assert.equal((s.db.prepare('SELECT count(*) c FROM tasks').get() as any).c, 0);
      assert.equal((s.db.prepare('SELECT count(*) c FROM attempts').get() as any).c, 0);
      const ctx = m.contextFor('proj-a', 'deploy target', 2000);
      assert.match(ctx, /trust=owner/);
      assert.match(ctx, /source=owner_command:"telegram:msg-17"/);
      assert.ok(ctx.includes(MEMORY_DATA_NOT_AUTHORITY));
    } finally { s.close(); }
  } finally { t.cleanup(); }
});

test('T-MEM-01b: trust rules — owner needs a real token; inferred stays inferred; web is untrusted', () => {
  const t = tempDir();
  const s = openAt(t.dir);
  try {
    const m = new Memory(s);
    assert.throws(() => m.record(decision('p', 'k', 'v')), MemoryError);
    const forged = Object.freeze({ source: 'test-owner:cli', issued_at: at });
    assert.throws(() => m.record(decision('p', 'k', 'v'), forged), MemoryError);
    const base = { project_scope: 'p', kind: 'fact' as const, key: 'k', value: 'v', confidence: 0.5 };
    assert.throws(() => m.record({ ...base, trust: 'verified', provenance: { source_kind: 'model_inference', source_ref: 'm', captured_at: at } }), MemoryError);
    assert.throws(() => m.record({ ...base, trust: 'owner', provenance: { source_kind: 'web', source_ref: 'https://x', captured_at: at } }, owner), MemoryError);
    assert.throws(() => m.record({ ...base, trust: 'owner', provenance: { source_kind: 'worker', source_ref: 'w1', captured_at: at } }, owner), MemoryError);
    const inf = m.record({ ...base, trust: 'inferred', provenance: { source_kind: 'model_inference', source_ref: 'plan-3', captured_at: at } });
    assert.equal(m.get(inf)!.trust, 'inferred');
    assert.match(m.contextFor('p', 'v', 1000), /inferred, unverified/);
  } finally { s.close(); t.cleanup(); }
});

test('T-MEM-02: owner correction supersedes the old value, including after restart', () => {
  const t = tempDir();
  try {
    let s = openAt(t.dir);
    let m = new Memory(s);
    const oldId = m.record(decision('proj-a', 'report.language', 'English reports'), owner);
    // A later untrusted write does not displace the owner decision.
    m.record({ project_scope: 'proj-a', kind: 'external', key: 'report.language', value: 'French reports', trust: 'untrusted',
      confidence: 0.9, provenance: { source_kind: 'web', source_ref: 'https://example.invalid', captured_at: at } });
    assert.equal(m.current('proj-a', 'report.language')!.value, 'English reports');
    const newId = m.correct({ project_scope: 'proj-a', key: 'report.language' }, 'Arabic reports', owner);
    assert.throws(() => m.correct({ memory_id: oldId }, 'x', Object.freeze({ source: 'x', issued_at: at }) as any), MemoryError);
    s.close();
    s = openAt(t.dir);
    try {
      m = new Memory(s);
      const cur = m.current('proj-a', 'report.language')!;
      assert.equal(cur.memory_id, newId);
      assert.equal(cur.value, 'Arabic reports');
      assert.equal(cur.provenance.source_kind, 'owner_command');
      const old = s.db.prepare('SELECT superseded_by, value FROM memory WHERE memory_id=?').get(oldId) as any;
      assert.equal(old.superseded_by, newId, 'old record kept for provenance, linked to its successor');
      assert.equal(m.search('proj-a', 'English').length, 0, 'superseded value is never returned as current');
      assert.ok(m.search('proj-a', 'Arabic').some((r) => r.memory_id === newId));
      // A fixture "task" consumes the current value.
      const plan = `write report in ${m.current('proj-a', 'report.language')!.value}`;
      assert.equal(plan, 'write report in Arabic reports');
      assert.throws(() => m.correct({ memory_id: oldId }, 'again', owner), MemoryError);
    } finally { s.close(); }
  } finally { t.cleanup(); }
});

test('memory search works with Arabic text', () => {
  const t = tempDir();
  const s = openAt(t.dir);
  try {
    const m = new Memory(s);
    m.record(decision('proj-ar', 'لغة.التقارير', 'التقارير الأسبوعية باللغة العربية'), owner);
    m.record(decision('proj-ar', 'other', 'weekly reports in English'), owner);
    const r = m.search('proj-ar', 'الأسبوعية');
    assert.equal(r.length, 1);
    assert.equal(r[0].value, 'التقارير الأسبوعية باللغة العربية');
    assert.equal(m.search('proj-ar', 'التقارير العربية').length, 1);
    assert.equal(m.search('other-scope', 'الأسبوعية').length, 0);
    assert.match(m.contextFor('proj-ar', 'العربية', 1000), /التقارير الأسبوعية/);
  } finally { s.close(); t.cleanup(); }
});

test('T-MEM-04b: policy engine and broker have no import of the memory module', () => {
  const src = join(import.meta.dirname, '..', '..', 'src');
  for (const dir of ['policy', 'broker']) {
    for (const f of readdirSync(join(src, dir))) {
      const text = readFileSync(join(src, dir, f), 'utf8');
      const imports = text.match(/^\s*import[^;]*;/gm) ?? [];
      assert.ok(!imports.some((i) => /memory/i.test(i)), `${dir}/${f} imports memory`);
      assert.ok(!/import\(\s*['"][^'"]*memory/i.test(text), `${dir}/${f} dynamically imports memory`);
    }
  }
});

test('T-MEM-05: deletion removes active value and FTS row, leaves a tombstone; backup residual disclosed', async () => {
  const t = tempDir();
  const s = openAt(t.dir);
  try {
    const m = new Memory(s);
    const canary = 'BILLY_CANARY_deleteMe0042';
    const id1 = m.record(decision('proj-a', 'secret.plan', `first ${canary}`), owner);
    const id2 = m.correct({ memory_id: id1 }, `second ${canary}`, owner);
    const keep = m.record(decision('proj-a', 'keep', 'unrelated keeper'), owner);
    const backup = join(t.dir, 'backup.db');
    await s.backupTo(backup);
    m.checkpoint();
    const dbPath = join(t.dir, 'data', 'billy.db');
    assert.ok(readFileSync(dbPath).includes(Buffer.from(canary)), 'precondition: content is in the live file');
    assert.throws(() => m.delete(id2, { source: 'x', issued_at: at } as any, 'owner request'), MemoryError);
    const receipt = m.delete(id2, owner, 'owner request');
    m.checkpoint();
    assert.deepEqual(new Set(receipt.removed), new Set([id1, id2]));
    assert.equal(receipt.backup_residual, BACKUP_RESIDUAL_NOTE);
    assert.equal(m.current('proj-a', 'secret.plan'), null);
    assert.equal(m.get(id2), null);
    assert.equal(m.search('proj-a', canary).length, 0);
    assert.equal(m.search('proj-a', 'second').length, 0);
    // Direct FTS scan: no row and no match for deleted content.
    assert.equal((s.db.prepare('SELECT count(*) c FROM memory_fts WHERE memory_id IN (?,?)').get(id1, id2) as any).c, 0);
    assert.equal((s.db.prepare(`SELECT count(*) c FROM memory_fts WHERE memory_fts MATCH ?`).get(`"${canary}"`) as any).c, 0);
    const rows = s.db.prepare('SELECT value, key, provenance_json, deleted_at FROM memory WHERE memory_id IN (?,?)').all(id1, id2) as any[];
    for (const r of rows) { assert.equal(r.value, ''); assert.equal(r.key, ''); assert.equal(r.provenance_json, '{}'); assert.ok(r.deleted_at); }
    const tomb = s.db.prepare('SELECT * FROM memory_tombstones WHERE memory_id=?').get(id2) as any;
    assert.deepEqual(Object.keys(tomb).sort(), ['deleted_at', 'memory_id', 'reason']);
    assert.ok(!JSON.stringify(s.db.prepare('SELECT * FROM memory_tombstones').all()).includes(canary));
    assert.ok(!JSON.stringify(s.db.prepare(`SELECT payload_json FROM events WHERE domain='memory'`).all()).includes(canary));
    assert.ok(!m.export('proj-a').includes('first'));
    assert.equal(m.current('proj-a', 'keep')!.memory_id, keep);
    // Live database file (after checkpoint) no longer contains the deleted content.
    for (const f of [dbPath, `${dbPath}-wal`]) {
      if (existsSync(f)) assert.equal(readFileSync(f).includes(Buffer.from(canary)), false, `deleted content lingers in ${f}`);
    }
    // Backup residual is real and disclosed: the pre-deletion backup still holds it until it expires.
    const b = new DatabaseSync(backup, { readOnly: true });
    try {
      assert.equal((b.prepare('SELECT count(*) c FROM memory WHERE memory_id=? AND value LIKE ?').get(id2, `%${canary}%`) as any).c, 1);
    } finally { b.close(); }
    assert.match(BACKUP_RESIDUAL_NOTE, /backup/i);
    assert.match(BACKUP_RESIDUAL_NOTE, /expire/i);
  } finally { s.close(); t.cleanup(); }
});

