import type { Condition, ToolSpec } from '../contracts/action.ts';
import type { Store } from '../store/db.ts';

export interface AdapterContext {
  store: Store;
  attemptId: string;
  taskId: string;
  deviceId: string;
  signal: AbortSignal;
  /** Opaque per-broker services (desktop session, http agent, etc.). */
  services: Record<string, unknown>;
}

export interface ResolvedTarget {
  resource_id: string;
  account_id: string | null;
  facts: {
    recipient?: string; secret_ref?: string; file_path?: string; file_paths?: string[]; app?: string; apps?: string[]; host?: string; account_id?: string | null;
    protected_kind?: string | null; spend_scope?: string | null; egress_provider?: string | null;
  };
  claims: { resource_key: string; mode: 'shared' | 'exclusive' }[];
  /** Identity facts that must be unchanged at dispatch time (e.g. root dev:ino). */
  fingerprint?: string;
}

export interface CheckResult { ok: boolean; reason?: string; evidence?: unknown; wait?: 'WAITING_USER_SESSION' | 'WAITING_RESOURCE' | 'WAITING_PERMISSION' }

export interface DispatchResult {
  outcome: 'success' | 'failure' | 'unknown';
  receipt?: unknown;
  error?: string;
  retryable?: boolean;
  usage_micros?: number | 'unknown';
}

export interface VerifyResult { verdict: 'verified' | 'failed' | 'inconclusive'; evidence: unknown }
export interface ReconcileResult { status: 'applied' | 'not_applied' | 'unknown'; evidence: unknown }

export interface ToolAdapter {
  spec: ToolSpec;
  resolve(args: any, ctx: Omit<AdapterContext, 'attemptId'>): ResolvedTarget;
  fingerprint?(resolved: ResolvedTarget): string | undefined;
  /** Lexical paths named by the arguments; checked against grant roots BEFORE any filesystem access. */
  paths?(args: any): string[];
  preconditions(args: any, resolved: ResolvedTarget, ctx: Omit<AdapterContext, 'attemptId'>): CheckResult;
  postconditions(args: any, resolved: ResolvedTarget): Condition[];
  estimateMicros?(args: any): number;
  dispatch(args: any, resolved: ResolvedTarget, ctx: AdapterContext): Promise<DispatchResult>;
  verify(args: any, resolved: ResolvedTarget, post: Condition[], receipt: unknown, ctx: AdapterContext): Promise<VerifyResult>;
  reconcile(args: any, resolved: ResolvedTarget, post: Condition[], ctx: AdapterContext): Promise<ReconcileResult>;
}

export class TargetError extends Error {}
