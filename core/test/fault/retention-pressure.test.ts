// Moved from memory.test.ts into the lane that matches the scenario's kind (handoff §19.1); assertions unchanged.
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

test('T-MEM-06: retention sweep and storage pressure delete only eligible owned evidence', () => {
  const t = tempDir();
  const s = openAt(t.dir);
  try {
    const evDir = join(t.dir, 'evidence'); mkdirSync(evDir);
    const outside = join(t.dir, 'user-files'); mkdirSync(outside);
    const r = new Retention(s, evDir);
    const file = (dir: string, name: string, body = name) => { const p = join(dir, name); writeFileSync(p, body); return p; };
    // Protected: user files outside the evidence dir, an untracked file inside it, and the DB.
    const protectedFiles = [file(outside, 'precious.txt'), file(outside, 'linked-target.txt'), file(evDir, 'untracked.png'),
      join(t.dir, 'data', 'billy.db')];
    const hashes = () => protectedFiles.slice(0, 3).map((p) => sha(readFileSync(p)));
    const before = hashes();
    const past = '2026-01-01T00:00:00.000Z', future = '2099-01-01T00:00:00.000Z';
    const expiredRaw = r.track({ kind: 'screenshot', source: 'capture', location: file(evDir, 'old-raw.png'), sanitized: false, retain_until: past, captured_at: '2026-01-01T00:00:00.000Z' });
    const fresh = r.track({ kind: 'screenshot', source: 'capture', location: file(evDir, 'fresh-sanitized.png'), sanitized: true, retain_until: future });
    const escape = r.track({ kind: 'screenshot', source: 'forged', location: protectedFiles[0], sanitized: false, retain_until: past });
    const traversal = r.track({ kind: 'screenshot', source: 'forged', location: join(evDir, '..', 'user-files', 'precious.txt'), sanitized: false, retain_until: past });
    symlinkSync(protectedFiles[1], join(evDir, 'link.png'));
    const link = r.track({ kind: 'screenshot', source: 'forged', location: join(evDir, 'link.png'), sanitized: false, retain_until: past });
    const dbRow = r.track({ kind: 'journal', source: 'forged', location: protectedFiles[3], sanitized: false, retain_until: past });

    const swept = r.sweep(new Date('2026-10-11T00:00:00.000Z'));
    assert.deepEqual(swept.deleted, [expiredRaw]);
    assert.deepEqual(new Set(swept.refused.map((x) => x.evidence_id)), new Set([escape, traversal, link, dbRow]));
    assert.equal(existsSync(join(evDir, 'old-raw.png')), false);
    assert.ok(existsSync(join(evDir, 'fresh-sanitized.png')));
    assert.ok(existsSync(join(evDir, 'link.png')), 'symlink itself is refused, not followed or removed');
    assert.deepEqual(hashes(), before);

    // Storage pressure: three raw captures (not yet expired) plus sanitized evidence.
    const raws = [1, 2, 3].map((i) => r.track({ kind: 'screenshot', source: 'capture', location: file(evDir, `raw-${i}.png`),
      sanitized: false, retain_until: future, captured_at: `2026-10-0${i}T00:00:00.000Z` }));
    let free = 100;
    const freeBytes = () => free + 50 * (3 - raws.filter((_, i) => existsSync(join(evDir, `raw-${i + 1}.png`))).length);
    const p = r.relievePressure(180, freeBytes);
    assert.ok(p.relieved);
    assert.deepEqual(p.deleted, [raws[0], raws[1]], 'oldest raw first, stop once above threshold');
    assert.ok(existsSync(join(evDir, 'raw-3.png')));
    assert.ok(existsSync(join(evDir, 'fresh-sanitized.png')), 'sanitized evidence never removed under pressure');
    // Unrelievable pressure: alert, never touches the DB or protected files.
    const p2 = r.relievePressure(10_000, () => 1);
    assert.equal(p2.relieved, false);
    assert.ok(existsSync(join(evDir, 'fresh-sanitized.png')));
    assert.deepEqual(p2.deleted, [raws[2]]);
    assert.deepEqual(hashes(), before);
    assert.ok(existsSync(protectedFiles[3]));
    assert.equal((s.db.prepare('PRAGMA quick_check').get() as any).quick_check, 'ok', 'journal DB intact');
    const kinds = (s.db.prepare(`SELECT kind FROM events WHERE domain='retention'`).all() as any[]).map((e) => e.kind);
    for (const k of ['alert', 'relieved', 'unresolved', 'refused', 'deleted', 'completed']) assert.ok(kinds.includes(k), k);
    const st = s.db.prepare('SELECT evidence_id, deleted_at FROM evidence').all() as any[];
    const gone = new Set(st.filter((x) => x.deleted_at).map((x) => x.evidence_id));
    assert.deepEqual(gone, new Set([expiredRaw, ...raws]));
  } finally { s.close(); t.cleanup(); }
});
