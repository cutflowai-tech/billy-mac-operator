// T-FOUND-01, T-FOUND-02, T-FOUND-05 (CONTRACT/INTEGRATION): pins are real, the
// reuse matrix is well-formed, lifecycle ownership is single, and documentation
// alone can never satisfy a live gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { evaluate } from '../../../release/evaluator/evaluate.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');

test('T-FOUND-01: every pinned component has a real immutable identity and a reviewed license entry', () => {
  const lock = JSON.parse(readFileSync(join(ROOT, 'upstream.lock.json'), 'utf8'));
  for (const c of lock.components) {
    assert.ok(c.license, `${c.name} has a license entry`);
    if (c.commit) {
      assert.match(c.commit, /^[0-9a-f]{40}$/);
      const local = c.name === 'openclaw' ? 'upstream/src/openclaw' : c.name === 'cua-driver' ? 'upstream/src/cua' : null;
      if (local && existsSync(join(ROOT, local))) {
        const r = spawnSync('git', ['-C', join(ROOT, local), 'cat-file', '-t', c.commit], { encoding: 'utf8' });
        assert.equal(r.stdout.trim(), 'commit', `${c.name} commit exists in the audited clone (not fabricated)`);
      }
    }
    if (c.binary_sha256) assert.match(c.binary_sha256, /^[0-9a-f]{64}$/);
  }
  const shipped = lock.components.filter((c: any) => c.shipped).map((c: any) => c.name);
  assert.deepEqual(shipped.sort(), ['@anthropic-ai/sdk', 'node']);
  const pkg = JSON.parse(readFileSync(join(ROOT, 'core/package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), ['@anthropic-ai/sdk']);
  assert.equal(pkg.dependencies['@anthropic-ai/sdk'], '0.128.0', 'exact pin');
});

test('T-FOUND-02: reuse/gap matrix is well-formed and there is exactly one retry owner and one scheduler', () => {
  const m = JSON.parse(readFileSync(join(ROOT, 'reuse-gap-matrix.json'), 'utf8'));
  const allowed = new Set(['VERIFIED_REUSE', 'VERIFIED_REUSE_PENDING_LIVE', 'CONFIGURATION_GAP', 'ADAPTER_GAP', 'CORE_GAP', 'UNVERIFIED']);
  for (const e of m.entries) { assert.ok(allowed.has(e.classification), e.capability); assert.ok(e.requirements.length && e.evidence && e.decision); }
  assert.ok(!m.entries.some((e: any) => e.classification === 'VERIFIED_REUSE'), 'nothing is verified reuse without a live proof yet');
  const src = (f: string) => readFileSync(join(ROOT, 'core/src', f), 'utf8');
  // The broker never loops on submissions (single retry owner = executor).
  assert.ok(!/for \(.*\)\s*\{[^}]*this\.submit\(/s.test(src('broker/broker.ts')));
  assert.match(src('scheduler/executor.ts'), /single owner of task readiness and action retry/);
  // Exactly one place moves READY -> RUNNING for core tasks, one for worker tasks.
  const files = readdirSync(join(ROOT, 'core/src'), { recursive: true }).filter((f) => String(f).endsWith('.ts')).map((f) => join(ROOT, 'core/src', String(f)));
  const runners = files.filter((f) => /(moveTo|transitionTask)\([^)\n]*'RUNNING'/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(runners.map((f) => f.split('/core/src/')[1]).sort(), ['agents/workers.ts', 'scheduler/executor.ts']);
});

test('T-FOUND-05: a documented-but-unproven capability cannot satisfy its live gate', () => {
  const manifest = JSON.stringify({ requirements: [{ id: 'REQ-11' }], tests: [{ id: 'T-FOUND-03', requirements: ['REQ-11'], lane: 'NATIVE_LIVE', mandatory: true }], gates: {} });
  const base = (s: string) => require_sha(s);
  const v = evaluate({ manifestText: manifest, baselineSha256: base(manifest), candidateCommit: 'a'.repeat(40), artifactSha256: 'b'.repeat(64), repo: ROOT,
    reviews: [], resultsPath: 'release/results/x/results.json', resultsSha256: 'c'.repeat(64),
    results: { schema_version: 1, candidate: { commit: 'a'.repeat(40), artifact_sha256: 'b'.repeat(64), requirement_manifest_sha256: base(manifest) }, findings: [], review_records: [{ reviewer: 'r', scope: 'x', independent: true, at: 'x' }],
      test_results: [{ test_id: 'T-FOUND-03', result: 'EXPECTED_PASS', lane: 'DOCUMENTATION', run_id: 'doc', started_at: null, finished_at: null, evidence: [{ path: 'docs/foundation-audit-cua.md', sha256: 'x' }], candidate: { commit: 'a'.repeat(40), artifact_sha256: 'b'.repeat(64) } }] } as any });
  assert.equal(v.release_ready, false);
  assert.ok(v.failures.some((f) => /T-FOUND-03: result EXPECTED_PASS/.test(f) && /lane DOCUMENTATION cannot satisfy required NATIVE_LIVE/.test(f)));
  const m = JSON.parse(readFileSync(join(ROOT, 'reuse-gap-matrix.json'), 'utf8'));
  assert.equal(m.entries.find((e: any) => e.capability === 'browser control').classification, 'UNVERIFIED');
});

import { createHash } from 'node:crypto';
function require_sha(s: string) { return createHash('sha256').update(s).digest('hex'); }
