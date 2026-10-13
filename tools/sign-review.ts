// Sign a review record for T-REL-09. Run BY THE REVIEWER, last (after reproduce.ts and, for stage 2, attest.ts):
//   node tools/sign-review.ts --record <record.json> --key <private ssh key> --signer <principal>
// Prints the record with `signer` and `signature` (ssh-keygen -Y sign, namespace billy-review) over
// canonicalReviewPayload. The evaluator accepts it only if <principal> and its public key are in the owner's
// allowed-signers file (BILLY_ALLOWED_SIGNERS, outside the repository). Any later edit to the record voids it.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalReviewPayload, REVIEW_SIGNATURE_NAMESPACE, type ReviewRecord } from '../release/evaluator/review.ts';
import { arg } from '../release/lib/cli.ts';

const recordPath = arg('--record'), key = arg('--key'), signer = arg('--signer');
if (!recordPath || !key || !signer) { console.error('usage: node tools/sign-review.ts --record <record.json> --key <private ssh key> --signer <principal>'); process.exit(2); }
const record: ReviewRecord = { ...JSON.parse(readFileSync(recordPath, 'utf8')), signer };
delete record.signature;
const dir = mkdtempSync(join(tmpdir(), 'billy-sign-'));
try {
  const payload = join(dir, 'review.json');
  writeFileSync(payload, canonicalReviewPayload(record));
  const r = spawnSync('/usr/bin/ssh-keygen', ['-Y', 'sign', '-f', key, '-n', REVIEW_SIGNATURE_NAMESPACE, payload], { stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' });
  if (r.status !== 0) { console.error('ssh-keygen -Y sign failed'); process.exit(3); }
  record.signature = readFileSync(`${payload}.sig`, 'utf8');
  console.log(JSON.stringify(record, null, 2));
} finally { rmSync(dir, { recursive: true, force: true }); }
