// Independent-review binding (T-REL-09, REQ-32). Two stages, both fingerprinted:
//
//  1. Commit review (before packaging): the reviewer audits one commit, independently
//     reproduces every decisive critical test against it, and lists the high/critical fixes
//     it verified. It approves exactly what it fingerprinted: commit and tree, findings and
//     manifest digests, and the reproduction logs it produced.
//  2. Acceptance attestation (after qualification): the reviewer binds the approval to the
//     built artifact's digest and to the exact acceptance-result files it inspected.
//
// Any later change outside the review's own outputs (code, tests, docs, findings, manifest)
// voids the approval: a fresh review is required. A high/critical finding marked fixed
// counts as resolved only when an approving review verified it.
import { createHash } from 'node:crypto';

export const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');

/** Where independent review records live (repo-relative). */
export const REVIEWS_PATH = 'release/reviews.json';

export interface ReproductionRun {
  suite: string;                 // e.g. "core-security"
  command: string;               // exactly what was run
  candidate_commit: string;      // commit the run executed against (must be the audited commit)
  scenario_ids: string[];        // scenarios whose every case passed in this run
  tests: number; pass: number; fail: number;
  log: Fingerprint;              // repo-relative path under release/reviews/, and its digest
}

export interface Fingerprint { path: string; sha256: string }

export interface ReviewRecord {
  reviewer: string; scope: string; independent: boolean; at: string;
  /**
   * Reviewer identity is a signature, not a name: `signer` is the principal of an SSH key in the owner's
   * allowed-signers file (kept outside this repository), and `signature` is an armored `ssh-keygen -Y sign`
   * signature (namespace billy-review) over canonicalReviewPayload(record). Signed last, after any attestation.
   */
  signer?: string;
  signature?: string;
  /** Why the reviewer is independent of the change (who authored it, what context the reviewer had). Required. */
  independence_basis?: string;
  verdict?: 'approve' | 'reject';
  audited_commit?: string;
  audited_tree?: string;
  fingerprints?: { findings_sha256: string; manifest_sha256: string; critical_evidence: Fingerprint[] };
  reproduced?: ReproductionRun[];
  /** High/critical finding IDs whose fix this reviewer verified. */
  verified_findings?: string[];
  /** Stage 2: the built artifact and acceptance results this approval covers. */
  acceptance?: { artifact_sha256: string; results: Fingerprint[] };
}

export interface Finding { id: string; severity: 'critical' | 'high' | 'medium' | 'low'; status: 'open' | 'closed' | 'accepted'; summary: string; requires_verification?: boolean }

/** Paths a candidate may change after its review: only the review's own outputs and the build ledger. */
export function isPostReviewPath(path: string): boolean {
  return path === REVIEWS_PATH || path === 'execution/ledger.json' || path.startsWith('release/reviews/');
}

/** Decisive critical scenarios a reviewer must reproduce: every mandatory SECURITY- and FAULT-lane scenario. */
export const CRITICAL_REPRODUCTION_LANES = ['SECURITY', 'FAULT'] as const;
export function criticalScenarioIds(manifest: { tests?: { id: string; lane: string; mandatory?: boolean }[] }): string[] {
  return (manifest.tests ?? []).filter((t) => t.mandatory !== false && (CRITICAL_REPRODUCTION_LANES as readonly string[]).includes(t.lane)).map((t) => t.id);
}

export const REVIEW_SIGNATURE_NAMESPACE = 'billy-review';

/** The exact bytes a reviewer signs: the record without its signature, with keys in a stable order. */
export function canonicalReviewPayload(r: ReviewRecord): string {
  const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().filter((k) => v !== r || k !== 'signature').map((k) => [k, canon((v as any)[k])])) : v;
  return JSON.stringify(canon(r));
}

/** First line of every reproduction log: binds the log to the commit it ran against. */
export const reproductionHeader = (commit: string) => `# billy-reproduction candidate_commit ${commit}`;

export interface ParsedReproduction { commit: string | null; tests: number; pass: number; fail: number; ids: string[] }

/**
 * Re-derive what a reproduction log proves. TAP (node --test): a scenario ID counts only when every case naming it
 * passed (a failing or skipped case disqualifies it). The build-continuation transcript (python unittest) maps to
 * T-BOOT-02 and T-BOOT-06 only when every case passed and unittest reported OK.
 */
export function parseReproductionLog(suite: string, log: string): ParsedReproduction {
  const commit = /^# billy-reproduction candidate_commit ([0-9a-f]{40})$/m.exec(log.split('\n')[0] ?? '')?.[1] ?? null;
  if (suite === 'build-continuation') {
    const cases = [...log.matchAll(/^(test_\w+) .*\.\.\. (ok|FAIL|ERROR)/gm)];
    const pass = cases.filter((m) => m[2] === 'ok').length;
    const allOk = cases.length > 0 && pass === cases.length && /^OK\b/m.test(log);
    return { commit, tests: cases.length, pass, fail: cases.length - pass, ids: allOk ? ['T-BOOT-02', 'T-BOOT-06'] : [] };
  }
  const cases = [...log.matchAll(/^(not ok|ok) \d+ - (.+?)(?: # (SKIP|TODO).*)?$/gm)].map((m) => ({ ok: m[1] === 'ok' && !m[3], name: m[2] }));
  const byId = new Map<string, boolean>();
  for (const c of cases) for (const id of c.name.match(/\bT-[A-Z]+-\d{2}\b/g) ?? []) byId.set(id, (byId.get(id) ?? true) && c.ok);
  return { commit, tests: cases.length, pass: cases.filter((c) => c.ok).length, fail: cases.filter((c) => !c.ok).length,
    ids: [...byId].filter(([, ok]) => ok).map(([id]) => id).sort() };
}

export interface ReviewContext {
  candidateCommit: string;
  /** Files changed between `reviewed` and the candidate, or null if history is unknown (fails closed). */
  changedSince: (reviewed: string) => string[] | null;
  /** Tree hash of a commit, or null if unknown. */
  treeOf: (commit: string) => string | null;
  /** Contents of a repo-relative path AT THE CANDIDATE (generated evidence: as produced), or null if missing. */
  readFile: (path: string) => Buffer | null;
  manifestSha256: string;
  criticalIds: string[];
  /**
   * Verify `signature` by `signer` over `payload` against the owner's trust root; null when valid, otherwise why not.
   * Absent when no trust root is configured (fails closed).
   */
  verifySignature?: (payload: string, signature: string, signer: string) => string | null;
}

const fingerprintProblems = (label: string, list: Fingerprint[], c: ReviewContext) =>
  list.flatMap((e) => { const b = c.readFile(e.path); return !b || sha256(b) !== e.sha256 ? [`${label} ${e.path} missing or altered`] : []; });

/** Why this record does NOT approve the candidate COMMIT; empty means it does. */
export function reviewProblems(r: ReviewRecord, c: ReviewContext): string[] {
  const p: string[] = [];
  // Identity: a free-text reviewer name proves nothing (anyone, including the implementer, can write one).
  if (!r.signer || !r.signature) p.push('not signed by an owner-trusted reviewer key (see tools/sign-review.ts)');
  else if (!c.verifySignature) p.push('no reviewer trust root configured (BILLY_ALLOWED_SIGNERS)');
  else { const e = c.verifySignature(canonicalReviewPayload(r), r.signature, r.signer); if (e) p.push(`reviewer signature invalid: ${e}`); }
  if (!r.independent) p.push('not an independent review');
  if (!r.independence_basis?.trim()) p.push('no stated basis for independence');
  if (r.verdict !== 'approve') p.push(`verdict is ${JSON.stringify(r.verdict ?? null)}, not approve`);
  if (!r.audited_commit) return [...p, 'no audited_commit'];
  if (r.audited_commit !== c.candidateCommit) {
    const changed = c.changedSince(r.audited_commit);
    if (!changed) p.push(`history between ${r.audited_commit.slice(0, 12)} and the candidate is unknown`);
    else {
      const outside = changed.filter((f) => !isPostReviewPath(f));
      if (outside.length) p.push(`changed after the review (fresh review required): ${outside.slice(0, 8).join(', ')}${outside.length > 8 ? ', …' : ''}`);
    }
  }
  if (!r.audited_tree || c.treeOf(r.audited_commit) !== r.audited_tree) p.push('audited_tree does not match the audited commit');
  const f = r.fingerprints;
  if (!f) p.push('no fingerprints');
  else {
    const findings = c.readFile('release/findings.json');
    if (!findings || sha256(findings) !== f.findings_sha256) p.push('findings changed since the review (fresh review required)');
    if (f.manifest_sha256 !== c.manifestSha256) p.push('requirement manifest differs from the reviewed one');
    if (!(f.critical_evidence ?? []).length) p.push('no critical evidence fingerprinted');
    p.push(...fingerprintProblems('critical evidence', f.critical_evidence ?? [], c));
  }
  const runs = r.reproduced ?? [];
  if (!runs.length) p.push('no independently reproduced critical tests recorded');
  for (const run of runs) {
    if (run.candidate_commit !== r.audited_commit) p.push(`reproduction ${run.suite} ran against ${run.candidate_commit.slice(0, 12)}, not the audited commit`);
    if (run.fail !== 0 || run.pass !== run.tests) p.push(`reproduction ${run.suite} did not fully pass (${run.pass}/${run.tests}, ${run.fail} failed)`);
    const logProblems = fingerprintProblems('reproduction log', [run.log], c);
    p.push(...logProblems);
    if (!logProblems.length) {
      // The record's counts and scenario IDs are claims; the fingerprinted log is the evidence. Re-derive them.
      const got = parseReproductionLog(run.suite, c.readFile(run.log.path)!.toString('utf8'));
      if (got.commit !== run.candidate_commit) p.push(`reproduction log ${run.log.path} is not bound to ${run.candidate_commit.slice(0, 12)} (header ${got.commit?.slice(0, 12) ?? 'missing'})`);
      if (got.tests !== run.tests || got.pass !== run.pass || got.fail !== run.fail) p.push(`reproduction ${run.suite} counts differ from its log (log ${got.pass}/${got.tests}, ${got.fail} failed)`);
      const unproven = run.scenario_ids.filter((id) => !got.ids.includes(id));
      if (unproven.length) p.push(`reproduction ${run.suite} claims scenarios its log does not prove: ${unproven.join(', ')}`);
    }
  }
  const reproduced = new Set(runs.flatMap((run) => run.scenario_ids));
  const missing = c.criticalIds.filter((id) => !reproduced.has(id));
  if (missing.length) p.push(`critical scenarios not independently reproduced: ${missing.join(', ')}`);
  return p;
}

/** Why this record does NOT attest the evaluated artifact and results (stage 2); empty means it does. */
export function acceptanceProblems(r: ReviewRecord, c: ReviewContext, evaluated: { artifactSha256: string; resultsPath: string; resultsSha256: string }): string[] {
  const a = r.acceptance;
  if (!a) return ['no acceptance attestation (artifact and acceptance results not reviewed)'];
  const p: string[] = [];
  if (a.artifact_sha256 !== evaluated.artifactSha256) p.push('attested artifact differs from the evaluated artifact');
  const res = a.results.find((x) => x.path === evaluated.resultsPath);
  if (!res || res.sha256 !== evaluated.resultsSha256) p.push(`evaluated results ${evaluated.resultsPath} were not the ones attested`);
  p.push(...fingerprintProblems('acceptance evidence', a.results, c));
  return p;
}

/** Critical/high findings still unresolved: not closed, or closed but awaiting verification no approving review gave. */
export function unresolvedFindings(findings: Finding[], approving: ReviewRecord[]): Finding[] {
  const verified = new Set(approving.flatMap((r) => r.verified_findings ?? []));
  return findings.filter((f) => (f.severity === 'critical' || f.severity === 'high') && (f.status !== 'closed' || (f.requires_verification && !verified.has(f.id))));
}
