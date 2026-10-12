// Model gateway: the only path from Billy to an AI provider (handoff §10.4,
// §10.5, §11.6). Every call is admitted like a chargeable effect:
//   stop latch -> egress authorization (grant.model_egress) -> priced model ->
//   budget reservation (worst case) -> provider call -> usage settlement ->
//   redacted audit record.
// Model output is always an untrusted proposal; callers validate it.
import type { Store } from '../store/db.ts';
import type { Budget } from '../budget/budget.ts';
import { BudgetWait } from '../budget/budget.ts';
import { redact } from '../util/redact.ts';
import { digest } from '../util/canon.ts';

export type Role = 'planner' | 'general_executor' | 'visual_reasoner' | 'coding_builder' | 'reviewer' | 'summarizer' | 'fallback';

/** USD micro-dollars per token (Anthropic first-party list prices, cached 2026-10-06). */
export const PRICES: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-fable-5-1': { in: 10, out: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-opus-5': { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};
/** Worst-case per-token price used for reservations when server-side refusal fallback may switch models. */
const WORST = PRICES['claude-fable-5-1'];

export interface Usage { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }

export interface CompletionRequest {
  signal?: AbortSignal;
  role: Role;
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  /** JSON schema for structured output (strict object). */
  schema: Record<string, unknown>;
  max_tokens: number;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  task_id: string | null;
  grant_egress: string[];         // providers authorized for this task's data
  budget_scopes: string[];
}

export interface CompletionResult { json: unknown; raw_text: string; model: string; stop_reason: string; usage: Usage; cost_micros: number; call_id: string }

export class ProviderWait extends Error {
  readonly retryAt: string | null;
  readonly kind: 'rate_limited' | 'unavailable' | 'auth' | 'budget' | 'egress' | 'stopped' | 'config';
  constructor(kind: ProviderWait['kind'], msg: string, retryAt: string | null = null) { super(msg); this.kind = kind; this.retryAt = retryAt; }
}
export class ProviderOutputError extends Error {}

/** Transport-level driver for one vendor; the gateway owns policy. */
export interface ProviderDriver {
  id: string;                     // e.g. 'anthropic'
  listModels(): Promise<{ id: string; max_input_tokens?: number; max_tokens?: number }[]>;
  call(model: string, req: CompletionRequest): Promise<{ text: string; model: string; stop_reason: string; usage: Usage; usage_by_model?: { model: string; usage: Usage }[]; refusal?: string | null }>;
}

export function costMicros(model: string, u: Usage): number | null {
  const p = PRICES[model];
  if (!p) return null;
  return Math.ceil(u.input_tokens * p.in + u.output_tokens * p.out + (u.cache_read_input_tokens ?? 0) * p.cacheRead + (u.cache_creation_input_tokens ?? 0) * p.cacheWrite);
}

export interface GatewayConfig { roles: Partial<Record<Role, string>>; refusalFallback: boolean }

export class ModelGateway {
  private store: Store;
  private budget: Budget;
  private driver: ProviderDriver | null;
  cfg: GatewayConfig;
  private retryAt = 0;
  private consecutiveFailures = 0;
  calls = 0;

  constructor(store: Store, budget: Budget, driver: ProviderDriver | null, cfg: GatewayConfig) {
    this.store = store; this.budget = budget; this.driver = driver; this.cfg = cfg;
  }

  setDriver(d: ProviderDriver | null): void { this.driver = d; this.retryAt = 0; this.consecutiveFailures = 0; }
  get providerId(): string | null { return this.driver?.id ?? null; }

  /** Validate configured role models against the provider's actual model list. */
  async discover(): Promise<{ available: string[]; roles: Record<string, { model: string; ok: boolean; reason?: string }> }> {
    if (!this.driver) throw new ProviderWait('config', 'no provider configured');
    const models = await this.driver.listModels();
    const ids = models.map((m) => m.id);
    const roles: Record<string, { model: string; ok: boolean; reason?: string }> = {};
    for (const [role, model] of Object.entries(this.cfg.roles)) {
      if (!model) continue;
      const ok = ids.includes(model) && !!PRICES[model];
      roles[role] = { model, ok, reason: !ids.includes(model) ? 'not offered by this account' : !PRICES[model] ? 'no known price; cannot budget' : undefined };
    }
    this.store.tx(() => this.store.event('provider', this.driver!.id, 'discovered', { available: ids.slice(0, 50), roles }));
    return { available: ids, roles };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    if (req.signal?.aborted) throw new ProviderWait('stopped', 'planner request was cancelled');
    if (this.store.stopLatch().stopped) throw new ProviderWait('stopped', 'owner stop latch is set');
    if (!this.driver) throw new ProviderWait('config', 'no AI provider configured');
    if (!req.grant_egress.includes(this.driver.id)) throw new ProviderWait('egress', `provider ${this.driver.id} is not authorized to receive this task's data`);
    const model = this.cfg.roles[req.role] ?? this.cfg.roles.planner;
    if (!model) throw new ProviderWait('config', `no model configured for role ${req.role}`);
    if (!PRICES[model]) throw new ProviderWait('config', `model ${model} has no known price; refusing to call without budgeting`);
    if (Date.now() < this.retryAt) throw new ProviderWait('rate_limited', 'provider backoff in effect', new Date(this.retryAt).toISOString());
    // A chars/token average under-reserves for Arabic, emoji, code and schema
    // tokens. Reserve one token per UTF-8 byte plus framing headroom, including
    // the output schema; an uncached prefix can incur the cache-write rate.
    const inputBound = Buffer.byteLength(JSON.stringify({ system: req.system, messages: req.messages, schema: req.schema }), 'utf8') + 4096;
    const price = this.cfg.refusalFallback ? WORST : PRICES[model];
    const estimate = Math.ceil(inputBound * Math.max(price.in, price.cacheWrite) + req.max_tokens * price.out);
    let reservation: string;
    try { reservation = this.budget.reserve(req.budget_scopes, estimate, `model:${req.role}`); }
    catch (e) { if (e instanceof BudgetWait) throw new ProviderWait('budget', e.message); throw e; }
    const callId = crypto.randomUUID();
    const reqDigest = digest({ system: req.system, messages: req.messages });
    this.store.tx(() => this.store.event('model_call', callId, 'dispatching', { role: req.role, model, task_id: req.task_id, estimate_micros: estimate, request_digest: reqDigest }));
    this.calls++;
    let out;
    try {
      out = await this.driver.call(model, req);
    } catch (e) {
      const err = e as any;
      const status = err?.status as number | undefined;
      // A request that reached the provider may have been billed: keep the reservation as uncertain spend
      // unless the provider definitively rejected it before processing (4xx other than 408/409/429).
      const definitelyNotBilled = status !== undefined && status >= 400 && status < 500 && ![408, 409, 429].includes(status);
      this.budget.settle(reservation, definitelyNotBilled ? 0 : 'unknown');
      if (req.signal?.aborted) {
        this.store.tx(() => this.store.event('model_call', callId, 'cancelled', { task_id: req.task_id, billing: definitelyNotBilled ? 'not_billed' : 'uncertain' }));
        throw new ProviderWait('stopped', 'planner request was cancelled');
      }
      this.consecutiveFailures++;
      const retryAfter = Number(err?.headers?.get?.('retry-after') ?? err?.headers?.['retry-after'] ?? NaN);
      const backoff = Number.isFinite(retryAfter) ? retryAfter * 1000 : Math.min(15 * 60_000, 2_000 * 2 ** Math.min(8, this.consecutiveFailures));
      if (status === 429 || status === 529 || (status && status >= 500) || status === undefined) this.retryAt = Date.now() + backoff;
      this.store.tx(() => this.store.event('model_call', callId, 'failed', { status: status ?? null, error: redact(String(err?.message ?? err)).slice(0, 300), retry_in_ms: backoff }));
      if (status === 401 || status === 403) throw new ProviderWait('auth', 'provider rejected the credential; re-enter it in Billy settings');
      if (status === 429) throw new ProviderWait('rate_limited', 'provider rate limit', new Date(this.retryAt).toISOString());
      throw new ProviderWait('unavailable', `provider error ${status ?? 'network'}`, new Date(this.retryAt).toISOString());
    }
    this.consecutiveFailures = 0;
    let cost = 0;
    if (out.usage_by_model?.length) for (const u of out.usage_by_model) cost += costMicros(u.model, u.usage) ?? Math.ceil(u.usage.input_tokens * WORST.in + u.usage.output_tokens * WORST.out);
    else cost = costMicros(out.model, out.usage) ?? Math.ceil(out.usage.input_tokens * WORST.in + out.usage.output_tokens * WORST.out);
    this.budget.settle(reservation, cost);
    this.store.tx(() => this.store.event('model_call', callId, 'completed', { model: out.model, stop_reason: out.stop_reason, usage: out.usage, cost_micros: cost }));
    if (req.signal?.aborted) throw new ProviderWait('stopped', 'planner request was cancelled');
    if (out.stop_reason === 'refusal') throw new ProviderOutputError(`model declined: ${out.refusal ?? 'refusal'}`);
    if (out.stop_reason === 'max_tokens') throw new ProviderOutputError('model output truncated at max_tokens');
    let json: unknown;
    try { json = JSON.parse(out.text); } catch { throw new ProviderOutputError('model returned non-JSON output'); }
    return { json, raw_text: out.text, model: out.model, stop_reason: out.stop_reason, usage: out.usage, cost_micros: cost, call_id: callId };
  }
}
