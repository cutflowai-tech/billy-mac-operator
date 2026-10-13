// Review binding reads history through release/lib/git-state.ts: ancestry is required, and review outputs
// never make the tree dirty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { changedFiles, treeState } from '../lib/git-state.ts';

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'billy-git-'));
  const g = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).stdout.trim();
  g('init', '-q', '-b', 'main');
  const commit = (f: string, body: string) => { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), body); g('add', '-A'); g('commit', '-q', '-m', f); return g('rev-parse', 'HEAD'); };
  return { dir, g, commit, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('changes are only computed from an ancestor of the candidate', () => {
  const r = repo();
  try {
    const base = r.commit('a.txt', '1');
    const candidate = r.commit('release/reviews.json', '[]');
    assert.deepEqual(changedFiles(r.dir, base, candidate), ['release/reviews.json']);
    r.g('checkout', '-q', '-b', 'side', base);
    const sibling = r.commit('b.txt', 'reviewed elsewhere');
    assert.equal(changedFiles(r.dir, sibling, candidate), null, 'a sibling commit is not history of the candidate');
    assert.equal(changedFiles(r.dir, candidate, base), null, 'nor is a later commit');
  } finally { r.cleanup(); }
});

test('an uncommitted review record does not make the source tree dirty; a source edit does', () => {
  const r = repo();
  try {
    r.commit('release/reviews.json', '[]');
    writeFileSync(join(r.dir, 'release/reviews.json'), '[{"new":"review"}]');
    assert.equal(treeState(r.dir).dirty_tree, false);
    writeFileSync(join(r.dir, 'code.ts'), 'x');
    assert.equal(treeState(r.dir).dirty_tree, true);
  } finally { r.cleanup(); }
});
