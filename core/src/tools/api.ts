// Typed API operation family (handoff §16.1 "API operation"): account- and
// endpoint-bound message send with provider idempotency keys and
// reconciliation by operation identity. Endpoints are owner configuration
// (services.endpoints), never model-supplied URLs.
import type { ToolAdapter } from '../broker/types.ts';
import { TargetError } from '../broker/types.ts';
import type { ToolSpec } from '../contracts/action.ts';

export interface Endpoint {
  id: string;
  base_url: string;          // https:// or http://127.0.0.1 for fixtures
  account_id: string;
  auth_secret_ref?: string;  // Keychain reference resolved at the transport boundary
  supports_idempotency_keys: boolean;
  lookup_path?: string;      // GET <base>/<lookup_path>/<key> for reconciliation
}

function endpoints(services: Record<string, unknown>): Map<string, Endpoint> {
  return (services.endpoints as Map<string, Endpoint>) ?? new Map();
}

const spec: ToolSpec = {
  tool_id: 'api.send_message', version: 1,
  description: 'Send one message to a resolved recipient through an owner-configured endpoint/account',
  input_schema: { type: 'object', required: ['endpoint_id', 'account_id', 'to', 'body'], properties: {
    endpoint_id: { type: 'string', pattern: '^[a-z0-9_-]{1,64}$' },
    account_id: { type: 'string', minLength: 1, maxLength: 255 },
    to: { type: 'string', minLength: 1, maxLength: 255 },
    body: { type: 'string', minLength: 1, maxLength: 20000 } } },
  output_schema: { type: 'object', additionalProperties: true },
  effect_class: 'NON_IDEMPOTENT_EFFECT', tool_class: 'api.message', capabilities: ['net.egress'],
  target_kind: 'http', cancellation: 'none', timeout_ms: 15_000, idempotency: 'provider_key',
  verification: 'provider_lookup', reconciliation: 'provider_lookup',
  compensation: 'none: a delivered message cannot be recalled', lock_class: 'account', egress: 'cloud',
  executable_identity: 'core/src/tools/api.ts',
};

export const apiSendMessage: ToolAdapter = {
  spec,
  resolve(a, ctx) {
    const ep = endpoints(ctx.services).get(a.endpoint_id);
    if (!ep) throw new TargetError(`unknown endpoint ${a.endpoint_id}`);
    if (ep.account_id !== a.account_id) throw new TargetError('account does not belong to endpoint');
    const host = new URL(ep.base_url).host;
    return { resource_id: `msg:${ep.id}:${a.account_id}:${a.to}`, account_id: a.account_id,
      facts: { host, account_id: a.account_id, recipient: `${ep.id}:${a.account_id}:${a.to}`, ...(ep.auth_secret_ref ? { secret_ref: ep.auth_secret_ref } : {}) }, claims: [], fingerprint: ep.base_url };
  },
  fingerprint: (r) => r.fingerprint,
  preconditions(_a, _r, ctx) {
    return ctx ? { ok: true } : { ok: false, reason: 'no context' };
  },
  postconditions(a) { return [{ kind: 'provider_has_operation', endpoint_id: a.endpoint_id }]; },
  async dispatch(a, _r, ctx) {
    const ep = endpoints(ctx.services).get(a.endpoint_id)!;
    const key = keyFor(ctx);
    try {
      const res = await fetch(`${ep.base_url}/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key, ...authHeader(ep, ctx.services) },
        body: JSON.stringify({ account: a.account_id, to: a.to, body: a.body }),
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(spec.timeout_ms)]), redirect: 'error',
      });
      const text = await res.text();
      if (res.status === 409) return { outcome: 'failure', error: 'idempotency conflict: payload changed under same key', retryable: false };
      if (res.status === 429) return { outcome: 'failure', error: 'rate limited (request rejected, not applied)', retryable: true };
      if (res.status >= 500) return { outcome: 'unknown', error: `server ${res.status}` };
      if (res.status >= 400) return { outcome: 'failure', error: `client error ${res.status}`, retryable: false };
      return { outcome: 'success', receipt: { key, ...JSON.parse(text) } };
    } catch (e) {
      // Transport error after the request may have been sent: the effect may have happened.
      return { outcome: 'unknown', error: `transport: ${(e as Error).message}` };
    }
  },
  async verify(a, _r, _post, _receipt, ctx) {
    const r = await lookup(endpoints(ctx.services).get(a.endpoint_id)!, keyFor(ctx), ctx.services);
    return { verdict: r === 'found' ? 'verified' : r === 'absent' ? 'failed' : 'inconclusive', evidence: { lookup: r } };
  },
  async reconcile(a, _r, _post, ctx) {
    const r = await lookup(endpoints(ctx.services).get(a.endpoint_id)!, keyFor(ctx), ctx.services);
    return { status: r === 'found' ? 'applied' : r === 'absent' ? 'not_applied' : 'unknown', evidence: { lookup: r } };
  },
};

/**
 * The provider idempotency key is the stable semantic operation id, so every
 * attempt of one intended effect shares it (a new attempt_id never creates a
 * second effect at a keyed provider).
 */
function keyFor(ctx: { store: any; attemptId: string }): string {
  const row = ctx.store.db.prepare('SELECT semantic_operation_id s FROM attempts WHERE attempt_id=?').get(ctx.attemptId);
  return `billy-${row.s}`;
}

async function lookup(ep: Endpoint, key: string, services: Record<string, unknown> = {}): Promise<'found' | 'absent' | 'error'> {
  if (!ep.lookup_path) return 'error';
  try {
    const res = await fetch(`${ep.base_url}/${ep.lookup_path}/${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(5000), redirect: 'error', headers: authHeader(ep, services) });
    if (!res.ok) return 'error';
    const j = await res.json() as any;
    return j.found ? 'found' : 'absent';
  } catch { return 'error'; }
}

/** Secret injected only at the transport boundary, read from the scoped Keychain reference at call time. */
function authHeader(ep: Endpoint, services: Record<string, unknown>): Record<string, string> {
  if (!ep.auth_secret_ref) return {};
  const store = services.secrets as { get(ref: { service: string; account: string }): string | null } | undefined;
  const v = store?.get({ service: ep.auth_secret_ref, account: 'default' });
  if (!v) throw new Error(`credential ${ep.auth_secret_ref} unavailable`);
  return { authorization: `Bearer ${v}` };
}
