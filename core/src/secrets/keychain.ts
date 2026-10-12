// Scoped macOS Keychain access (handoff §11.6, T-SEC-09).
// Only explicitly named (service, account) references are ever queried; there
// is no enumeration or dump API. Secret values travel over a pipe (never argv,
// env, logs or URLs) and are registered with the redactor on read.
import { spawnSync } from 'node:child_process';
import { registerSecret } from '../util/redact.ts';

export interface SecretRef { service: string; account: string }

export const KNOWN_REFS = {
  anthropic: { service: 'com.billy.provider.anthropic', account: 'default' },
  telegram: { service: 'com.billy.remote.telegram', account: 'bot' },
  backupKey: { service: 'com.billy.backup-key', account: 'billy' },
} as const satisfies Record<string, SecretRef>;

/** Audit hook: every access is recorded (reference only, never the value). */
export const accessLog: { at: string; op: string; service: string; account: string; found: boolean }[] = [];

export interface SecretStore {
  has(ref: SecretRef): boolean;
  get(ref: SecretRef): string | null;
}

export class Keychain implements SecretStore {
  private bin: string;
  constructor(bin = '/usr/bin/security') { this.bin = bin; }

  has(ref: SecretRef): boolean {
    const r = spawnSync(this.bin, ['find-generic-password', '-s', ref.service, '-a', ref.account], { stdio: ['ignore', 'ignore', 'ignore'] });
    const found = r.status === 0;
    accessLog.push({ at: new Date().toISOString(), op: 'has', service: ref.service, account: ref.account, found });
    return found;
  }

  get(ref: SecretRef): string | null {
    const r = spawnSync(this.bin, ['find-generic-password', '-s', ref.service, '-a', ref.account, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const found = r.status === 0;
    accessLog.push({ at: new Date().toISOString(), op: 'get', service: ref.service, account: ref.account, found });
    if (!found) return null;
    const v = r.stdout.replace(/\n$/, '');
    registerSecret(v);
    return v;
  }
}

/** In-memory store for tests (never touches the real Keychain). */
export class MemorySecrets implements SecretStore {
  private m = new Map<string, string>();
  set(ref: SecretRef, v: string): void { this.m.set(`${ref.service}|${ref.account}`, v); registerSecret(v); }
  has(ref: SecretRef): boolean { accessLog.push({ at: new Date().toISOString(), op: 'has', ...ref, found: this.m.has(`${ref.service}|${ref.account}`) }); return this.m.has(`${ref.service}|${ref.account}`); }
  get(ref: SecretRef): string | null { const v = this.m.get(`${ref.service}|${ref.account}`) ?? null; accessLog.push({ at: new Date().toISOString(), op: 'get', ...ref, found: v !== null }); return v; }
}
