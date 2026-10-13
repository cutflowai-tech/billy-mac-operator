// Symlink swaps between resolution and dispatch must never link, copy or expose a
// file from outside the grant (link() and copyfile() follow symlinks).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, openSync, writeSync, closeSync, fstatSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fsCopy, fsMove, fsWrite, publishInode } from '../../src/tools/fs.ts';

function dirs() {
  const base = mkdtempSync(join(tmpdir(), 'billy-race-'));
  const root = join(base, 'root'), outside = join(base, 'outside');
  mkdirSync(root); mkdirSync(outside);
  const secret = join(outside, 'secret.txt');
  writeFileSync(secret, 'outside secret');
  return { base, root, outside, secret, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
const ctx = (id: string) => ({ attemptId: id, services: {} }) as any;

test('fs.move refuses a source swapped for a symlink after resolution (no hardlink to an outside file)', async () => {
  const d = dirs();
  try {
    const src = join(d.root, 'a.txt'), dst = join(d.root, 'b.txt');
    writeFileSync(src, 'mine');
    const a = { from: src, to: dst };
    const r = fsMove.resolve!(a, ctx('m1')) as any;
    assert.equal(fsMove.preconditions!(a, r, ctx('m1')).ok, true);
    unlinkSync(src); symlinkSync(d.secret, src);           // the swap
    const out = await fsMove.dispatch(a, r, ctx('m1'));
    assert.notEqual(out.outcome, 'success');
    assert.equal(existsSync(dst), false, 'no workspace name refers to the outside inode');
    assert.equal(statSync(d.secret).nlink, 1, 'outside file gained no hard link');
    assert.equal(readFileSync(d.secret, 'utf8'), 'outside secret');
  } finally { d.cleanup(); }
});

test('fs.move still moves a regular file and preserves its inode', async () => {
  const d = dirs();
  try {
    const src = join(d.root, 'a.txt'), dst = join(d.root, 'b.txt');
    writeFileSync(src, 'mine');
    const ino = lstatSync(src).ino;
    const a = { from: src, to: dst };
    const r = fsMove.resolve!(a, ctx('m2')) as any;
    const out = await fsMove.dispatch(a, r, ctx('m2'));
    assert.equal(out.outcome, 'success');
    assert.equal(existsSync(src), false);
    assert.equal(lstatSync(dst).ino, ino);
  } finally { d.cleanup(); }
});

test('fs.copy refuses a source swapped for a symlink after resolution', async () => {
  const d = dirs();
  try {
    const src = join(d.root, 'a.txt'), dst = join(d.root, 'copy.txt');
    writeFileSync(src, 'outside secret');                   // same bytes as the secret, so the digest check alone cannot catch it
    const a = { from: src, to: dst };
    const r = fsCopy.resolve!(a, ctx('c1')) as any;
    unlinkSync(src); symlinkSync(d.secret, src);
    const out = await fsCopy.dispatch(a, r, ctx('c1'));
    assert.equal(out.outcome, 'failure');
    assert.equal(existsSync(dst), false);
    assert.equal(statSync(d.secret).nlink, 1);
  } finally { d.cleanup(); }
});

test('fs.copy copies a regular file into a new inode without following links', async () => {
  const d = dirs();
  try {
    const src = join(d.root, 'a.txt'), dst = join(d.root, 'copy.txt');
    writeFileSync(src, 'hello');
    const a = { from: src, to: dst };
    const r = fsCopy.resolve!(a, ctx('c2')) as any;
    const out = await fsCopy.dispatch(a, r, ctx('c2'));
    assert.equal(out.outcome, 'success');
    assert.equal(readFileSync(dst, 'utf8'), 'hello');
    assert.notEqual(lstatSync(dst).ino, lstatSync(src).ino);
    assert.equal(existsSync(join(d.root, '.billy-c2.tmp')), false);
  } finally { d.cleanup(); }
});

test('publish refuses a temporary file swapped for a symlink to an outside file', () => {
  const d = dirs();
  try {
    const tmp = join(d.root, '.billy-x.tmp'), p = join(d.root, 'out.txt');
    const fd = openSync(tmp, 'wx'); writeSync(fd, 'mine'); const ino = fstatSync(fd).ino; closeSync(fd);
    const parentId = (() => { const s = statSync(d.root); return `${s.dev}:${s.ino}`; })();
    unlinkSync(tmp); symlinkSync(d.secret, tmp);
    for (const mode of ['create', 'replace'] as const) {
      if (!existsSync(tmp)) symlinkSync(d.secret, tmp);
      assert.throws(() => publishInode(tmp, ino, p, parentId, mode), /identity changed/);
      assert.equal(existsSync(p) || (() => { try { lstatSync(p); return true; } catch { return false; } })(), false, `${mode}: no published name remains`);
      assert.equal(statSync(d.secret).nlink, 1);
      assert.equal(readFileSync(d.secret, 'utf8'), 'outside secret');
    }
  } finally { d.cleanup(); }
});

test('fs.write create and replace still publish atomically and leave no temporary files', async () => {
  const d = dirs();
  try {
    const p = join(d.root, 'w.txt');
    const a = { path: p, content: 'one', mode: 'create' };
    const r = fsWrite.resolve!(a, ctx('w1')) as any;
    assert.equal((await fsWrite.dispatch(a, r, ctx('w1'))).outcome, 'success');
    const { createHash } = await import('node:crypto');
    const b = { path: p, content: 'two', mode: 'replace', expected_sha256: createHash('sha256').update('one').digest('hex') };
    const r2 = fsWrite.resolve!(b, ctx('w2')) as any;
    assert.equal((await fsWrite.dispatch(b, r2, ctx('w2'))).outcome, 'success');
    assert.equal(readFileSync(p, 'utf8'), 'two');
    // A replace whose target changed after the precondition check is refused.
    const c = { path: p, content: 'three', mode: 'replace', expected_sha256: b.expected_sha256 };
    const r3 = fsWrite.resolve!(c, ctx('w3')) as any;
    assert.equal((await fsWrite.dispatch(c, r3, ctx('w3'))).outcome, 'failure');
    assert.equal(readFileSync(p, 'utf8'), 'two');
    assert.deepEqual((await import('node:fs')).readdirSync(d.root).filter((n: string) => n.startsWith('.billy-')), []);
  } finally { d.cleanup(); }
});
