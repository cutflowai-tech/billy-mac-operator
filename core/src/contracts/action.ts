// Versioned action envelope (handoff §8.1) and tool registry metadata (§8.2).
import type { Schema } from './schema.ts';

export const EFFECT_CLASSES = ['READ_ONLY', 'IDEMPOTENT_WRITE', 'NON_IDEMPOTENT_EFFECT'] as const;
export type EffectClass = typeof EFFECT_CLASSES[number];

const id: Schema = { type: 'string', format: 'uuid' };
const ts: Schema = { type: 'string', format: 'date-time' };
const nullable = (s: Schema): Schema => ({ anyOf: [s, { type: 'null' }] });
const ident: Schema = { type: 'string', minLength: 1, maxLength: 512 };

export const CONDITION_SCHEMA: Schema = {
  type: 'object',
  required: ['kind'],
  additionalProperties: { anyOf: [{ type: 'string', maxLength: 4096 }, { type: 'integer' }, { type: 'boolean' }, { type: 'null' }] },
  properties: { kind: { type: 'string', pattern: '^[a-z][a-z0-9_]{1,63}$' } },
};

export const ACTION_ENVELOPE_SCHEMA: Schema = {
  type: 'object',
  required: [
    'schema_version', 'action_id', 'attempt_id', 'task_id', 'task_revision', 'cancellation_generation',
    'actor_id', 'tool_id', 'tool_version', 'arguments', 'arguments_digest', 'target', 'authority',
    'effect_class', 'semantic_operation_id', 'idempotency_key', 'resource_claims', 'fencing_generation',
    'preconditions', 'postconditions', 'observation_ref', 'retry_policy_id', 'deadline_at',
    'budget_reservation_id', 'compensation_ref',
  ],
  properties: {
    schema_version: { const: 1 },
    action_id: id,
    attempt_id: id,
    task_id: id,
    task_revision: { type: 'integer', minimum: 1, maximum: 1_000_000 },
    cancellation_generation: { type: 'integer', minimum: 0, maximum: 1_000_000_000 },
    actor_id: ident,
    tool_id: { type: 'string', pattern: '^[a-z][a-z0-9_.]{1,63}$' },
    tool_version: { type: 'integer', minimum: 1, maximum: 1000 },
    // Arguments are validated against the tool's own strict input schema by the broker.
    arguments: { type: 'object', additionalProperties: true },
    arguments_digest: { type: 'string', format: 'sha256' },
    target: {
      type: 'object',
      required: ['device_id', 'account_id', 'resource_id'],
      properties: { device_id: ident, account_id: nullable(ident), resource_id: ident },
    },
    authority: {
      type: 'object',
      required: ['grant_id', 'policy_revision', 'expires_at'],
      properties: { grant_id: id, policy_revision: { type: 'integer', minimum: 1 }, expires_at: ts },
    },
    effect_class: { enum: EFFECT_CLASSES },
    semantic_operation_id: { type: 'string', format: 'sha256' },
    idempotency_key: nullable({ type: 'string', minLength: 8, maxLength: 128 }),
    resource_claims: {
      type: 'array', maxItems: 16,
      items: {
        type: 'object', required: ['resource_key', 'mode'],
        properties: { resource_key: ident, mode: { enum: ['shared', 'exclusive'] } },
      },
    },
    fencing_generation: { type: 'integer', minimum: 0 },
    preconditions: { type: 'array', maxItems: 16, items: CONDITION_SCHEMA },
    postconditions: { type: 'array', maxItems: 16, items: CONDITION_SCHEMA },
    observation_ref: nullable(ident),
    retry_policy_id: { enum: ['none', 'read_transient', 'idempotent_write'] },
    deadline_at: nullable(ts),
    budget_reservation_id: { anyOf: [id, { const: 'no-cost' }] },
    compensation_ref: nullable(ident),
  },
};

export interface Condition { kind: string; [k: string]: string | number | boolean | null }

export interface ActionEnvelope {
  schema_version: 1;
  action_id: string;
  attempt_id: string;
  task_id: string;
  task_revision: number;
  cancellation_generation: number;
  actor_id: string;
  tool_id: string;
  tool_version: number;
  arguments: Record<string, unknown>;
  arguments_digest: string;
  target: { device_id: string; account_id: string | null; resource_id: string };
  authority: { grant_id: string; policy_revision: number; expires_at: string };
  effect_class: EffectClass;
  semantic_operation_id: string;
  idempotency_key: string | null;
  resource_claims: { resource_key: string; mode: 'shared' | 'exclusive' }[];
  fencing_generation: number;
  preconditions: Condition[];
  postconditions: Condition[];
  observation_ref: string | null;
  retry_policy_id: 'none' | 'read_transient' | 'idempotent_write';
  deadline_at: string | null;
  budget_reservation_id: string;
  compensation_ref: string | null;
}

/** Tool registry metadata (§8.2). Every field is required; unknown tools fail before effects. */
export interface ToolSpec {
  tool_id: string;
  version: number;
  description: string;
  input_schema: Schema;
  output_schema: Schema;
  effect_class: EffectClass;
  tool_class: string;            // matched against grant.tool_classes
  capabilities: string[];         // e.g. fs.write, desktop.input, net.egress
  target_kind: 'file' | 'process' | 'app' | 'desktop' | 'browser' | 'http' | 'model' | 'memory' | 'notify' | 'worker' | 'none';
  cancellation: 'none' | 'cooperative' | 'kill_owned_process';
  timeout_ms: number;
  idempotency: 'inherent' | 'provider_key' | 'none';
  verification: string;           // name of the verifier used for postconditions
  reconciliation: string;         // name of the reconciler used for OUTCOME_UNKNOWN
  compensation: string;           // human statement of compensation limits
  lock_class: 'none' | 'path' | 'desktop' | 'account' | 'process';
  egress: 'none' | 'local' | 'cloud';
  executable_identity: string;    // module path or pinned binary digest
}
