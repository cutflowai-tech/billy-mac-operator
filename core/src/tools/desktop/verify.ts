// Post-action verification for desktop.act: driver verify_state predicates plus
// deterministic on-device OCR of a fresh target-window crop.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AdapterContext, ResolvedTarget } from '../../broker/types.ts';
import { call, parseWindowTarget, svc, type DesktopServices, type Predicate } from './common.ts';

export type Verdict = { verdict: 'verified' | 'failed' | 'inconclusive'; evidence: unknown };

export async function verifyPredicates(ctx: AdapterContext, a: { expect: Predicate[] }, r: ResolvedTarget): Promise<Verdict> {
  const d = svc(ctx);
  const target = parseWindowTarget(r.resource_id);
  // An unparseable target never verifies anything: inconclusive, never a guessed window.
  if (!target) return { verdict: 'inconclusive', evidence: { error: `malformed target ${r.resource_id}` } };
  const { pid, window_id: windowId } = target;
  const driverPreds = a.expect.filter((p) => !p.ocr);
  const ocrPreds = a.expect.filter((p) => p.ocr);
  try {
    const ocrResults: { ok: boolean; seen: string[] }[] = [];
    for (const p of ocrPreds) if (p.ocr) ocrResults.push(await ocrCheck(d, pid, windowId, p.ocr));
    if (!driverPreds.length) return { verdict: ocrResults.every((r) => r.ok) ? 'verified' : 'failed', evidence: { ocr: ocrResults } };
    const sc = await call(d, 'verify_state', { pid, window_id: windowId, expect: driverPreds, timeout_ms: 3000, stable_samples: 2 });
    let status = String(sc.status ?? sc.result ?? (sc.satisfied === true ? 'satisfied' : sc.satisfied === false ? 'unsatisfied' : 'unknown'));
    if (ocrResults.some((r) => !r.ok)) status = 'unsatisfied';
    // "unknown" never implies success (driver contract); it stays inconclusive.
    return { verdict: status === 'satisfied' ? 'verified' : status === 'unsatisfied' ? 'failed' : 'inconclusive', evidence: { verify_state: status } };
  } catch (e) {
    return { verdict: 'inconclusive', evidence: { error: (e as Error).message } };
  }
}

/**
 * Deterministic visual check: a FRESH target-window crop from the driver, OCR'd
 * on-device (Vision via the bundled billy-ocr helper), compared exactly.
 */
async function ocrCheck(d: DesktopServices, pid: number, windowId: number, o: NonNullable<Predicate['ocr']>): Promise<{ ok: boolean; seen: string[] }> {
  if (!d.ocrPath) throw new Error('OCR helper not available');
  const raw: any = await d.transport().call('zoom', { pid, window_id: windowId, ...o.region }, d.sessionId);
  const img = (raw?.result?.content ?? []).find((c: any) => c.type === 'image');
  if (!img?.data) throw new Error('driver returned no image for the region');
  const dir = mkdtempSync(join(tmpdir(), 'billy-ocr-'));
  try {
    const f = join(dir, 'crop.jpg');
    writeFileSync(f, Buffer.from(img.data, 'base64'), { mode: 0o600 });
    const r = spawnSync(d.ocrPath, [f], { encoding: 'utf8', timeout: 20_000 });
    if (r.status !== 0) throw new Error(`ocr failed: ${r.stderr}`);
    const seen: string[] = JSON.parse(r.stdout).lines.map((l: any) => String(l.text).trim());
    const ok = (o.line_equals === undefined || seen.includes(o.line_equals)) && (o.contains === undefined || seen.some((s) => s.includes(o.contains!)));
    return { ok, seen };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
