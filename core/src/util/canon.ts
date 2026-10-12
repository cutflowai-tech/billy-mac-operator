import { createHash, randomUUID } from 'node:crypto';

/** Canonical JSON: sorted keys, no whitespace. Used for digests and dedup identities. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('non-finite number in canonical JSON');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function digest(v: unknown): string {
  return sha256(canonical(v));
}

export function newId(): string {
  return randomUUID();
}

/** Canonical persisted instant: UTC, millisecond precision, trailing Z. */
export function utcNow(clock: () => number = Date.now): string {
  return new Date(clock()).toISOString();
}
