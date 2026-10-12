// Acceptance attestation for T-REL-09 (stage 2). Run BY THE REVIEWER after qualification:
//   node tools/attest.ts --commit-review <index in release/reviews.json> --artifact <zip> --results <results.json> [--also <file>...]
// Fingerprints the built artifact and the exact acceptance-result files the reviewer inspected, and prints the
// review record with its `acceptance` block added. Results produced by a dirty or reused run are refused.
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { REVIEWS_PATH, sha256 } from '../release/evaluator/review.ts';
import { arg, args } from '../release/lib/cli.ts';

const ROOT = join(import.meta.dirname, '..');
const idx = Number(arg('--commit-review')), artifact = arg('--artifact'), resultsArg = arg('--results');
if (!Number.isInteger(idx) || !artifact || !resultsArg) { console.error('usage: node tools/attest.ts --commit-review <i> --artifact <zip> --results <results.json> [--also <file>...]'); process.exit(2); }
const reviews = JSON.parse(readFileSync(join(ROOT, REVIEWS_PATH), 'utf8'));
const record = reviews[idx];
if (!record?.audited_commit) { console.error(`review ${idx} is not a commit review`); process.exit(2); }
const results = JSON.parse(readFileSync(resultsArg, 'utf8'));
if (results.run?.dirty_tree || (results.run?.reused_logs ?? []).length) { console.error('refusing: results come from a dirty tree or reused logs'); process.exit(3); }
const also = args('--also');
const files = [resultsArg, ...also].map((f) => resolve(f));
record.acceptance = { artifact_sha256: sha256(readFileSync(artifact)), results: files.map((f) => ({ path: relative(ROOT, f), sha256: sha256(readFileSync(f)) })) };
console.log(JSON.stringify(record, null, 2));
