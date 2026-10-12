import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/db.ts';

export function tempDir(prefix = 'billy-test-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function openTempStore(): { store: Store; dir: string; cleanup: () => void } {
  const t = tempDir();
  const store = Store.open({ dir: join(t.dir, 'data'), allowUnsafeLocation: true });
  return { store, dir: t.dir, cleanup: () => { store.close(); t.cleanup(); } };
}

/** Deterministic PRNG (mulberry32) so failing seeds can be replayed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
