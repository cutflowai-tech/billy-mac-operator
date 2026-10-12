// Controlled fault injection at named persistence boundaries.
// Active only when BILLY_FAULT_POINTS is set (test harness); each entry is
// "<point>[:<nth>]" and kills the process with SIGKILL the nth time the
// point is reached (default first). Release builds still contain the hook so
// qualification exercises the shipped code path, but it is inert unless the
// environment variable is present.

const spec = new Map<string, number>();
const hits = new Map<string, number>();
for (const raw of (process.env.BILLY_FAULT_POINTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
  const [p, n] = raw.split(':');
  spec.set(p, n ? Number(n) : 1);
}

export const FAULT_POINTS = [
  'broker.before_intent_commit',
  'broker.after_prepared',
  'broker.after_dispatching',
  'broker.after_adapter_call',
  'broker.after_outcome_record',
  'broker.after_verify',
  'broker.before_commit',
  'scheduler.after_claim',
  'scheduler.after_task_running',
  'outbox.after_sending_mark',
  'outbox.after_send',
  'worker.after_spawn_record',
  'worker.before_result',
  'stop.after_latch',
  'reconcile.mid',
  'telegram.after_handle',
] as const;
export type FaultPoint = typeof FAULT_POINTS[number];

export function fault(point: FaultPoint): void {
  if (!spec.size) return;
  const n = (hits.get(point) ?? 0) + 1;
  hits.set(point, n);
  if (spec.get(point) === n) {
    process.stderr.write(`FAULT_INJECTED ${point} ${n}\n`);
    process.kill(process.pid, 'SIGKILL');
  }
}
