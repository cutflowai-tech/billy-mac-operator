// Non-secret owner configuration (secrets live in the Keychain only).
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { assertValid, type Schema } from '../contracts/schema.ts';

export interface BillyConfig {
  schema_version: 1;
  owner_id: string;
  device_id: string;
  timezone: string;                 // IANA, display only; persisted instants are UTC
  default_grant_id: string | null;
  default_project_scope: string;
  provider: { kind: 'anthropic_api' | 'none'; planner_model: string | null; fast_model: string | null; budget_scope: string };
  remote: { telegram_enabled: boolean };
  retention: { raw_capture_hours: number };
  cua: { app_path: string; binary_sha256: string; team_id: string };
  /** Owner-configured API endpoints (destinations are never model-supplied). */
  endpoints?: { id: string; base_url: string; account_id: string; lookup_path?: string; supports_idempotency_keys: boolean; auth_secret_ref?: string }[];
}

const SCHEMA: Schema = {
  type: 'object',
  required: ['schema_version', 'owner_id', 'device_id', 'timezone', 'default_grant_id', 'default_project_scope', 'provider', 'remote', 'retention', 'cua'],
  properties: {
    schema_version: { const: 1 },
    owner_id: { type: 'string', minLength: 1, maxLength: 64 },
    device_id: { type: 'string', minLength: 1, maxLength: 64 },
    timezone: { type: 'string', pattern: '^[A-Za-z_]+(/[A-Za-z_+-]+)*$', maxLength: 64 },
    default_grant_id: { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
    default_project_scope: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,63}$' },
    provider: { type: 'object', required: ['kind', 'planner_model', 'fast_model', 'budget_scope'], properties: {
      kind: { enum: ['anthropic_api', 'none'] },
      planner_model: { anyOf: [{ type: 'string', maxLength: 128 }, { type: 'null' }] },
      fast_model: { anyOf: [{ type: 'string', maxLength: 128 }, { type: 'null' }] },
      budget_scope: { type: 'string', maxLength: 64 } } },
    remote: { type: 'object', required: ['telegram_enabled'], properties: { telegram_enabled: { type: 'boolean' } } },
    retention: { type: 'object', required: ['raw_capture_hours'], properties: { raw_capture_hours: { type: 'integer', minimum: 1, maximum: 720 } } },
    endpoints: { type: 'array', maxItems: 32, items: { type: 'object', required: ['id', 'base_url', 'account_id', 'supports_idempotency_keys'], properties: {
      id: { type: 'string', pattern: '^[a-z0-9_-]{1,64}$' }, base_url: { type: 'string', pattern: '^https?://', maxLength: 512 }, account_id: { type: 'string', maxLength: 255 },
      lookup_path: { type: 'string', pattern: '^[A-Za-z0-9/_-]{1,64}$' }, supports_idempotency_keys: { type: 'boolean' }, auth_secret_ref: { type: 'string', pattern: '^com\\.billy\\.endpoint\\.[a-z0-9_-]{1,64}$' } } } },
    cua: { type: 'object', required: ['app_path', 'binary_sha256', 'team_id'], properties: {
      app_path: { type: 'string', pattern: '^/' }, binary_sha256: { type: 'string', format: 'sha256' }, team_id: { type: 'string', maxLength: 16 } } },
  },
};

export function defaultConfig(): BillyConfig {
  return {
    schema_version: 1, owner_id: 'owner', device_id: 'mac-local', timezone: 'Africa/Cairo', default_grant_id: null,
    default_project_scope: 'general',
    provider: { kind: 'none', planner_model: null, fast_model: null, budget_scope: 'provider-total' },
    remote: { telegram_enabled: false },
    retention: { raw_capture_hours: 24 },
    cua: { app_path: '/Applications/CuaDriver.app', binary_sha256: '51b7515e5b124c179f0be56ef87ae5ede226e4a702e0d335b04ed2edd91c03c6', team_id: 'YCK386LBJ7' },
  };
}

export function loadConfig(dataDir: string): BillyConfig {
  const p = join(dataDir, 'config.json');
  if (!existsSync(p)) { saveConfig(dataDir, defaultConfig()); }
  return assertValid<BillyConfig>(SCHEMA, JSON.parse(readFileSync(p, 'utf8')), 'config.json');
}

export function saveConfig(dataDir: string, c: BillyConfig): void {
  assertValid(SCHEMA, c, 'config');
  const p = join(dataDir, 'config.json');
  writeFileSync(p + '.tmp', JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
  renameSync(p + '.tmp', p);
}
