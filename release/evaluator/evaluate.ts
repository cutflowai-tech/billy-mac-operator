// Billy release gate evaluator (handoff §20.2, REQ-32, T-REL-02, T-REL-03).
//   node evaluate.ts --manifest <requirements.manifest.json> --baseline <sha256 file>
//                    --results <results.json> --candidate-commit <sha> --artifact <path-to-artifact>
//                    [--repo <dir>] [--json]
// Exit 0 only when every mandatory gate passes for the exact candidate.
// Any doubt is a failure. It never trusts a self-reported "complete" flag.
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { acceptanceProblems, criticalScenarioIds, REVIEW_SIGNATURE_NAMESPACE, REVIEWS_PATH, reviewProblems, sha256, unresolvedFindings, type Finding, type ReviewContext, type ReviewRecord } from './review.ts';
import { changedFiles, fileAt, GENERATED_EVIDENCE_PATHS, treeOf } from '../lib/git-state.ts';
import { arg } from '../lib/cli.ts';

export type { Finding } from './review.ts';

export type Result = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_RUN' | 'SKIPPED' | 'EXPECTED_PASS' | 'MOCK_ONLY' | 'UNRESOLVED';

export interface EvidenceRef { path: string; sha256: string; what?: string }
export interface TestResult {
  test_id: string; result: Result; lane: string; run_id: string;
  started_at: string | null; finished_at: string | null;
  evidence: EvidenceRef[];
  candidate: { commit: string; artifact_sha256: string };
  environment?: Record<string, unknown>;
  measurements?: Record<string, number>;
  blocker?: string | null;
}
export interface Results {
  schema_version: 1;
  candidate: { commit: string; artifact_sha256: string; artifact_commit?: string | null; requirement_manifest_sha256: string };
  run?: { started_at: string; dirty_tree: boolean; reused_logs: string[]; ignored_measurements?: string[] };
  test_results: TestResult[];
  findings: Finding[];
  /** Legacy: reviews are read from release/reviews.json (Inputs.reviews), never trusted from results. */
  review_records?: ReviewRecord[];
  [k: string]: unknown;
}

export interface Inputs { manifestText: string; baselineSha256: string; results: Results; candidateCommit: string; artifactSha256: string; repo: string;
  /** Independent review records (release/reviews.json). */
  reviews: ReviewRecord[];
  /** The evaluated results file, as attested by the acceptance review (repo-relative path and digest). */
  resultsPath: string; resultsSha256: string;
  /** Review-binding seams (default to git and the repo files); tests substitute them. */
  review?: Partial<Pick<ReviewContext, 'changedSince' | 'treeOf' | 'readFile' | 'verifySignature'>> }

/**
 * The owner's reviewer trust root: an ssh-keygen allowed-signers file named by BILLY_ALLOWED_SIGNERS. It must live
 * OUTSIDE the repository: a trust root the candidate itself could edit would let the implementer approve itself.
 */
export function allowedSignersVerifier(repo: string, file = process.env.BILLY_ALLOWED_SIGNERS): ReviewContext['verifySignature'] {
  if (!file) return undefined;
  return (payload, signature, signer) => {
    if (!isAbsolute(file) || !existsSync(file)) return `allowed-signers file ${file} not found`;
    const real = realpathSync(file), root = realpathSync(repo);
    if (real === root || real.startsWith(root + sep)) return 'the allowed-signers file is inside the repository under review';
    if (!/^[\w.@+-]{1,128}$/.test(signer)) return 'malformed signer principal';
    const dir = mkdtempSync(join(tmpdir(), 'billy-sig-'));
    try {
      const sig = join(dir, 'review.sig');
      writeFileSync(sig, signature);
      const r = spawnSync('/usr/bin/ssh-keygen', ['-Y', 'verify', '-f', real, '-I', signer, '-n', REVIEW_SIGNATURE_NAMESPACE, '-s', sig], { input: payload, encoding: 'utf8', timeout: 10_000 });
      return r.status === 0 ? null : (r.stderr || r.stdout || 'verification failed').trim().split('\n')[0];
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
}

/** Default review context reading the real repository at the candidate. */
export function repoReviewContext(repo: string, candidateCommit: string): Pick<ReviewContext, 'changedSince' | 'treeOf' | 'readFile' | 'verifySignature'> {
  return {
    verifySignature: allowedSignersVerifier(repo),
    changedSince: (c) => changedFiles(repo, c, candidateCommit),
    treeOf: (c) => treeOf(repo, c),
    // Source is read AT THE CANDIDATE commit; generated evidence (never in that commit) as produced on disk.
    readFile: (p) => {
      const atCandidate = fileAt(repo, candidateCommit, p);
      if (atCandidate) return atCandidate;
      if (!GENERATED_EVIDENCE_PATHS.some((d) => p.startsWith(`${d}/`))) return null;
      const f = join(repo, p); return existsSync(f) && statSync(f).isFile() ? readFileSync(f) : null;
    },
  };
}
export interface Verdict { release_ready: boolean; failures: string[]; summary: Record<string, number> }

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const LIVE_LANES = new Set(['NATIVE_LIVE', 'PROVIDER_LIVE', 'REMOTE_LIVE']);

/** Lanes that may satisfy a scenario's required lane. Live lanes accept only themselves. */
function laneSatisfies(required: string, actual: string): boolean {
  if (required === actual) return true;
  if (LIVE_LANES.has(required)) return false;
  // A stronger real-component lane may satisfy a weaker deterministic one, never the reverse.
  const order: Record<string, number> = { UNIT: 0, CONTRACT: 1, INTEGRATION: 2, FAULT: 2, SECURITY: 2, PACKAGE: 3, NATIVE_LIVE: 4, PROVIDER_LIVE: 4, REMOTE_LIVE: 4 };
  if (['FAULT', 'SECURITY', 'PACKAGE'].includes(required)) return actual === required || LIVE_LANES.has(actual) && required !== 'PACKAGE';
  return (order[actual] ?? -1) >= (order[required] ?? 99);
}

export function evaluate(i: Inputs): Verdict {
  const f: string[] = [];
  const fail = (m: string) => f.push(m);
  // 1-2. Manifest presence and identity.
  if (!i.manifestText.trim()) return { release_ready: false, failures: ['manifest is empty'], summary: {} };
  const manifestSha = sha256(i.manifestText);
  if (manifestSha !== i.baselineSha256) fail(`manifest digest ${manifestSha} does not match approved baseline ${i.baselineSha256}`);
  let manifest: any;
  try { manifest = JSON.parse(i.manifestText); } catch { return { release_ready: false, failures: ['manifest is not valid JSON'], summary: {} }; }
  const reqs: any[] = manifest.requirements ?? [];
  const tests: any[] = (manifest.tests ?? []).filter((t: any) => t.mandatory);
  if (!reqs.length || !tests.length) fail('manifest has no mandatory requirements or tests (an empty list can never pass)');
  const r = i.results;
  if (!r || r.schema_version !== 1) fail('results missing or wrong schema_version');
  // 5. Candidate binding.
  if (r?.candidate?.commit !== i.candidateCommit) fail(`results candidate commit ${r?.candidate?.commit} != delivered ${i.candidateCommit}`);
  if (r?.candidate?.artifact_sha256 !== i.artifactSha256) fail(`results artifact digest ${r?.candidate?.artifact_sha256} != delivered ${i.artifactSha256}`);
  // Candidate binding of the run itself: built from this commit, clean tree, every log produced by this run.
  if (r?.candidate?.artifact_commit !== i.candidateCommit) fail(`artifact was built from ${r?.candidate?.artifact_commit ?? 'an unknown commit'}, not the candidate ${i.candidateCommit}`);
  if (!r?.run || r.run.dirty_tree) fail('qualification ran on a dirty or unrecorded working tree');
  if ((r?.run?.reused_logs ?? []).length) fail(`qualification reused earlier logs: ${r!.run!.reused_logs.join(', ')}`);
  if (r?.candidate?.requirement_manifest_sha256 !== manifestSha) fail('results were produced against a different requirement manifest');
  // 3. Exact coverage: no missing, unknown or duplicate test IDs.
  const byId = new Map<string, TestResult>();
  const known = new Set(tests.map((t) => t.id));
  for (const tr of r?.test_results ?? []) {
    if (!known.has(tr.test_id)) { fail(`unknown test id in results: ${tr.test_id}`); continue; }
    if (byId.has(tr.test_id)) { fail(`duplicate result for ${tr.test_id}`); continue; }
    byId.set(tr.test_id, tr);
  }
  const counts: Record<string, number> = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_RUN: 0, SKIPPED: 0, MOCK_ONLY: 0, OTHER: 0, MISSING: 0 };
  const passedTests = new Set<string>();
  for (const t of tests) {
    const tr = byId.get(t.id);
    if (!tr) { counts.MISSING++; fail(`${t.id}: no result recorded`); continue; }
    const problems: string[] = [];
    // 6. Only an actual PASS counts.
    if (tr.result !== 'PASS') problems.push(`result ${tr.result}${tr.blocker ? ` (${tr.blocker})` : ''}`);
    // 4. Correct lane.
    if (!laneSatisfies(t.lane, tr.lane)) problems.push(`lane ${tr.lane} cannot satisfy required ${t.lane}`);
    // 5. Per-result candidate binding.
    if (tr.candidate?.commit !== i.candidateCommit || tr.candidate?.artifact_sha256 !== i.artifactSha256) problems.push('evidence bound to a different candidate');
    // 8. Real timestamps and evidence files with matching digests.
    if (!tr.run_id) problems.push('missing run_id');
    if (!tr.started_at || !tr.finished_at || !ISO.test(tr.started_at) || !ISO.test(tr.finished_at) || tr.finished_at < tr.started_at) problems.push('missing or invalid run timestamps');
    if (!tr.evidence?.length) problems.push('no evidence');
    for (const e of tr.evidence ?? []) {
      const p = isAbsolute(e.path) ? e.path : join(i.repo, e.path);
      if (!existsSync(p) || !statSync(p).isFile()) { problems.push(`evidence missing: ${e.path}`); continue; }
      if (sha256(readFileSync(p)) !== e.sha256) problems.push(`evidence digest mismatch: ${e.path}`);
    }
    if (LIVE_LANES.has(t.lane) && !tr.environment) problems.push('live result without environment record');
    if (problems.length) {
      counts[tr.result in counts ? tr.result : 'OTHER']++;
      fail(`${t.id}: ${problems.join('; ')}`);
    } else { counts.PASS++; passedTests.add(t.id); }
  }
  // Requirement coverage: each requirement needs >=1 passing mandatory scenario.
  for (const q of reqs) {
    const covering = tests.filter((t) => t.requirements.includes(q.id));
    if (!covering.some((t) => passedTests.has(t.id))) fail(`${q.id}: no passing mandatory scenario`);
  }
  // Quantitative gates (§19.2) from measurements.
  const g = manifest.gates ?? {};
  const m = (id: string, k: string) => byId.get(id)?.measurements?.[k];
  // A gate applies when its scenario is part of the frozen manifest (always true for the Billy baseline).
  let gateScenario = '';
  const gate = (ok: boolean, msg: string) => { if (known.has(gateScenario) && !ok) fail(`gate: ${msg}`); };
  const on = (id: string) => { gateScenario = id; };
  on('T-REL-08');
  gate((m('T-REL-08', 'event_sequences') ?? 0) >= (g.state_machine_sequences_min ?? 1000), 'state-machine sequences below minimum');
  gate((m('T-REL-08', 'distinct_boundaries') ?? 0) >= (g.crash_boundaries_min ?? 12), 'distinct crash boundaries below minimum');
  gate((m('T-REL-08', 'min_injections_per_boundary') ?? 0) >= (g.injections_per_boundary_min ?? 10), 'injections per boundary below minimum');
  on('T-REL-07');
  const soak = byId.get('T-REL-07');
  const soakMin = soak?.started_at && soak?.finished_at ? (Date.parse(soak.finished_at) - Date.parse(soak.started_at)) / 60000 : 0;
  gate(soakMin >= (g.active_soak_minutes_min ?? 60), `active soak wall-clock ${soakMin.toFixed(1)}min < ${g.active_soak_minutes_min ?? 60}`);
  gate((soak?.measurements?.tasks ?? 0) >= (g.active_soak_tasks_min ?? 20), 'soak task count below minimum');
  for (const id of ['T-MAC-01', 'T-MAC-02', 'T-MAC-03', 'T-MAC-04', 'T-MAC-05', 'T-MAC-06', 'T-MAC-07', 'T-MAC-08']) {
    on(id);
    gate((m(id, 'consecutive_passes') ?? 0) >= (g.native_consecutive_runs ?? 3), `${id} needs ${g.native_consecutive_runs ?? 3} consecutive live passes`);
  }
  on('T-AI-01');
  gate((m('T-AI-01', 'meaningful_actions') ?? 0) >= (g.real_autonomy_actions_min ?? 10), 'real autonomy run has fewer than 10 meaningful actions');
  on('T-AGENT-01');
  gate((m('T-AGENT-01', 'concurrent_workers') ?? 0) >= (g.multi_agent_concurrent_workers_min ?? 2), 'fewer than 2 concurrent workers');
  on('T-ACTION-09');
  const stopAck = m('T-ACTION-09', 'ack_seconds');
  gate(stopAck !== undefined && stopAck <= (g.local_stop_ack_seconds_max ?? 2), 'local stop acknowledgement not measured within bound');
  on('T-MAC-09');
  const takeover = m('T-MAC-09', 'suppression_ms');
  gate(takeover !== undefined && takeover <= (g.human_takeover_suppression_ms_max ?? 500), 'human takeover suppression not measured within bound');
  // 7. Independent review (both stages) and findings.
  const reviewCtx: ReviewContext = { candidateCommit: i.candidateCommit, manifestSha256: manifestSha, criticalIds: criticalScenarioIds(manifest),
    ...repoReviewContext(i.repo, i.candidateCommit), ...(i.review ?? {}) };
  const judged = (i.reviews ?? []).map((x) => ({ x, commit: reviewProblems(x, reviewCtx), acceptance: acceptanceProblems(x, reviewCtx, i) }));
  const approvesCommit = judged.filter((j) => j.commit.length === 0);
  // A review verifies fixes for release only when it passed BOTH stages (commit review and acceptance attestation).
  const approving = approvesCommit.filter((j) => j.acceptance.length === 0).map((j) => j.x);
  if (!approvesCommit.length) fail(`no independent review approves the candidate commit${judged.length ? `: ${judged[judged.length - 1].commit.join('; ')}` : ''}`);
  else if (!approving.length) fail(`no approving review attests the artifact and acceptance results: ${approvesCommit.at(-1)!.acceptance.join('; ')}`);
  // Findings are judged from the fingerprinted register at the candidate, and the results must agree with it.
  const findingsBytes = reviewCtx.readFile('release/findings.json');
  let findings: Finding[] = r?.findings ?? [];
  if (!findingsBytes) fail('release/findings.json is missing at the candidate');
  else {
    findings = JSON.parse(findingsBytes.toString('utf8'));
    if (sha256(JSON.stringify(findings)) !== sha256(JSON.stringify(r?.findings ?? null))) fail('results.json findings differ from release/findings.json at the candidate');
  }
  for (const fd of unresolvedFindings(findings, approving)) fail(`unresolved ${fd.severity} finding ${fd.id}${fd.status === 'closed' ? ' (fix not verified by an approving review)' : ''}: ${fd.summary}`);
  // 10. Ignore any self-reported completion claims.
  if ((r as any)?.complete === true || (r as any)?.release_state === 'RELEASE_READY') { /* deliberately not trusted */ }
  return { release_ready: f.length === 0, failures: f, summary: { mandatory_tests: tests.length, requirements: reqs.length, ...counts } };
}

if (import.meta.main) {
  const repo = resolve(arg('--repo') ?? '.');
  const manifestPath = arg('--manifest') ?? join(repo, 'release/requirements.manifest.json');
  const baselinePath = arg('--baseline') ?? join(repo, 'release/requirements.manifest.sha256');
  const resultsPath = arg('--results');
  const artifact = arg('--artifact');
  const commit = arg('--candidate-commit');
  const missing = [!resultsPath && '--results', !artifact && '--artifact', !commit && '--candidate-commit'].filter(Boolean);
  if (missing.length) { process.stderr.write(`missing ${missing.join(', ')}\n`); process.exit(2); }
  let results: Results;
  try { results = JSON.parse(readFileSync(resultsPath!, 'utf8')); } catch (e) { process.stderr.write(`cannot read results: ${(e as Error).message}\n`); process.exit(2); }
  const artifactSha = existsSync(artifact!) && statSync(artifact!).isFile() ? sha256(readFileSync(artifact!)) : 'missing-artifact';
  const reviewsFile = join(repo, REVIEWS_PATH);
  const reviews: ReviewRecord[] = existsSync(reviewsFile) ? JSON.parse(readFileSync(reviewsFile, 'utf8')) : [];
  const v = evaluate({ manifestText: readFileSync(manifestPath, 'utf8'), baselineSha256: readFileSync(baselinePath, 'utf8').trim().split(/\s+/)[0],
    results, candidateCommit: commit!, artifactSha256: artifactSha, repo, reviews,
    resultsPath: relative(repo, resolve(resultsPath!)), resultsSha256: sha256(readFileSync(resultsPath!)) });
  if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(v, null, 2) + '\n');
  else {
    process.stdout.write(`${v.release_ready ? 'RELEASE_READY' : 'NOT READY'} — ${JSON.stringify(v.summary)}\n`);
    for (const x of v.failures.slice(0, 400)) process.stdout.write(`  ✗ ${x}\n`);
    if (v.failures.length > 400) process.stdout.write(`  … ${v.failures.length - 400} more\n`);
  }
  process.exit(v.release_ready ? 0 : 1);
}
