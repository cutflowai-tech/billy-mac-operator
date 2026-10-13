// T-REL-02 / T-REL-03 (CONTRACT): the evaluator rejects every invalid record set
// and accepts only a fully evidenced, candidate-bound one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { allowedSignersVerifier, evaluate, type Results, type TestResult } from './evaluate.ts';
import { canonicalReviewPayload } from './review.ts';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const repo = mkdtempSync(join(tmpdir(), 'billy-eval-'));
writeFileSync(join(repo, 'ev1.json'), '{"proof":1}');
writeFileSync(join(repo, 'ev2.json'), '{"proof":2}');
const ev = (p: string) => ({ path: p, sha256: sha(readFileSync(join(repo, p))) });

const manifestObj = {
  requirements: [{ id: 'REQ-A' }, { id: 'REQ-B' }],
  tests: [
    { id: 'T-X-01', requirements: ['REQ-A'], lane: 'CONTRACT', mandatory: true },
    { id: 'T-X-02', requirements: ['REQ-B'], lane: 'NATIVE_LIVE', mandatory: true },
  ],
  gates: {},
};
const manifestText = JSON.stringify(manifestObj);
const baseline = sha(manifestText);
const COMMIT = 'a'.repeat(40), ART = 'b'.repeat(64);
const good = (id: string, lane: string, extra: Partial<TestResult> = {}): TestResult => ({
  test_id: id, result: 'PASS', lane, run_id: `run-${id}`, started_at: '2026-10-11T10:00:00.000Z', finished_at: '2026-10-11T10:01:00.000Z',
  evidence: [ev('ev1.json')], candidate: { commit: COMMIT, artifact_sha256: ART }, environment: { os: '26.5.2' }, ...extra,
});
// Review binding (T-REL-09): an in-memory repository at the candidate, and a fingerprinted review of it.
const TREE = 't'.repeat(40);
const FINDINGS = '[]';
const REPRO_LOG = `# billy-reproduction candidate_commit ${COMMIT}\nok 1 - T-X-01: reproduced\n`;
const OLD = 'c'.repeat(40);
const OLD_LOG = `# billy-reproduction candidate_commit ${OLD}\nok 1 - T-X-01: reproduced\n`;
const CRIT_LOG = `# billy-reproduction candidate_commit ${COMMIT}\nok 1 - T-X-01: reproduced\nok 2 - T-S-01: reproduced\n`;
// Reviewer identity (T-REL-09): the seam stands in for ssh-keygen -Y verify against the owner's allowed signers.
const TRUSTED = 'owner-trusted-reviewer';
const fakeSign = (rec: any) => `fake:${rec.signer}:${sha(canonicalReviewPayload(rec))}`;
const RESULTS_PATH = 'release/results/aaaaaaaaaaaa/results.json', RESULTS_BODY = '{"results":"as attested"}';
const files: Record<string, string> = { 'release/findings.json': FINDINGS, 'release/reviews/aaaaaaaaaaaa/core-contract.tap': REPRO_LOG,
  'release/reviews/cccccccccccc/core-contract.tap': OLD_LOG, 'release/reviews/aaaaaaaaaaaa/core-security.tap': CRIT_LOG, [RESULTS_PATH]: RESULTS_BODY };
const reviewSeam = { changedSince: (_c: string): string[] | null => [], treeOf: (_c: string): string | null => TREE, readFile: (p: string) => (p in files ? Buffer.from(files[p]) : null),
  verifySignature: (payload: string, sig: string, signer: string): string | null => signer !== TRUSTED ? `${signer} is not an allowed signer` : sig === `fake:${signer}:${sha(payload)}` ? null : 'signature does not match the record' };
/** A review record signed by the trusted reviewer last, unless the override sets signer/signature itself. */
const goodReview = (over: Record<string, unknown> = {}) => { const r: any = unsignedReview(over); if (!('signature' in over)) r.signature = fakeSign(r); return r; };
const unsignedReview = (over: Record<string, unknown> = {}) => ({ reviewer: 'independent-reviewer', signer: TRUSTED, scope: 'all', independent: true, at: '2026-10-11T11:00:00Z', verdict: 'approve',
  independence_basis: 'fresh-context reviewer; did not author the change',
  acceptance: { artifact_sha256: ART, results: [{ path: RESULTS_PATH, sha256: sha(RESULTS_BODY) }] },
  audited_commit: COMMIT, audited_tree: TREE,
  fingerprints: { findings_sha256: sha(FINDINGS), manifest_sha256: baseline, critical_evidence: [{ path: 'release/reviews/aaaaaaaaaaaa/core-contract.tap', sha256: sha(REPRO_LOG) }] },
  reproduced: [{ suite: 'core-contract', command: 'node --test', candidate_commit: COMMIT, scenario_ids: ['T-X-01'], tests: 1, pass: 1, fail: 0,
    log: { path: 'release/reviews/aaaaaaaaaaaa/core-contract.tap', sha256: sha(REPRO_LOG) } }], ...over });
const results = (trs: TestResult[], over: Partial<Results> = {}): Results => ({
  schema_version: 1, candidate: { commit: COMMIT, artifact_sha256: ART, artifact_commit: COMMIT, requirement_manifest_sha256: baseline },
  run: { started_at: '2026-10-11T10:00:00Z', dirty_tree: false, reused_logs: [] },
  test_results: trs, findings: [], review_records: [goodReview()], ...over,
});
/** The candidate's release/findings.json holds the same findings as the results; reviews fingerprint that file. */
const run = (r: Results, over: Partial<Parameters<typeof evaluate>[0]> = {}) => {
  const fj = JSON.stringify(r.findings ?? []);
  const seam = { ...reviewSeam, readFile: (p: string) => (p === 'release/findings.json' ? Buffer.from(fj) : reviewSeam.readFile(p)) };
  // The fixture's reviewer fingerprinted (and then signed) exactly this run's findings.
  const reviews = (r.review_records ?? []).map((x: any) => {
    if (x.fingerprints?.findings_sha256 !== sha(FINDINGS)) return x;
    const y = { ...x, fingerprints: { ...x.fingerprints, findings_sha256: sha(fj) } };
    if (x.signature === fakeSign(x)) y.signature = fakeSign(y);
    return y;
  });
  return evaluate({ manifestText, baselineSha256: baseline, results: r, candidateCommit: COMMIT, artifactSha256: ART, repo, review: seam,
    reviews: reviews as any, resultsPath: RESULTS_PATH, resultsSha256: sha(RESULTS_BODY), ...over });
};

test.after(() => rmSync(repo, { recursive: true, force: true }));

test('T-REL-02: fully evidenced controlled record set passes', () => {
  const v = run(results([good('T-X-01', 'CONTRACT'), good('T-X-02', 'NATIVE_LIVE')]));
  assert.deepEqual(v.failures, []);
  assert.equal(v.release_ready, true);
});

test('T-REL-02: empty manifest, empty results and self-reported completion never pass', () => {
  assert.equal(evaluate({ manifestText: '', baselineSha256: '', results: results([]), candidateCommit: COMMIT, artifactSha256: ART, repo }).release_ready, false);
  const empty = JSON.stringify({ requirements: [], tests: [] });
  assert.equal(evaluate({ manifestText: empty, baselineSha256: sha(empty), results: results([], { candidate: { commit: COMMIT, artifact_sha256: ART, requirement_manifest_sha256: sha(empty) } }), candidateCommit: COMMIT, artifactSha256: ART, repo }).release_ready, false);
  const v = run({ ...results([]), complete: true, release_state: 'RELEASE_READY' } as any);
  assert.equal(v.release_ready, false);
  assert.ok(v.failures.some((f) => /no result recorded/.test(f)));
});

test('T-REL-02: missing, unknown and duplicate IDs fail with precise reasons', () => {
  const v1 = run(results([good('T-X-01', 'CONTRACT')]));
  assert.ok(v1.failures.includes('T-X-02: no result recorded'));
  const v2 = run(results([good('T-X-01', 'CONTRACT'), good('T-X-02', 'NATIVE_LIVE'), good('T-Y-99', 'UNIT')]));
  assert.ok(v2.failures.some((f) => /unknown test id in results: T-Y-99/.test(f)));
  const v3 = run(results([good('T-X-01', 'CONTRACT'), good('T-X-01', 'CONTRACT'), good('T-X-02', 'NATIVE_LIVE')]));
  assert.ok(v3.failures.some((f) => /duplicate result for T-X-01/.test(f)));
});

test('T-REL-02: SKIPPED, BLOCKED, NOT_RUN, EXPECTED_PASS, MOCK_ONLY and UNRESOLVED are rejected', () => {
  for (const res of ['SKIPPED', 'BLOCKED', 'NOT_RUN', 'EXPECTED_PASS', 'MOCK_ONLY', 'UNRESOLVED'] as const) {
    const v = run(results([good('T-X-01', 'CONTRACT'), good('T-X-02', 'NATIVE_LIVE', { result: res })]));
    assert.equal(v.release_ready, false, res);
    assert.ok(v.failures.some((f) => f.startsWith('T-X-02') && f.includes(`result ${res}`)), res);
  }
});

test('T-REL-02: mock/contract evidence cannot satisfy a live scenario', () => {
  const v = run(results([good('T-X-01', 'CONTRACT'), good('T-X-02', 'INTEGRATION')]));
  assert.ok(v.failures.some((f) => /lane INTEGRATION cannot satisfy required NATIVE_LIVE/.test(f)));
  const v2 = run(results([good('T-X-01', 'CONTRACT'), good('T-X-02', 'NATIVE_LIVE', { environment: undefined })]));
  assert.ok(v2.failures.some((f) => /live result without environment/.test(f)));
});

test('T-REL-03: changed code, dependency or binary digest invalidates evidence', () => {
  const r = results([good('T-X-01', 'CONTRACT'), good('T-X-02', 'NATIVE_LIVE')]);
  const vCommit = run(r, { candidateCommit: 'c'.repeat(40) });
  assert.ok(vCommit.failures.some((f) => /candidate commit/.test(f)));
  const vArt = run(r, { artifactSha256: 'd'.repeat(64) });
  assert.ok(vArt.failures.some((f) => /artifact digest/.test(f)) && vArt.failures.some((f) => /different candidate/.test(f)));
  // Evidence file altered after the run.
  writeFileSync(join(repo, 'ev2.json'), '{"proof":2}');
  const withEv2 = results([good('T-X-01', 'CONTRACT', { evidence: [ev('ev2.json')] }), good('T-X-02', 'NATIVE_LIVE')]);
  writeFileSync(join(repo, 'ev2.json'), '{"proof":"tampered"}');
  assert.ok(run(withEv2).failures.some((f) => /evidence digest mismatch: ev2.json/.test(f)));
  // Manifest edited (e.g. a scenario deleted) without an approved baseline.
  const edited = JSON.stringify({ ...manifestObj, tests: [manifestObj.tests[0]] });
  assert.ok(evaluate({ manifestText: edited, baselineSha256: baseline, results: r, candidateCommit: COMMIT, artifactSha256: ART, repo }).failures.some((f) => /does not match approved baseline/.test(f)));
});

test('T-REL-02: open critical/high findings and missing independent review fail', () => {
  const ok = [good('T-X-01', 'CONTRACT'), good('T-X-02', 'NATIVE_LIVE')];
  const v1 = run(results(ok, { findings: [{ id: 'F-9', severity: 'high', status: 'open', summary: 'x' }] }));
  assert.ok(v1.failures.some((f) => /unresolved high finding F-9/.test(f)));
  const v2 = run(results(ok, { review_records: [{ reviewer: 'me', scope: 'all', independent: false, at: 'x' }] }));
  assert.ok(v2.failures.some((f) => /no independent review approves the candidate commit/.test(f) && /not an independent review/.test(f)));
});

test('T-REL-02: invalid timestamps or missing evidence fail', () => {
  const v = run(results([good('T-X-01', 'CONTRACT', { started_at: null, evidence: [] }), good('T-X-02', 'NATIVE_LIVE', { evidence: [{ path: 'nope.json', sha256: 'e'.repeat(64) }] })]));
  assert.ok(v.failures.some((f) => /T-X-01: .*invalid run timestamps.*no evidence/.test(f)));
  assert.ok(v.failures.some((f) => /evidence missing: nope.json/.test(f)));
});

test('T-REL-02: real Billy manifest with zero results fails with every mandatory test listed', async () => {
  const { readFileSync } = await import('node:fs');
  const root = join(import.meta.dirname, '..', '..');
  const text = readFileSync(join(root, 'release/requirements.manifest.json'), 'utf8');
  const base = readFileSync(join(root, 'release/requirements.manifest.sha256'), 'utf8').split(/\s+/)[0];
  const v = evaluate({ manifestText: text, baselineSha256: base, results: results([], { candidate: { commit: COMMIT, artifact_sha256: ART, requirement_manifest_sha256: base } }), candidateCommit: COMMIT, artifactSha256: ART, repo });
  assert.equal(v.release_ready, false);
  assert.equal(v.summary.MISSING, 104);
  assert.ok(v.failures.some((f) => /gate: active soak/.test(f)));
});

test('T-REL-02: run binding — artifact from another commit, dirty tree or reused logs are never release-ready', () => {
  const pass = manifestObj.tests.map((t) => good(t.id, t.lane));
  assert.equal(run(results(pass)).release_ready, true, 'control: the unmodified run is ready');
  const base = results(pass);
  const variants: Partial<Results>[] = [
    { candidate: { ...base.candidate, artifact_commit: 'f'.repeat(40) } },
    { run: { started_at: base.run!.started_at, dirty_tree: true, reused_logs: [] } },
    { run: { started_at: base.run!.started_at, dirty_tree: false, reused_logs: ['native-live'] } },
  ];
  for (const v of variants) assert.equal(run(results(pass, v)).release_ready, false, JSON.stringify(v));
});

test('T-REL-09: a review approves only what it fingerprinted; any change it did not review requires a fresh review', () => {
  const pass = manifestObj.tests.map((t) => good(t.id, t.lane));
  const old = OLD;
  const ready = (rv: object, seam: Partial<typeof reviewSeam> = {}) => run(results(pass, { review_records: [goodReview(rv)] as any }), { review: { ...reviewSeam, ...seam } }).release_ready;
  assert.equal(ready({}), true, 'control: the fingerprinted review of this commit approves it');
  // Later commits: only the review's own outputs and the build ledger may change.
  const oldRun = { ...goodReview().reproduced[0], candidate_commit: old, log: { path: 'release/reviews/cccccccccccc/core-contract.tap', sha256: sha(OLD_LOG) } };
  assert.equal(ready({ audited_commit: old, reproduced: [oldRun] }, { changedSince: () => ['release/reviews.json', 'release/reviews/x/y.tap', 'execution/ledger.json'] }), true, 'review-output-only changes');
  assert.equal(ready({ audited_commit: old, reproduced: [oldRun] }, { changedSince: () => ['core/src/tools/desktop/act.ts'] }), false, 'code changed after the review');
  assert.equal(ready({ audited_commit: old, reproduced: [oldRun] }, { changedSince: () => ['release/findings.json'] }), false, 'findings changed after the review (re-review required)');
  assert.equal(ready({ audited_commit: old }, { changedSince: () => null }), false, 'unknown history fails closed');
  assert.equal(ready({ audited_commit: undefined }), false, 'unbound review');
  assert.equal(ready({ audited_tree: 'f'.repeat(40) }), false, 'tree fingerprint mismatch');
  assert.equal(ready({}, { readFile: (p) => (p === 'release/findings.json' ? Buffer.from('[{"id":"X"}]') : reviewSeam.readFile(p)) }), false, 'findings content differs from the fingerprint');
  assert.equal(ready({ fingerprints: { findings_sha256: sha(FINDINGS), manifest_sha256: 'e'.repeat(64), critical_evidence: [] } }), false, 'different manifest / no critical evidence');
  assert.equal(ready({}, { readFile: (p) => (p.endsWith('.tap') ? Buffer.from('tampered') : reviewSeam.readFile(p)) }), false, 'reproduction log altered');
  assert.equal(ready({ reproduced: [] }), false, 'no reproduction recorded');
});

test('T-REL-09: every critical (SECURITY/FAULT) scenario must be independently reproduced with zero failures against the audited commit', () => {
  const m = { ...manifestObj, tests: [...manifestObj.tests, { id: 'T-S-01', requirements: ['REQ-A'], lane: 'SECURITY', mandatory: true }] };
  const text = JSON.stringify(m);
  const pass = m.tests.map((t) => good(t.id, t.lane));
  const rv = (runOver: Record<string, unknown>) => goodReview({ fingerprints: { findings_sha256: sha(FINDINGS), manifest_sha256: sha(text), critical_evidence: [{ path: 'release/reviews/aaaaaaaaaaaa/core-security.tap', sha256: sha(CRIT_LOG) }] },
    reproduced: [{ suite: 'core-security', command: 'node --test', candidate_commit: COMMIT, scenario_ids: ['T-X-01', 'T-S-01'], tests: 2, pass: 2, fail: 0,
      log: { path: 'release/reviews/aaaaaaaaaaaa/core-security.tap', sha256: sha(CRIT_LOG) }, ...runOver }] });
  const ready = (r: object) => evaluate({ manifestText: text, baselineSha256: sha(text), results: { ...results(pass, { review_records: [r] as any }), candidate: { commit: COMMIT, artifact_sha256: ART, artifact_commit: COMMIT, requirement_manifest_sha256: sha(text) } },
    candidateCommit: COMMIT, artifactSha256: ART, repo, review: reviewSeam, reviews: [r] as any, resultsPath: RESULTS_PATH, resultsSha256: sha(RESULTS_BODY) }).release_ready;
  assert.equal(ready(rv({})), true, 'control');
  assert.equal(ready(rv({ scenario_ids: ['T-X-01'] })), false, 'critical T-S-01 not reproduced');
  assert.equal(ready(rv({ fail: 1, pass: 1 })), false, 'a reproduction failure');
  assert.equal(ready(rv({ candidate_commit: 'c'.repeat(40) })), false, 'reproduced against another commit');
});

test('T-REL-09: stage 2 — the approval must attest the evaluated artifact and the exact acceptance results', () => {
  const pass = manifestObj.tests.map((t) => good(t.id, t.lane));
  const ready = (rv: object, over: object = {}) => run(results(pass, { review_records: [goodReview(rv)] as any }), over).release_ready;
  assert.equal(ready({}), true, 'control');
  assert.equal(ready({ acceptance: undefined }), false, 'no acceptance attestation');
  assert.equal(ready({ acceptance: { artifact_sha256: 'd'.repeat(64), results: [{ path: RESULTS_PATH, sha256: sha(RESULTS_BODY) }] } }), false, 'another artifact');
  assert.equal(ready({}, { resultsSha256: sha('{"results":"edited after review"}') }), false, 'results changed after the attestation');
  assert.equal(ready({}, { resultsPath: 'release/results/other/results.json' }), false, 'a different results file');
  assert.equal(ready({ verdict: 'reject' }), false, 'a rejecting review never approves');
  assert.equal(ready({ independence_basis: '' }), false, 'independence must be stated');
});

test('T-REL-09: a high finding marked fixed counts as resolved only when an approving review verified it', () => {
  const pass = manifestObj.tests.map((t) => good(t.id, t.lane));
  const fixed = [{ id: 'A-02', severity: 'high' as const, status: 'closed' as const, summary: 'x', requires_verification: true }];
  const v1 = run(results(pass, { findings: fixed }));
  assert.equal(v1.release_ready, false);
  assert.ok(v1.failures.some((f) => /A-02 \(fix not verified/.test(f)));
  assert.equal(run(results(pass, { findings: fixed, review_records: [goodReview({ verified_findings: ['A-02'] })] as any })).release_ready, true, 'verified by the approving review');
  assert.equal(run(results(pass, { findings: [{ ...fixed[0], status: 'accepted' as const }], review_records: [goodReview({ verified_findings: ['A-02'] })] as any })).release_ready, false, 'accepted high is never resolved');
  // A review that approved only the commit (no acceptance attestation) cannot verify a fix for release.
  const v3 = run(results(pass, { findings: fixed, review_records: [goodReview({ verified_findings: ['A-02'], acceptance: undefined })] as any }));
  assert.ok(v3.failures.some((f) => /A-02 \(fix not verified/.test(f)), 'commit-only review does not verify fixes');
});

test('findings are judged from the fingerprinted register at the candidate; results that disagree fail', () => {
  const pass = manifestObj.tests.map((t) => good(t.id, t.lane));
  const v = run(results(pass), { review: { ...reviewSeam, readFile: (p: string) => (p === 'release/findings.json' ? Buffer.from('[{"id":"X-1","severity":"high","status":"open","summary":"hidden"}]') : reviewSeam.readFile(p)) } });
  assert.equal(v.release_ready, false);
  assert.ok(v.failures.some((f) => /results.json findings differ/.test(f)));
  assert.ok(v.failures.some((f) => /unresolved high finding X-1/.test(f)), 'the register, not the results, decides');
});

test('T-REL-09: reviewer identity is an owner-trusted signature over the final record, not a name', () => {
  const pass = manifestObj.tests.map((t) => good(t.id, t.lane));
  const verdict = (rv: any, seam: object = {}) => run(results(pass, { review_records: [rv] }), { review: { ...reviewSeam, ...seam } });
  assert.equal(verdict(goodReview()).release_ready, true, 'control');
  const unsigned = verdict(unsignedReview({ signer: undefined }));
  assert.ok(unsigned.failures.some((f) => /not signed by an owner-trusted reviewer key/.test(f)), 'a free-text reviewer name alone never approves');
  assert.equal(verdict(goodReview({ signer: 'the-implementer' })).release_ready, false, 'a key outside the allowed signers');
  const edited = { ...goodReview(), verified_findings: ['A-02'] };
  assert.ok(verdict(edited).failures.some((f) => /reviewer signature invalid/.test(f)), 'any edit after signing voids the approval');
  assert.ok(verdict(goodReview(), { verifySignature: undefined }).failures.some((f) => /no reviewer trust root configured/.test(f)), 'no trust root fails closed');
});

test('T-REL-09: reproduction claims are re-derived from the fingerprinted log', () => {
  const pass = manifestObj.tests.map((t) => good(t.id, t.lane));
  const withLog = (log: string, runOver: Record<string, unknown> = {}) => {
    const path = `release/reviews/aaaaaaaaaaaa/x-${sha(log).slice(0, 8)}.tap`;
    files[path] = log;
    const base = goodReview().reproduced[0];
    return run(results(pass, { review_records: [goodReview({ reproduced: [{ ...base, log: { path, sha256: sha(log) }, ...runOver }],
      fingerprints: { findings_sha256: sha(FINDINGS), manifest_sha256: baseline, critical_evidence: [{ path, sha256: sha(log) }] } })] as any }));
  };
  assert.equal(withLog(REPRO_LOG).release_ready, true, 'control');
  assert.ok(withLog(`# billy-reproduction candidate_commit ${COMMIT}\nok 1 - unrelated case\n`).failures.some((f) => /claims scenarios its log does not prove: T-X-01/.test(f)), 'claimed scenario absent from the log');
  assert.ok(withLog(`# billy-reproduction candidate_commit ${COMMIT}\nok 1 - T-X-01: a\nnot ok 2 - T-X-01: b\n`, { tests: 1, pass: 1, fail: 0 }).failures.some((f) => /counts differ from its log/.test(f)), 'a hidden failing case');
  assert.ok(withLog(`# billy-reproduction candidate_commit ${COMMIT}\nok 1 - T-X-01: a # SKIP not run\n`).failures.some((f) => /does not prove: T-X-01|counts differ/.test(f)), 'a skipped case proves nothing');
  assert.ok(withLog('ok 1 - T-X-01: reproduced\n').failures.some((f) => /is not bound to/.test(f)), 'a log without its commit header');
  assert.ok(withLog(`# billy-reproduction candidate_commit ${OLD}\nok 1 - T-X-01: reproduced\n`).failures.some((f) => /is not bound to/.test(f)), 'a log from another commit');
});

test('T-REL-09: the default verifier checks real SSH signatures against an allowed-signers file outside the repository', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdirSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'billy-signers-'));
  const fakeRepo = join(dir, 'repo'); mkdirSync(fakeRepo);
  try {
    const key = join(dir, 'reviewer');
    assert.equal(spawnSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'reviewer', '-f', key]).status, 0);
    const allowed = join(dir, 'allowed_signers');
    writeFileSync(allowed, `${TRUSTED} namespaces="billy-review" ${readFileSync(`${key}.pub`, 'utf8').trim()}\n`);
    const rec: any = unsignedReview();
    const payload = canonicalReviewPayload(rec);
    writeFileSync(join(dir, 'p.json'), payload);
    assert.equal(spawnSync('/usr/bin/ssh-keygen', ['-Y', 'sign', '-f', key, '-n', 'billy-review', join(dir, 'p.json')]).status, 0);
    const sig = readFileSync(join(dir, 'p.json.sig'), 'utf8');
    const verify = allowedSignersVerifier(fakeRepo, allowed)!;
    assert.equal(verify(payload, sig, TRUSTED), null, 'a valid signature by an allowed signer');
    assert.notEqual(verify(payload, sig, 'someone-else'), null, 'another principal');
    assert.notEqual(verify(canonicalReviewPayload({ ...rec, verdict: 'reject' }), sig, TRUSTED), null, 'a changed record');
    assert.notEqual(verify(payload, sig.replace(/[A-Za-z]/, (c) => (c === 'A' ? 'B' : 'A')), TRUSTED), null, 'a corrupted signature');
    const inside = join(fakeRepo, 'allowed_signers'); writeFileSync(inside, readFileSync(allowed));
    assert.match(String(allowedSignersVerifier(fakeRepo, inside)!(payload, sig, TRUSTED)), /inside the repository/, 'a trust root the candidate can edit');
    assert.equal(allowedSignersVerifier(fakeRepo, undefined), undefined, 'no trust root configured');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
