// Redaction for every exposed output channel (logs, notifications, diagnostics,
// model-request audit). Registered secrets are replaced by exact match; common
// credential shapes are replaced by pattern. Redaction is a last line of
// defence: secrets are never intentionally placed in these channels.

const registered = new Set<string>();

export function registerSecret(value: string): void {
  if (value && value.length >= 6) registered.add(value);
}

export function forgetSecrets(): void { registered.clear(); }

const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]'],
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED]'],                       // Anthropic keys / OAuth tokens
  [/\bsk-(proj|svcacct|admin|live|test)?-?[A-Za-z0-9_-]{20,}/g, '[REDACTED]'], // sk- style keys
  [/\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g, '[REDACTED]'],               // Telegram bot tokens
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, '[REDACTED]'],                // GitHub tokens
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[REDACTED]'],               // Slack tokens
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[REDACTED]'],                      // Google API keys
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]'],                          // AWS access keys
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]'], // JWTs
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[REDACTED]@'], // credentials in URLs
  [/\b(cookie|set-cookie)(\s*[:=]\s*)[^\r\n]+/gi, '$1$2[REDACTED]'],
  [/(?<![A-Za-z0-9_-])(["']?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]'],
  [/BILLY_CANARY_[A-Za-z0-9]{8,}/g, '[REDACTED]'],                  // test canaries
];

export function redact(input: string): string {
  let s = input;
  for (const v of registered) s = s.split(v).join('[REDACTED]');
  for (const [p, rep] of PATTERNS) s = s.replace(p, rep);
  return s;
}

export function redactDeep<T>(v: T): T {
  if (typeof v === 'string') return redact(v) as unknown as T;
  if (Array.isArray(v)) return v.map(redactDeep) as unknown as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)])) as T;
  return v;
}
