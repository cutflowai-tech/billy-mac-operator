// Deterministic policy engine (handoff §5.3, §5.5, §11.1, §11.4).
// No model output, memory record, retrieved content or child claim can create
// or broaden a grant: grants are only written by owner-authenticated paths.
import type { ResolvedTarget } from '../broker/types.ts';
import type { ActionEnvelope, ToolSpec } from '../contracts/action.ts';
import type { Schema } from '../contracts/schema.ts';
import { digest } from '../util/canon.ts';
import type { Store } from '../store/db.ts';

export type Decision = 'ALLOW' | 'DENY' | 'WAIT_PREREQUISITE' | 'NEEDS_NEW_OWNER_AUTHORITY';

export interface GrantScope {
  apps: string[];                 // bundle identifiers
  file_roots: string[];           // canonical absolute directories
  browser_profiles: string[];
  domains: string[];              // exact hostnames or "*.example.com"
  account_ids: string[];
  tool_classes: string[];
  allowed_effects: ('READ_ONLY' | 'IDEMPOTENT_WRITE' | 'NON_IDEMPOTENT_EFFECT')[];
  secret_references: string[];
  network_destinations: string[]; // host[:port]
  foreground: 'never' | 'when_idle' | 'allowed';
  spend_scopes: string[];
  protected_actions: string[];    // explicitly allowed protected action kinds (default none)
  delegation: { allowed: boolean; max_depth: number };
  model_egress: string[];         // provider ids allowed to receive private content
  /** Message recipients ("<endpoint>:<account>:<to>"); "*" = any (explicit owner choice). Absent = none. */
  recipients?: string[];
}

export const GRANT_SCOPE_SCHEMA: Schema = {
  type: 'object',
  required: ['apps', 'file_roots', 'browser_profiles', 'domains', 'account_ids', 'tool_classes',
    'allowed_effects', 'secret_references', 'network_destinations', 'foreground', 'spend_scopes',
    'protected_actions', 'delegation', 'model_egress'],
  properties: {
    apps: { type: 'array', maxItems: 64, items: { type: 'string', maxLength: 255 } },
    file_roots: { type: 'array', maxItems: 32, items: { type: 'string', pattern: '^/', maxLength: 1024 } },
    browser_profiles: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 255 } },
    domains: { type: 'array', maxItems: 64, items: { type: 'string', maxLength: 255 } },
    account_ids: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 255 } },
    tool_classes: { type: 'array', maxItems: 64, items: { type: 'string', maxLength: 64 } },
    allowed_effects: { type: 'array', maxItems: 3, items: { enum: ['READ_ONLY', 'IDEMPOTENT_WRITE', 'NON_IDEMPOTENT_EFFECT'] } },
    secret_references: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 255 } },
    network_destinations: { type: 'array', maxItems: 64, items: { type: 'string', maxLength: 255 } },
    foreground: { enum: ['never', 'when_idle', 'allowed'] },
    spend_scopes: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 128 } },
    protected_actions: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 64 } },
    delegation: {
      type: 'object', required: ['allowed', 'max_depth'],
      properties: { allowed: { type: 'boolean' }, max_depth: { type: 'integer', minimum: 0, maximum: 5 } },
    },
    model_egress: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 64 } },
    recipients: { type: 'array', maxItems: 200, items: { type: 'string', maxLength: 300 } },
  },
};

export interface Grant {
  grant_id: string;
  revision: number;
  owner_id: string;
  scope: GrantScope;
  scope_digest: string;
  parent_grant_id: string | null;
  task_id: string | null;
  expires_at: string;
  revoked_at: string | null;
  source: string;
}

const inter = (a: string[], b: string[]) => a.filter((x) => b.includes(x));

/** Child scope = parent ∩ requested (never larger than either). */
export function intersectScope(parent: GrantScope, requested: GrantScope): GrantScope {
  return {
    apps: inter(requested.apps, parent.apps),
    file_roots: requested.file_roots.filter((r) => parent.file_roots.some((p) => r === p || r.startsWith(p.endsWith('/') ? p : p + '/'))),
    browser_profiles: inter(requested.browser_profiles, parent.browser_profiles),
    domains: requested.domains.filter((d) => parent.domains.some((p) => domainMatches(p, d.replace(/^\*\./, '')) && (!d.startsWith('*.') || p.startsWith('*.')))),
    account_ids: inter(requested.account_ids, parent.account_ids),
    tool_classes: inter(requested.tool_classes, parent.tool_classes),
    allowed_effects: requested.allowed_effects.filter((e) => parent.allowed_effects.includes(e)),
    secret_references: inter(requested.secret_references, parent.secret_references),
    network_destinations: inter(requested.network_destinations, parent.network_destinations),
    foreground: rankFg(requested.foreground) <= rankFg(parent.foreground) ? requested.foreground : parent.foreground,
    spend_scopes: inter(requested.spend_scopes, parent.spend_scopes),
    protected_actions: inter(requested.protected_actions, parent.protected_actions),
    delegation: {
      allowed: requested.delegation.allowed && parent.delegation.allowed && parent.delegation.max_depth > 0,
      max_depth: Math.max(0, Math.min(requested.delegation.max_depth, parent.delegation.max_depth - 1)),
    },
    model_egress: inter(requested.model_egress, parent.model_egress),
    recipients: intersectRecipients(parent.recipients ?? [], requested.recipients ?? parent.recipients ?? []),
  };
}

function intersectRecipients(parent: string[], req: string[]): string[] {
  if (parent.includes('*')) return req;
  if (req.includes('*')) return parent;
  return req.filter((r) => parent.includes(r));
}

const rankFg = (f: GrantScope['foreground']) => ({ never: 0, when_idle: 1, allowed: 2 }[f]);

export function domainMatches(pattern: string, host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return h === p;
}

export function pathWithinRoots(canonicalPath: string, roots: string[]): string | null {
  for (const r of roots) {
    const root = r.endsWith('/') ? r.slice(0, -1) : r;
    if (canonicalPath === root || canonicalPath.startsWith(root + '/')) return root;
  }
  return null;
}

export class PolicyStore {
  private store: Store;
  constructor(store: Store) { this.store = store; }

  /** Owner-authenticated path only (local app / paired owner device). */
  putGrant(g: Omit<Grant, 'revision' | 'scope_digest' | 'revoked_at'> & { revision?: number }): Grant {
    return this.store.tx(() => {
      const prev = this.current(g.grant_id, true);
      if (prev?.revoked_at) throw new Error(`grant ${g.grant_id} is revoked; create a new grant instead of re-activating it`);
      if (g.parent_grant_id) {
        if (g.parent_grant_id === g.grant_id) throw new Error('grant cannot be its own parent');
        let cur: string | null = g.parent_grant_id; let depth = 0;
        while (cur) {
          if (cur === g.grant_id || ++depth > 8) throw new Error('invalid parent grant chain (cycle or too deep)');
          const p = this.current(cur, true);
          if (!p) throw new Error(`unknown parent grant ${cur}`);
          cur = p.parent_grant_id;
        }
      }
      const revision = prev ? prev.revision + 1 : 1;
      const scope_digest = digest(g.scope);
      this.store.db.prepare(`INSERT INTO grants(grant_id, revision, owner_id, scope_json, scope_digest, parent_grant_id,
        task_id, expires_at, revoked_at, created_at, source) VALUES (?,?,?,?,?,?,?,?,NULL,?,?)`)
        .run(g.grant_id, revision, g.owner_id, JSON.stringify(g.scope), scope_digest, g.parent_grant_id, g.task_id,
          g.expires_at, this.store.now(), g.source);
      this.store.event('grant', g.grant_id, 'revision', { revision, scope_digest, source: g.source });
      return { ...g, revision, scope_digest, revoked_at: null } as Grant;
    });
  }

  revoke(grantId: string, reason: string): void {
    this.store.tx(() => {
      this.store.db.prepare(`UPDATE grants SET revoked_at=? WHERE grant_id=? AND revoked_at IS NULL`).run(this.store.now(), grantId);
      // Revoking a parent revokes descendants.
      const kids = this.store.db.prepare(`SELECT DISTINCT grant_id FROM grants WHERE parent_grant_id=? AND revoked_at IS NULL`).all(grantId) as any[];
      this.store.event('grant', grantId, 'revoked', { reason });
      for (const k of kids) this.revoke(k.grant_id, `parent ${grantId} revoked`);
    });
  }

  current(grantId: string, includeRevoked = false): Grant | null {
    const r = this.store.db.prepare(`SELECT * FROM grants WHERE grant_id=? ORDER BY revision DESC LIMIT 1`).get(grantId) as any;
    if (!r) return null;
    if (r.revoked_at && !includeRevoked) return null;
    return {
      grant_id: r.grant_id, revision: r.revision, owner_id: r.owner_id, scope: JSON.parse(r.scope_json),
      scope_digest: r.scope_digest, parent_grant_id: r.parent_grant_id, task_id: r.task_id, expires_at: r.expires_at,
      revoked_at: r.revoked_at, source: r.source,
    };
  }

  /** Effective scope = intersection along the parent chain (defence in depth). */
  effective(grantId: string, depth = 0): Grant | null {
    if (depth > 8) return null;
    const g = this.current(grantId);
    if (!g) return null;
    if (!g.parent_grant_id) return g;
    const p = this.effective(g.parent_grant_id, depth + 1);
    if (!p) return null;
    const expires_at = p.expires_at < g.expires_at ? p.expires_at : g.expires_at;
    return { ...g, scope: intersectScope(p.scope, g.scope), expires_at };
  }
}

export interface DecisionResult { decision: Decision; reason: string }

/**
 * Pure authorization decision for one envelope at one instant.
 * `resolved` carries the canonical target facts produced by the tool adapter.
 */
export function decide(env: ActionEnvelope, tool: ToolSpec, grant: Grant | null, nowIso: string,
  resolved: ResolvedTarget['facts']): DecisionResult {
  if (!grant) return { decision: 'NEEDS_NEW_OWNER_AUTHORITY', reason: 'no valid grant (missing, revoked or superseded)' };
  if (grant.revision !== env.authority.policy_revision) {
    return { decision: 'DENY', reason: `stale policy revision ${env.authority.policy_revision} != ${grant.revision}` };
  }
  if (grant.expires_at <= nowIso) return { decision: 'NEEDS_NEW_OWNER_AUTHORITY', reason: 'grant expired' };
  const s = grant.scope;
  if (!s.tool_classes.includes(tool.tool_class)) {
    return { decision: 'NEEDS_NEW_OWNER_AUTHORITY', reason: `tool class ${tool.tool_class} not granted` };
  }
  if (!s.allowed_effects.includes(tool.effect_class)) {
    return { decision: 'NEEDS_NEW_OWNER_AUTHORITY', reason: `effect ${tool.effect_class} not granted` };
  }
  if (resolved.protected_kind && !s.protected_actions.includes(resolved.protected_kind)) {
    return { decision: 'DENY', reason: `protected action ${resolved.protected_kind} not authorized` };
  }
  if (tool.target_kind === 'file' || resolved.file_paths?.length) {
    const all = [resolved.file_path, ...(resolved.file_paths ?? [])].filter((x): x is string => !!x);
    if (!all.length || !all.every((p) => pathWithinRoots(p, s.file_roots))) {
      return { decision: 'DENY', reason: `path outside granted roots` };
    }
  }
  for (const app of [resolved.app, ...(resolved.apps ?? [])]) {
    if (app !== undefined && !s.apps.includes(app)) return { decision: 'DENY', reason: `app ${app} not granted` };
  }
  if (resolved.host !== undefined && !s.domains.some((d) => domainMatches(d, resolved.host!))
    && !s.network_destinations.includes(resolved.host)) {
    return { decision: 'DENY', reason: `destination ${resolved.host} not granted` };
  }
  if (resolved.secret_ref !== undefined && !s.secret_references.includes(resolved.secret_ref)) {
    return { decision: 'NEEDS_NEW_OWNER_AUTHORITY', reason: `credential ${resolved.secret_ref} is not granted to this task` };
  }
  if (resolved.recipient !== undefined) {
    const rec = s.recipients ?? [];
    if (!rec.includes('*') && !rec.includes(resolved.recipient)) return { decision: 'DENY', reason: 'recipient not in the owner-approved recipient list' };
  }
  if (resolved.account_id && !s.account_ids.includes(resolved.account_id)) {
    return { decision: 'DENY', reason: `account ${resolved.account_id} not granted` };
  }
  if (resolved.egress_provider && !s.model_egress.includes(resolved.egress_provider)) {
    return { decision: 'DENY', reason: `provider ${resolved.egress_provider} not authorized for this data` };
  }
  if (resolved.spend_scope && !s.spend_scopes.includes(resolved.spend_scope)) {
    return { decision: 'WAIT_PREREQUISITE', reason: `no budget scope ${resolved.spend_scope} in grant` };
  }
  return { decision: 'ALLOW', reason: 'within standing grant' };
}
