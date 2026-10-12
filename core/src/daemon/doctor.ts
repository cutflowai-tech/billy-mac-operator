// Read-only diagnostics (T-UX-04, REQ-28): names each failing capability and the
// exact next action. Never deletes, repairs, or weakens anything.
import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { Core } from '../core.ts';
import type { BillyConfig } from './config.ts';
import { KNOWN_REFS, type SecretStore } from '../secrets/keychain.ts';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'unknown';
export interface Check { id: string; capability: string; status: CheckStatus; detail: string; fix?: string; blocks?: string[] }

export function doctor(core: Core | null, cfg: BillyConfig, dataDir: string, secrets: SecretStore, extra: Check[] = []): { ok: boolean; checks: Check[] } {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const [maj] = process.versions.node.split('.').map(Number);
  add({ id: 'runtime.node', capability: 'core runtime', status: maj >= 26 ? 'ok' : 'fail', detail: `node ${process.version} at ${process.execPath}` });
  if (core) {
    const p = core.store.pragmas();
    add({ id: 'store.integrity', capability: 'authoritative store', status: 'ok', detail: `schema v${core.store.schemaVersion()}, journal ${p.journal_mode}, synchronous ${p.synchronous}, sqlite ${p.sqlite_version}` });
    const latch = core.store.stopLatch();
    add({ id: 'control.stop', capability: 'emergency stop latch', status: latch.stopped ? 'warn' : 'ok', detail: latch.stopped ? `STOPPED (generation ${latch.generation}): ${latch.reason ?? ''}` : `clear (generation ${latch.generation})`, fix: latch.stopped ? 'Resume from the Billy app when ready' : undefined });
    const grant = cfg.default_grant_id ? core.policy.current(cfg.default_grant_id) : null;
    add({ id: 'policy.default_grant', capability: 'standing authorization', status: grant ? 'ok' : 'fail', detail: grant ? `grant rev ${grant.revision}, expires ${grant.expires_at}` : 'no standing grant configured', fix: grant ? undefined : 'Complete onboarding: Settings → Permissions', blocks: ['all tasks'] });
    const ceiling = core.budget.ceiling(cfg.provider.budget_scope);
    add({ id: 'budget.provider', capability: 'spending ceiling', status: ceiling ? 'ok' : 'fail', detail: ceiling ? `${(ceiling.ceiling_micros / 1e6).toFixed(2)} USD (${ceiling.period}), remaining ${((core.budget.remaining(cfg.provider.budget_scope) ?? 0) / 1e6).toFixed(2)}` : 'no explicit ceiling: billed calls are blocked', fix: ceiling ? undefined : 'Set a budget in Settings → Budget (setup packet S2)', blocks: ceiling ? undefined : ['REQ-16', 'REQ-17'] });
    const unresolved = core.store.db.prepare(`SELECT count(*) c FROM attempts WHERE status IN ('UNRESOLVED','OUTCOME_UNKNOWN','RECONCILING')`).get() as any;
    add({ id: 'effects.uncertain', capability: 'effect reconciliation', status: unresolved.c ? 'warn' : 'ok', detail: `${unresolved.c} uncertain effect(s)` });
  } else {
    add({ id: 'store.integrity', capability: 'authoritative store', status: 'fail', detail: 'store not open (see daemon log / quarantine)', fix: 'Run doctor from the app; restore from a verified backup if corrupt' });
  }
  const provHas = secrets.has(KNOWN_REFS.anthropic);
  add({ id: 'provider.credential', capability: 'AI provider', status: provHas ? 'ok' : 'fail',
    detail: provHas ? 'Anthropic credential present in Keychain (value not read)' : 'no Anthropic credential in Keychain item com.billy.provider.anthropic',
    fix: provHas ? undefined : 'security add-generic-password -U -s com.billy.provider.anthropic -a default -w', blocks: provHas ? undefined : ['REQ-16', 'REQ-17'] });
  add({ id: 'remote.telegram', capability: 'phone control', status: !cfg.remote.telegram_enabled ? 'warn' : secrets.has(KNOWN_REFS.telegram) ? 'ok' : 'fail',
    detail: cfg.remote.telegram_enabled ? 'Telegram enabled' : 'remote control not configured', fix: 'Setup packet S4', blocks: ['REQ-23', 'REQ-24'] });
  // Cua driver pin
  const bin = join(cfg.cua.app_path, 'Contents/MacOS/cua-driver');
  if (!existsSync(bin)) add({ id: 'cua.binary', capability: 'native vision/control', status: 'fail', detail: `missing ${bin}`, fix: 'Reinstall CuaDriver.app 0.26.1', blocks: ['REQ-11', 'REQ-12'] });
  else {
    const sha = createHash('sha256').update(readFileSync(bin)).digest('hex');
    const sig = spawnSync('/usr/bin/codesign', ['-dv', cfg.cua.app_path], { encoding: 'utf8' });
    const team = /TeamIdentifier=(\S+)/.exec(sig.stderr ?? '')?.[1] ?? 'unknown';
    const pinned = sha === cfg.cua.binary_sha256 && team === cfg.cua.team_id;
    add({ id: 'cua.binary', capability: 'native vision/control', status: pinned ? 'ok' : 'fail', detail: pinned ? `pinned cua-driver ${sha.slice(0, 12)}… team ${team}` : `binary ${sha.slice(0, 12)}… team ${team} does not match pin ${cfg.cua.binary_sha256.slice(0, 12)}…/${cfg.cua.team_id}`, fix: pinned ? undefined : 'Do not run an unpinned driver; reinstall the pinned version or requalify the new one', blocks: pinned ? undefined : ['REQ-11'] });
  }
  try {
    const fs = statfsSync(dataDir);
    const free = Number(fs.bavail) * Number(fs.bsize);
    add({ id: 'storage.free', capability: 'storage', status: free < 2e9 ? 'fail' : free < 5e9 ? 'warn' : 'ok', detail: `${(free / 1e9).toFixed(1)} GB free at data dir` });
  } catch { add({ id: 'storage.free', capability: 'storage', status: 'unknown', detail: 'statfs failed' }); }
  for (const e of extra) add(e);
  return { ok: !checks.some((c) => c.status === 'fail'), checks };
}
