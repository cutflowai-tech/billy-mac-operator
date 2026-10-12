// Anthropic driver (official SDK). Transport only: the gateway owns budget,
// egress and retry policy, so SDK auto-retries are disabled (maxRetries: 0)
// to keep a single retry owner.
import Anthropic from '@anthropic-ai/sdk';
import type { CompletionRequest, ProviderDriver, Usage } from './gateway.ts';

export class AnthropicDriver implements ProviderDriver {
  readonly id = 'anthropic';
  private client: Anthropic;
  private refusalFallback: boolean;

  constructor(apiKey: string, opts: { refusalFallback?: boolean; baseURL?: string; timeoutMs?: number } = {}) {
    this.client = new Anthropic({ apiKey, maxRetries: 0, timeout: opts.timeoutMs ?? 120_000, ...(opts.baseURL ? { baseURL: opts.baseURL } : {}) });
    this.refusalFallback = opts.refusalFallback ?? true;
  }

  async listModels() {
    const out: { id: string; max_input_tokens?: number; max_tokens?: number }[] = [];
    for await (const m of this.client.models.list()) out.push({ id: m.id, max_input_tokens: (m as any).max_input_tokens, max_tokens: (m as any).max_tokens });
    return out;
  }

  async call(model: string, req: CompletionRequest) {
    const params: any = {
      model,
      max_tokens: req.max_tokens,
      // Stable system prompt first so the prefix caches across steps.
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      messages: req.messages,
      thinking: { type: 'adaptive' },
      output_config: { effort: req.effort, format: { type: 'json_schema', schema: req.schema } },
    };
    let res: any;
    if (this.refusalFallback) {
      res = await this.client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } as any, { signal: req.signal });
    } else {
      res = await this.client.messages.create(params, { signal: req.signal });
    }
    const text = (res.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    const usage: Usage = {
      input_tokens: res.usage?.input_tokens ?? 0, output_tokens: res.usage?.output_tokens ?? 0,
      cache_read_input_tokens: res.usage?.cache_read_input_tokens ?? 0, cache_creation_input_tokens: res.usage?.cache_creation_input_tokens ?? 0,
    };
    // When a fallback served part of the turn, price each iteration by its own model where reported.
    const iters = Array.isArray(res.usage?.iterations) ? res.usage.iterations : [];
    const usage_by_model = iters.filter((i: any) => i?.model && typeof i.input_tokens === 'number').map((i: any) => ({
      model: i.model, usage: { input_tokens: i.input_tokens, output_tokens: i.output_tokens ?? 0, cache_read_input_tokens: i.cache_read_input_tokens ?? 0, cache_creation_input_tokens: i.cache_creation_input_tokens ?? 0 },
    }));
    return { text, model: res.model, stop_reason: res.stop_reason, usage, usage_by_model: usage_by_model.length ? usage_by_model : undefined,
      refusal: res.stop_reason === 'refusal' ? (res.stop_details?.category ?? 'unspecified') : null };
  }
}
