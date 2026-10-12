// Generate THIRD_PARTY_NOTICES.txt and a minimal SBOM (REQ-33, T-REL-06) for the
// exact files that ship: production node_modules, the Node runtime, and the
// external pinned CuaDriver (not bundled; referenced by pin).
//   node tools/notices.ts <stagedCoreDir> <nodeDistDir> <outNotices> <outSbom>
import { sha256 } from '../release/evaluator/review.ts';
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [coreDir, nodeDir, outNotices, outSbom] = process.argv.slice(2);
const sha = (p: string) => sha256(readFileSync(p));

interface Comp { name: string; version: string; license: string; source: string; license_text_sha256: string | null; files_sha256?: string; bundled: boolean }
const comps: Comp[] = [];
let notices = 'Billy — third-party notices\nThis file lists every third-party component shipped in Billy.app and its license text.\n';

function licenseFile(dir: string): string | null {
  for (const f of readdirSync(dir)) if (/^(licen[cs]e|copying|notice)(\.(md|txt))?$/i.test(f)) return join(dir, f);
  return null;
}

function walk(nm: string) {
  if (!existsSync(nm)) return;
  for (const e of readdirSync(nm)) {
    if (e.startsWith('.')) continue;
    const p = join(nm, e);
    if (e.startsWith('@')) { walk(p); continue; }
    const pj = join(p, 'package.json');
    if (!existsSync(pj)) continue;
    const pkg = JSON.parse(readFileSync(pj, 'utf8'));
    const lf = licenseFile(p);
    const lic = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? 'UNKNOWN';
    comps.push({ name: pkg.name, version: pkg.version, license: lic, source: `npm:${pkg.name}@${pkg.version}`, license_text_sha256: lf ? sha(lf) : null, bundled: true });
    notices += `\n\n==== ${pkg.name}@${pkg.version} (${lic}) ====\n${lf ? readFileSync(lf, 'utf8') : `License: ${lic} (no license file shipped by the package)`}`;
    if (existsSync(join(p, 'node_modules'))) walk(join(p, 'node_modules'));
  }
}
walk(join(coreDir, 'node_modules'));

const nodeLic = join(nodeDir, 'LICENSE');
comps.push({ name: 'node', version: process.version, license: 'MIT and bundled third-party licenses (see text)', source: 'https://nodejs.org/dist/', license_text_sha256: sha(nodeLic),
  files_sha256: sha(join(nodeDir, 'bin', 'node')), bundled: true });
notices += `\n\n==== Node.js runtime ====\n${readFileSync(nodeLic, 'utf8')}`;
comps.push({ name: 'cua-driver (CuaDriver.app)', version: '0.26.1', license: 'MIT (driver); see docs/foundation-audit-cua.md for optional components', source: 'https://github.com/trycua/cua @ cc54254464c0c9aebfd6547fe7e4a0ceaf0456d7',
  license_text_sha256: null, files_sha256: '51b7515e5b124c179f0be56ef87ae5ede226e4a702e0d335b04ed2edd91c03c6', bundled: false });
notices += '\n\n==== CuaDriver (not bundled) ====\nBilly uses the separately installed CuaDriver.app 0.26.1 (MIT, Cua AI, Inc.), pinned by binary sha256 and Developer ID team YCK386LBJ7. It is not redistributed in Billy.app.\n';

const unknown = comps.filter((c) => c.bundled && (c.license === 'UNKNOWN' || !c.license));
writeFileSync(outNotices, notices);
writeFileSync(outSbom, JSON.stringify({ format: 'billy-sbom/1', generated_at: new Date().toISOString(), components: comps, unknown_licenses: unknown.map((c) => c.name) }, null, 2) + '\n');
console.log(`notices: ${comps.length} components (${unknown.length} with unknown license)`);
if (unknown.length) process.exit(1);
void statSync;
