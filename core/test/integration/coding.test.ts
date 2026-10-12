// Workflow B (multi-agent coding) + T-AGENT-02: children work in separate git
// worktrees; the single integration owner merges serially, refuses a shared-file
// conflict, the parent resolves it and the integrated suite is requalified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fixture } from '../fixtures.ts';
import { procRun } from '../../src/tools/proc.ts';
import { codeIntegrate } from '../../src/tools/integrate.ts';

const RUNTIME = dirname(dirname(realpathSync(process.execPath)));
const NODE = join(RUNTIME, 'bin', 'node');
const g = (cwd: string, ...a: string[]) => { const r = spawnSync('/usr/bin/git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };

function fixtureRepo(root: string) {
  const repo = join(root, 'repo'); mkdirSync(repo);
  writeFileSync(join(repo, 'lib.js'), 'exports.add = (a, b) => a - b; // planted defect\nexports.greet = (n) => "hi " + n;\n');
  writeFileSync(join(repo, 'test.js'), "const l=require('./lib.js');const a=require('assert');a.equal(l.add(2,3),5);a.equal(l.greet('x'),'hi x');if(l.shout){a.equal(l.shout('a'),'A!')}console.log('ALL PASS');\n");
  writeFileSync(join(repo, 'CHANGELOG.md'), '# Changes\n');
  g(repo, 'init', '-q', '-b', 'main'); g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'base');
  return repo;
}

test('Workflow B / T-AGENT-02: serialized integration refuses a conflicting shared file, then requalifies after resolution', async () => {
  const fx = fixture({ extraTools: [procRun(RUNTIME), codeIntegrate(RUNTIME)] }, { tool_classes: ['file', 'process'] });
  try {
    const repo = fixtureRepo(fx.root);
    // Child work in separate worktrees (as two workers would produce).
    g(repo, 'worktree', 'add', '-q', '-b', 'child-a', join(repo, '.wt-a'));
    g(repo, 'worktree', 'add', '-q', '-b', 'child-b', join(repo, '.wt-b'));
    writeFileSync(join(repo, '.wt-a', 'lib.js'), readFileSync(join(repo, 'lib.js'), 'utf8').replace('a - b', 'a + b'));
    writeFileSync(join(repo, '.wt-a', 'CHANGELOG.md'), '# Changes\n- fix add()\n');
    g(join(repo, '.wt-a'), 'commit', '-qam', 'fix add');
    writeFileSync(join(repo, '.wt-b', 'shout.js'), '');
    writeFileSync(join(repo, '.wt-b', 'lib.js'), readFileSync(join(repo, 'lib.js'), 'utf8') + 'exports.shout = (s) => s.toUpperCase() + "!";\n');
    writeFileSync(join(repo, '.wt-b', 'CHANGELOG.md'), '# Changes\n- add shout()\n');
    g(join(repo, '.wt-b'), 'add', '-A'); g(join(repo, '.wt-b'), 'commit', '-qm', 'add shout');
    const id = fx.task(); fx.run(id);
    const base = g(repo, 'rev-parse', 'HEAD');
    // Integration owner: A merges cleanly, B conflicts on CHANGELOG.md -> refused, tree reset to base.
    const r1 = await fx.core.broker.submit(fx.proposal(id, 'code.integrate', { repo, branches: ['child-a', 'child-b'], test_argv: [NODE, 'test.js'] }, 'integrate-1'));
    assert.equal(r1.verdict, 'FAILED');
    assert.match(r1.reason, /merge conflict integrating child-b: CHANGELOG.md/);
    assert.equal(g(repo, 'rev-parse', 'HEAD'), base, 'no partial / last-write-wins integration left behind');
    // Owner-of-integration resolves by rebasing child-b's changelog onto child-a (ownership review), then requalifies.
    g(join(repo, '.wt-b'), 'merge', '-q', '-X', 'theirs', 'child-a', '-m', 'take a');
    writeFileSync(join(repo, '.wt-b', 'CHANGELOG.md'), '# Changes\n- fix add()\n- add shout()\n');
    g(join(repo, '.wt-b'), 'commit', '-qam', 'resolve changelog');
    const r2 = await fx.core.broker.submit(fx.proposal(id, 'code.integrate', { repo, branches: ['child-a', 'child-b'], test_argv: [NODE, 'test.js'] }, 'integrate-2'));
    assert.equal(r2.verdict, 'COMMITTED', r2.reason);
    assert.equal((r2.evidence as any).independent_test_exit, 0, 'decisive tests re-run independently by the verifier');
    assert.equal(spawnSync(NODE, ['test.js'], { cwd: repo, encoding: 'utf8' }).stdout.trim(), 'ALL PASS');
    assert.match(readFileSync(join(repo, 'CHANGELOG.md'), 'utf8'), /fix add\(\)\n- add shout\(\)/);
  } finally { fx.cleanup(); }
});

test('integration whose combined tests fail is rolled back (child passing alone is not enough)', async () => {
  const fx = fixture({ extraTools: [procRun(RUNTIME), codeIntegrate(RUNTIME)] }, { tool_classes: ['file', 'process'] });
  try {
    const repo = fixtureRepo(fx.root);
    g(repo, 'checkout', '-q', '-b', 'child-bad');
    writeFileSync(join(repo, 'lib.js'), readFileSync(join(repo, 'lib.js'), 'utf8') + 'exports.shout = () => "wrong";\n');
    g(repo, 'commit', '-qam', 'bad shout'); g(repo, 'checkout', '-q', 'main');
    const base = g(repo, 'rev-parse', 'HEAD');
    const id = fx.task(); fx.run(id);
    const r = await fx.core.broker.submit(fx.proposal(id, 'code.integrate', { repo, branches: ['child-bad'], test_argv: [NODE, 'test.js'] }, 'i'));
    assert.equal(r.verdict, 'FAILED');
    assert.match(r.reason, /integrated tests failed/);
    assert.equal(g(repo, 'rev-parse', 'HEAD'), base);
  } finally { fx.cleanup(); }
});
