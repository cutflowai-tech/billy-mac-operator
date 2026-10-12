// Qualification runner: executes the automated suites, maps test results to
// mandatory scenario IDs with their ACTUAL evidence lane, writes candidate-bound
// results + evidence digests, and runs the strict evaluator.
//   node tools/qualify.ts --artifact <zip> [--skip-run]
// Never upgrades a lane: "(contract)" tests are CONTRACT; partial tests are PARTIAL (never pass).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { evaluate } from '../release/evaluator/evaluate.ts';
import { treeState } from '../release/lib/git-state.ts';
import { REVIEWS_PATH, sha256 } from '../release/evaluator/review.ts';
import { arg } from '../release/lib/cli.ts';

const ROOT = join(import.meta.dirname, '..');
const { commit, dirty_tree: dirty } = treeState(ROOT);
const artifactArg = arg('--artifact');
// Absolute: suites run from other working directories (core/) and must find the same file.
const artifact = artifactArg ? resolve(artifactArg) : undefined;
const artifactSha = artifact && existsSync(artifact) ? sha256(readFileSync(artifact)) : 'no-artifact';
/** The commit sealed inside the artifact (tools/package.sh writes core/build-info.json before signing); null if absent or unreadable. */
function sealedCommit(zip: string | undefined): string | null {
  if (!zip || !existsSync(zip)) return null;
  const r = spawnSync('/usr/bin/unzip', ['-p', zip, 'Billy.app/Contents/Resources/core/build-info.json'], { encoding: 'utf8' });
  if (r.status !== 0) { console.log(`WARNING: cannot read build-info.json from ${zip}: ${r.stderr.trim()}`); return null; }
  try { return String(JSON.parse(r.stdout).commit); } catch { console.log('WARNING: build-info.json is not valid JSON'); return null; }
}
const artifactCommit = sealedCommit(artifact);
const reusedLogs: string[] = [];
const outDir = join(ROOT, 'release', 'results', commit.slice(0, 12));
mkdirSync(outDir, { recursive: true });

interface Suite { name: string; dir: string; globs: string[]; lane: string }
const SUITES: Suite[] = [
  // (soak results are produced by tools/soak.ts and read below)
  { name: 'core-unit', dir: 'core', globs: ['test/unit/*.test.ts'], lane: 'UNIT' },
  { name: 'core-integration', dir: 'core', globs: ['test/integration/*.test.ts'], lane: 'INTEGRATION' },
  { name: 'core-security', dir: 'core', globs: ['test/security/*.test.ts'], lane: 'SECURITY' },
  { name: 'core-fault', dir: 'core', globs: ['test/fault/*.test.ts'], lane: 'FAULT' },
  { name: 'evaluator', dir: '.', globs: ['release/evaluator/*.test.ts'], lane: 'CONTRACT' },
  { name: 'build-continuation', dir: '.', globs: [], lane: 'FAULT' },
  { name: 'bootstrap', dir: '.', globs: [], lane: 'INTEGRATION' },
  { name: 'package', dir: 'core', globs: ['test/package/*.test.ts'], lane: 'PACKAGE' },
  { name: 'native', dir: 'native', globs: [], lane: 'UNIT' },
  // Live lanes: real apps/driver, real provider, real phone. They skip (NOT_RUN) without their setup-packet prerequisites.
  { name: 'native-live', dir: 'core', globs: ['test/live/native.test.ts'], lane: 'NATIVE_LIVE' },
  { name: 'provider-live', dir: 'core', globs: ['test/live/provider.test.ts'], lane: 'PROVIDER_LIVE' },
  { name: 'remote-live', dir: 'core', globs: ['test/live/remote.test.ts'], lane: 'REMOTE_LIVE' },
];
const LIVE = new Set(['native-live', 'provider-live', 'remote-live']);

interface Case { suite: string; name: string; ok: boolean; skipped: boolean; ms: number; skipReason?: string }
const cases: Case[] = [];
const evidence: { path: string; sha256: string; suite: string }[] = [];
const started = new Date().toISOString();

for (const s of SUITES) {
  const log = join(outDir, `${s.name}.tap`);
  // Live suites need the owner's machine/idle time: --skip-live leaves them out; --reuse-live keeps this commit's earlier live log.
  const runLive = LIVE.has(s.name) && !process.argv.includes('--skip-live') && !(process.argv.includes('--reuse-live') && existsSync(log));
  if (process.argv.includes('--skip-run') || (LIVE.has(s.name) && !runLive)) { if (existsSync(log)) reusedLogs.push(s.name); }
  if (!process.argv.includes('--skip-run') && (!LIVE.has(s.name) || runLive)) {
    let r;
    if (s.name === 'build-continuation') r = spawnSync('python3', ['-I', 'tests/boot/test_build_continuation.py'], { cwd: ROOT, encoding: 'utf8', timeout: 600_000 });
    else if (s.name === 'bootstrap') r = spawnSync('python3', ['-I', 'tests/boot/test_bootstrap.py'], { cwd: ROOT, encoding: 'utf8', timeout: 600_000 });
    else if (s.name === 'native') { spawnSync('swift', ['build'], { cwd: join(ROOT, 'native'), encoding: 'utf8', timeout: 1_800_000 }); r = spawnSync(join(ROOT, 'native/.build/debug/BillyTests'), [], { cwd: join(ROOT, 'native'), encoding: 'utf8', timeout: 600_000 }); }
    else if (LIVE.has(s.name)) r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=3600000', '--test-reporter=tap', ...s.globs], { cwd: join(ROOT, s.dir), encoding: 'utf8', timeout: 6 * 3_600_000, env: process.env });
    else r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=180000', '--test-reporter=tap', ...s.globs], { cwd: join(ROOT, s.dir), encoding: 'utf8', timeout: 3_600_000, env: { ...process.env, BILLY_FAULT_INJECTIONS: '10', BILLY_ARTIFACT_ZIP: artifact ?? '' } });
    writeFileSync(log, (r.stdout ?? '') + '\n# stderr\n' + (r.stderr ?? ''));
  }
  if (!existsSync(log)) continue;
  const text = readFileSync(log, 'utf8');
  evidence.push({ path: relative(ROOT, log), sha256: sha256(text), suite: s.name });
  if (s.name === 'build-continuation') {
    for (const m of text.matchAll(/^(test_\w+) .*\.\.\. (ok|FAIL|ERROR)/gm)) cases.push({ suite: s.name, name: `T-BOOT-02 T-BOOT-06 ${m[1]}`, ok: m[2] === 'ok', skipped: false, ms: 0 });
    continue;
  }
  if (s.name === 'bootstrap') {
    for (const m of text.matchAll(/^(test_\w+) .*\.\.\. (ok|FAIL|ERROR)/gm)) cases.push({ suite: s.name, name: m[1].replace(/_/g, '-').replace(/^test-/, '').replace('T-BOOT-01', 'T-BOOT-01'), ok: m[2] === 'ok', skipped: false, ms: 0 });
    continue;
  }
  if (s.name === 'native') {
    for (const m of text.matchAll(/^(PASS|FAIL|SKIP) (.+?)( \(\d+ ms\))?$/gm)) cases.push({ suite: s.name, name: `native: ${m[2]}`, ok: m[1] === 'PASS', skipped: m[1] === 'SKIP', ms: 0 });
    continue;
  }
  for (const m of text.matchAll(/^(not ok|ok) \d+ - (.+?)(?: # (SKIP|TODO) ?(.*))?$/gm)) {
    cases.push({ suite: s.name, name: m[2], ok: m[1] === 'ok' && !m[3], skipped: !!m[3], ms: 0, skipReason: m[4] || undefined });
  }
}

const soakFile = join(ROOT, 'artifacts/measurements/T-REL-07.json');
const soak = existsSync(soakFile) ? JSON.parse(readFileSync(soakFile, 'utf8')) : null;
if (soak) {
  const rep = join(ROOT, soak.report);
  if (existsSync(rep)) evidence.push({ path: soak.report, sha256: sha256(readFileSync(rep)), suite: 'soak' });
  // Candidate binding: a soak only counts for the exact artifact it exercised.
  // Every soak value is taken from the HASHED report, not from the convenience summary.
  const soakReport = existsSync(rep) ? JSON.parse(readFileSync(rep, 'utf8')) : {};
  const soakSha = soakReport.artifact_sha256 ?? null;
  const bound = soakSha === artifactSha;
  const reportOk = Array.isArray(soakReport.not_completed) && soakReport.not_completed.length === 0 && soakReport.receiver_effects === soakReport.expected_receiver_effects;
  soak.measurements = { minutes: Number(soakReport.wall_minutes ?? 0), tasks: Number(soakReport.tasks_completed ?? 0), recovery_events: Number(soakReport.recovery_events ?? 0), duplicate_effects: Number(soakReport.receiver_effects ?? 0) - Number(soakReport.expected_receiver_effects ?? 0) };
  soak.started_at = soakReport.started_at; soak.finished_at = soakReport.finished_at;
  cases.push({ suite: 'soak', name: `T-REL-07 active soak ${soak.measurements.minutes.toFixed(1)} min, ${soak.measurements.tasks} tasks`, ok: reportOk && bound, skipped: !bound, ms: 0,
    skipReason: bound ? undefined : `soak ran against artifact ${String(soakSha).slice(0, 12)}, not this candidate ${artifactSha.slice(0, 12)}; rerun tools/soak.ts` });
}
const manifestText = readFileSync(join(ROOT, 'release/requirements.manifest.json'), 'utf8');
const manifest = JSON.parse(manifestText);
const baseline = readFileSync(join(ROOT, 'release/requirements.manifest.sha256'), 'utf8').split(/\s+/)[0];
const laneOf = (c: Case) => {
  if (/\(contract\)/i.test(c.name)) return 'CONTRACT';
  if (c.suite === 'soak') return 'INTEGRATION';
  return SUITES.find((s) => s.name === c.suite)!.lane;
};
const partial = (c: Case) => /\((core|process|contract) part\)|\(part\)/i.test(c.name);
const finished = new Date().toISOString();

// Measurements produced by the suites.
const meas: Record<string, Record<string, number>> = {};
try {
  const seeds = JSON.parse(readFileSync(join(ROOT, 'artifacts/seeds/machines.json'), 'utf8'));
  const rows = readFileSync(join(ROOT, 'artifacts/fault/broker-boundaries.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const per = new Map<string, number>();
  // Only injections recorded during THIS qualification run count (rows are timestamped).
  for (const r of rows) if (r.result === 'PASS' && r.at >= started) per.set(r.boundary, (per.get(r.boundary) ?? 0) + 1);
  meas['T-REL-08'] = { event_sequences: seeds.sequences, distinct_boundaries: per.size, min_injections_per_boundary: Math.min(...per.values()) };
} catch { /* not produced */ }
// Only measurements written by THIS run at THIS clean commit count (each record carries its commit and time).
const staleMeasurements: string[] = [];
for (const f of existsSync(join(ROOT, 'artifacts/measurements')) ? readdirSync(join(ROOT, 'artifacts/measurements')) : []) {
  const m = JSON.parse(readFileSync(join(ROOT, 'artifacts/measurements', f), 'utf8'));
  if (!m.test_id || m.test_id === 'T-REL-07' || m.test_id === 'T-REL-08') continue; // soak/fault values come from their own bound sources
  if (m.commit !== commit || m.dirty_tree !== false || !(m.at >= started)) { staleMeasurements.push(f); continue; }
  meas[m.test_id] = { ...(meas[m.test_id] ?? {}), ...m.measurements };
}
if (soak) meas['T-REL-07'] = soak.measurements;

const testResults = [];
const matrix: { id: string; lane: string; status: string; tests: string[]; note: string }[] = [];
for (const t of manifest.tests) {
  const mine = cases.filter((c) => new RegExp(`\\b${t.id}\\b`).test(c.name));
  let result = 'NOT_RUN', lane = t.lane, note = '';
  if (mine.length) {
    const allOk = mine.every((c) => c.ok);
    const full = mine.filter((c) => !partial(c));
    const lanes = [...new Set(full.map(laneOf))];
    const skipped = mine.filter((c) => c.skipped);
    const ran = mine.filter((c) => !c.skipped);
    // A skipped case is never a pass. If the only cases that ran are on another lane (e.g. a contract test) while the
    // scenario's own-lane case was skipped, the scenario is NOT_RUN with the skip reason, not a pass and not a failure.
    const ranOnLane = ran.filter((c) => !partial(c) && laneOf(c) === t.lane);
    if (!ran.length || (skipped.length && !ranOnLane.length && ran.every((c) => c.ok))) { result = 'NOT_RUN'; note = `skipped: ${[...new Set(skipped.map((c) => c.skipReason ?? 'no reason'))].join('; ')}`; }
    else if (!allOk) { result = 'FAIL'; note = mine.filter((c) => !c.ok).map((c) => c.name).join(' | '); }
    else if (!full.length) { result = 'PARTIAL'; note = 'only partial coverage'; lane = laneOf(mine[0]); }
    else { result = 'PASS'; lane = lanes.includes(t.lane) ? t.lane : lanes[0]; }
  } else {
    note = ['NATIVE_LIVE', 'PROVIDER_LIVE', 'REMOTE_LIVE'].includes(t.lane) ? 'live prerequisite not available (setup packet)' : 'no automated test yet';
  }
  const ts = t.id === 'T-REL-07' && soak ? { s: soak.started_at, f: soak.finished_at } : { s: started, f: finished };
  testResults.push({ test_id: t.id, result, lane, run_id: `${commit.slice(0, 12)}-${t.id}`, started_at: mine.length ? ts.s : null, finished_at: mine.length ? ts.f : null,
    evidence: mine.length ? evidence.filter((e) => mine.some((c) => c.suite === e.suite)).map(({ path, sha256 }) => ({ path, sha256 })) : [],
    candidate: { commit, artifact_sha256: artifactSha }, environment: { os: spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).stdout.trim(), arch: process.arch, node: process.version, dirty_tree: !!dirty },
    measurements: meas[t.id], blocker: result === 'PASS' ? null : note });
  matrix.push({ id: t.id, lane: t.lane, status: result === 'PASS' && lane !== t.lane && ['NATIVE_LIVE', 'PROVIDER_LIVE', 'REMOTE_LIVE'].includes(t.lane) ? `PASS(${lane}) — wrong lane` : result, tests: mine.map((c) => c.name), note });
}

const findingsPath = join(ROOT, 'release/findings.json');
if (!existsSync(findingsPath)) { console.error('refusing: release/findings.json is missing (an empty register is never assumed)'); process.exit(2); }
const findings = JSON.parse(readFileSync(findingsPath, 'utf8'));
// Reviews are not embedded: the acceptance attestation fingerprints this results file, so it must not contain them.
const reviewsPath = join(ROOT, REVIEWS_PATH);
const reviews = existsSync(reviewsPath) ? JSON.parse(readFileSync(reviewsPath, 'utf8')) : [];
const results = { schema_version: 1, candidate: { commit, artifact_sha256: artifactSha, artifact_commit: artifactCommit, requirement_manifest_sha256: sha256(manifestText) },
  run: { started_at: started, dirty_tree: !!dirty, reused_logs: reusedLogs, ignored_measurements: staleMeasurements }, test_results: testResults, findings };
const resultsFile = join(outDir, 'results.json');
writeFileSync(resultsFile, JSON.stringify(results, null, 2));
writeFileSync(join(outDir, 'matrix.json'), JSON.stringify(matrix, null, 2));
// Until the acceptance review attests this run, the evaluation reports exactly that gate as unmet; re-evaluate afterwards with
//   node release/evaluator/evaluate.ts --results <this results.json> --artifact <zip> --candidate-commit <commit>
const v = evaluate({ manifestText, baselineSha256: baseline, results: results as any, candidateCommit: commit, artifactSha256: artifactSha, repo: ROOT,
  reviews, resultsPath: relative(ROOT, resultsFile), resultsSha256: sha256(readFileSync(resultsFile)) });
writeFileSync(join(outDir, 'evaluation.json'), JSON.stringify(v, null, 2));
const tally: Record<string, number> = {};
for (const m of matrix) tally[m.status.split(' ')[0]] = (tally[m.status.split(' ')[0]] ?? 0) + 1;
console.log(`cases: ${cases.length} (${cases.filter((c) => !c.ok).length} failing)  scenarios: ${JSON.stringify(tally)}`);
console.log(`evaluator: ${v.release_ready ? 'RELEASE_READY' : 'NOT READY'} (${v.failures.length} unmet gates)  -> ${relative(ROOT, outDir)}`);
if (dirty) console.log('WARNING: working tree is dirty; results are not candidate-qualifying');
process.exit(v.release_ready ? 0 : 1);
