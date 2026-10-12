// Task and action lifecycle state machines (handoff §7.2, §7.3).
// The tables are the single source of truth for legal transitions; the store
// refuses any transition not listed here.

export const WAITING = [
  'WAITING_DEPENDENCY', 'WAITING_RESOURCE', 'WAITING_PERMISSION', 'WAITING_BUDGET',
  'WAITING_PROVIDER', 'WAITING_USER_SESSION',
] as const;

export const TASK_STATES = [
  'RECEIVED', 'PLANNING', 'READY', 'RUNNING', 'VERIFYING', 'COMPLETED', 'RECOVERING',
  'RECONCILING', ...WAITING, 'PAUSED_BY_OWNER', 'CANCEL_REQUESTED', 'CANCELLED', 'FAILED',
  'BLOCKED_EXTERNAL',
] as const;
export type TaskState = typeof TASK_STATES[number];

const W = [...WAITING] as TaskState[];
const interruptible: TaskState[] = ['PAUSED_BY_OWNER', 'CANCEL_REQUESTED'];

export const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  RECEIVED: ['PLANNING', 'BLOCKED_EXTERNAL', 'FAILED', ...W, ...interruptible],
  PLANNING: ['READY', 'BLOCKED_EXTERNAL', 'FAILED', 'VERIFYING', ...W, ...interruptible],
  READY: ['RUNNING', 'PLANNING', 'BLOCKED_EXTERNAL', ...W, ...interruptible],
  RUNNING: ['VERIFYING', 'PLANNING', 'RECOVERING', 'RECONCILING', 'FAILED', ...W, ...interruptible],
  VERIFYING: ['COMPLETED', 'READY', 'PLANNING', 'RECOVERING', 'RECONCILING', 'FAILED', 'CANCEL_REQUESTED', 'PAUSED_BY_OWNER', 'WAITING_DEPENDENCY'],
  RECOVERING: ['READY', 'PLANNING', 'FAILED', 'BLOCKED_EXTERNAL', ...W, ...interruptible],
  RECONCILING: ['VERIFYING', 'READY', 'PLANNING', 'BLOCKED_EXTERNAL', 'CANCEL_REQUESTED', 'PAUSED_BY_OWNER'],
  WAITING_DEPENDENCY: ['READY', 'PLANNING', 'FAILED', 'BLOCKED_EXTERNAL', ...interruptible],
  WAITING_RESOURCE: ['READY', 'PLANNING', 'FAILED', 'BLOCKED_EXTERNAL', ...interruptible],
  WAITING_PERMISSION: ['READY', 'PLANNING', 'FAILED', 'BLOCKED_EXTERNAL', ...interruptible],
  WAITING_BUDGET: ['READY', 'PLANNING', 'FAILED', 'BLOCKED_EXTERNAL', ...interruptible],
  WAITING_PROVIDER: ['READY', 'PLANNING', 'FAILED', 'BLOCKED_EXTERNAL', ...interruptible],
  WAITING_USER_SESSION: ['READY', 'PLANNING', 'FAILED', 'BLOCKED_EXTERNAL', ...interruptible],
  PAUSED_BY_OWNER: ['READY', 'PLANNING', 'CANCEL_REQUESTED'],
  CANCEL_REQUESTED: ['CANCELLED'],
  BLOCKED_EXTERNAL: ['READY', 'PLANNING', 'FAILED', 'CANCEL_REQUESTED', 'PAUSED_BY_OWNER'],
  COMPLETED: [],
  CANCELLED: [],
  FAILED: [],
};

export const TASK_TERMINAL: ReadonlySet<TaskState> = new Set(['COMPLETED', 'CANCELLED', 'FAILED']);

export const ACTION_STATES = [
  'PROPOSED', 'VALIDATED', 'AUTHORIZED', 'PREPARED', 'DISPATCHING', 'OBSERVED_SUCCESS',
  'DEFINITE_FAILURE', 'OUTCOME_UNKNOWN', 'VERIFIED', 'RETRY_ELIGIBLE', 'FAILED', 'RECONCILING',
  'PROVEN_NOT_APPLIED', 'UNRESOLVED', 'COMMITTED', 'REJECTED', 'CANCELLED',
] as const;
export type ActionState = typeof ACTION_STATES[number];

export const ACTION_TRANSITIONS: Record<ActionState, readonly ActionState[]> = {
  PROPOSED: ['VALIDATED', 'REJECTED'],
  VALIDATED: ['AUTHORIZED', 'REJECTED'],
  AUTHORIZED: ['PREPARED', 'REJECTED', 'CANCELLED'],
  PREPARED: ['DISPATCHING', 'REJECTED', 'CANCELLED'],
  DISPATCHING: ['OBSERVED_SUCCESS', 'DEFINITE_FAILURE', 'OUTCOME_UNKNOWN'],
  OBSERVED_SUCCESS: ['VERIFIED', 'FAILED', 'RECONCILING'],
  DEFINITE_FAILURE: ['RETRY_ELIGIBLE', 'FAILED'],
  OUTCOME_UNKNOWN: ['RECONCILING'],
  RECONCILING: ['VERIFIED', 'PROVEN_NOT_APPLIED', 'UNRESOLVED', 'FAILED'],
  PROVEN_NOT_APPLIED: ['RETRY_ELIGIBLE', 'FAILED'],
  UNRESOLVED: ['RECONCILING'],
  VERIFIED: ['COMMITTED'],
  RETRY_ELIGIBLE: [],
  FAILED: [],
  COMMITTED: [],
  REJECTED: [],
  CANCELLED: [],
};

/** States in which an external effect may have happened and is not yet settled. */
export const ACTION_UNSETTLED: ReadonlySet<ActionState> = new Set([
  'DISPATCHING', 'OBSERVED_SUCCESS', 'OUTCOME_UNKNOWN', 'RECONCILING', 'UNRESOLVED',
]);
export const ACTION_TERMINAL: ReadonlySet<ActionState> = new Set([
  'RETRY_ELIGIBLE', 'FAILED', 'COMMITTED', 'REJECTED', 'CANCELLED',
]);

export class IllegalTransition extends Error {
  constructor(kind: string, from: string, to: string) {
    super(`illegal ${kind} transition ${from} -> ${to}`);
  }
}

export function checkTask(from: TaskState, to: TaskState): void {
  if (!TASK_TRANSITIONS[from]?.includes(to)) throw new IllegalTransition('task', from, to);
}

export function checkAction(from: ActionState, to: ActionState): void {
  if (!ACTION_TRANSITIONS[from]?.includes(to)) throw new IllegalTransition('action', from, to);
}
