// Independent reproduction for T-REL-09 (stage 1, commit review). Run BY THE REVIEWER at a clean checkout:
//   node tools/reproduce.ts --reviewer "<who>" --independence-basis "<why independent>" --verdict approve|reject
//                           [--verified-findings A-02,A-03] [--scope "<what was reviewed>"] [--fault-injections N]
// Executes the decisive suites at HEAD, keeps their TAP logs under release/reviews/<commit12>/, and prints
// the fingerprinted review record. Nothing is defaulted on the reviewer's behalf: identity, independence
// basis and verdict are the reviewer's own statements. It never edits source, and refuses a dirty tree.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { treeOf, treeState } from '../release/lib/git-state.ts';
import { arg } from '../release/lib/cli.ts';
import { criticalScenarioIds, sha256, type ReproductionRun, type ReviewRecord } from '../release/evaluator/review.ts';

const ROOT = join(import.meta.dirname, '..');
const reviewer = arg('--reviewer'), basis = arg('--independence-basis'), verdict = arg('--verdict') as 'approve' | 'reject' | undefined;
if (!reviewer || !basis?.trim() || !['approve', 'reject'].includes(verdict ?? '')) {
  console.error('usage: node tools/reproduce.ts --reviewer "<who>" --independence-basis "<why independent>" --verdict approve|reject [--verified-findings A-02,..] [--scope ..] [--fault-injections N]');
  process.exit(2);
}
const faultInjections = arg('--fault-injections') ?? '10';

const state = treeState(ROOT);
if (state.dirty_tree) { console.error(`refusing: source tree is dirty:\n${state.dirty_files.join('\n')}`); process.exit(3); }
const commit = state.commit;
const out = join(ROOT, 'release/reviews', commit.slice(0, 12));
mkdirSync(out, { recursive: true });

const SUITES = [
  { suite: 'core-security', globs: ['test/security/*.test.ts'] },
  { suite: 'core-fault', globs: ['test/fault/*.test.ts'] },
  { suite: 'core-integration', globs: ['test/integration/*.test.ts'] },
  { suite: 'core-unit', globs: ['test/unit/*.test.ts'] },
];

/** Scenario IDs all of whose cases passed (a single failing or skipped case disqualifies the ID). */
function passedScenarios(tap: string): { ids: string[]; tests: number; pass: number; fail: number } {
  const cases = [...tap.matchAll(/^(not ok|ok) \d+ - (.+?)(?: # (SKIP|TODO).*)?$/gm)].map((m) => ({ ok: m[1] === 'ok' && !m[3], name: m[2] }));
  const byId = new Map<string, boolean>();
  for (const c of cases) for (const id of c.name.match(/\bT-[A-Z]+-\d{2}\b/g) ?? []) byId.set(id, (byId.get(id) ?? true) && c.ok);
  return { ids: [...byId].filter(([, ok]) => ok).map(([id]) => id).sort(), tests: cases.length, pass: cases.filter((c) => c.ok).length, fail: cases.filter((c) => !c.ok).length };
}

const reproduced: ReproductionRun[] = [];
for (const s of SUITES) {
  const argv = ['--test', '--test-concurrency=1', '--test-timeout=180000', '--test-reporter=tap', ...s.globs];
  // The recorded command is derived from exactly the argv that runs.
  const command = `(cd core && BILLY_FAULT_INJECTIONS=${faultInjections} node ${argv.join(' ')})`;
  const r = spawnSync(process.execPath, argv, { cwd: join(ROOT, 'core'), encoding: 'utf8', timeout: 3_600_000, env: { ...process.env, BILLY_FAULT_INJECTIONS: faultInjections } });
  const log = join(out, `${s.suite}.tap`);
  writeFileSync(log, r.stdout ?? '');
  const p = passedScenarios(r.stdout ?? '');
  reproduced.push({ suite: s.suite, command, candidate_commit: commit, scenario_ids: p.ids, tests: p.tests, pass: p.pass, fail: p.fail,
    log: { path: relative(ROOT, log), sha256: sha256(readFileSync(log)) } });
  console.error(`${s.suite}: ${p.pass}/${p.tests} passed, ${p.fail} failed, ${p.ids.length} scenarios`);
}

// Build-continuation (T-BOOT-02, T-BOOT-06: a FAULT-lane scenario) is a Python unittest suite; mapped as qualify.ts maps it.
{
  const argv = ['-I', 'tests/boot/test_build_continuation.py', '-v'];
  const r = spawnSync('python3', argv, { cwd: ROOT, encoding: 'utf8', timeout: 600_000 });
  const transcript = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const log = join(out, 'build-continuation.log');
  writeFileSync(log, transcript);
  const cases = [...transcript.matchAll(/^(test_\w+) .*\.\.\. (ok|FAIL|ERROR)/gm)];
  const pass = cases.filter((m) => m[2] === 'ok').length;
  reproduced.push({ suite: 'build-continuation', command: `python3 ${argv.join(' ')}`, candidate_commit: commit,
    scenario_ids: cases.length && pass === cases.length && r.status === 0 ? ['T-BOOT-02', 'T-BOOT-06'] : [], tests: cases.length, pass, fail: cases.length - pass,
    log: { path: relative(ROOT, log), sha256: sha256(readFileSync(log)) } });
  console.error(`build-continuation: ${pass}/${cases.length} passed`);
}

const manifestText = readFileSync(join(ROOT, 'release/requirements.manifest.json'), 'utf8');
const critical = criticalScenarioIds(JSON.parse(manifestText));
const covered = new Set(reproduced.flatMap((r) => r.scenario_ids));
const record: ReviewRecord = {
  reviewer, scope: arg('--scope') ?? 'critical reproduction', independent: true, independence_basis: basis, at: new Date().toISOString(), verdict,
  audited_commit: commit, audited_tree: treeOf(ROOT, commit) ?? '',
  verified_findings: (arg('--verified-findings') ?? '').split(',').map((x) => x.trim()).filter(Boolean),
  fingerprints: { findings_sha256: sha256(readFileSync(join(ROOT, 'release/findings.json'))), manifest_sha256: sha256(manifestText),
    critical_evidence: reproduced.map((r) => r.log) },
  reproduced,
};
writeFileSync(join(out, 'reproduction.json'), JSON.stringify(record, null, 2));
console.error(`critical scenarios reproduced: ${critical.filter((id) => covered.has(id)).length}/${critical.length}${critical.some((id) => !covered.has(id)) ? ` (missing: ${critical.filter((id) => !covered.has(id)).join(', ')})` : ''}`);
console.log(JSON.stringify(record, null, 2));
