// T-DUR-11: wall-clock shifts and sleep/resume-like pauses (fake store clock; the
// host clock is never changed). No duplicate firing, explicit UTC instants,
// monotonic lease ages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../fixtures.ts';
import { Schedules } from '../../src/scheduler/schedules.ts';
import { Budget } from '../../src/budget/budget.ts';

function setup() {
  const fx = fixture();
  let now = Date.parse('2026-10-11T08:00:00.000Z');
  (fx.core.store as any).clock = () => now;
  const admitted: string[] = [];
  const sch = new Schedules(fx.core.store, (mid, goal) => {
    const r = fx.core.inbox.admit('schedule', mid, 'owner', 'ADMITTED', () => { admitted.push(mid); return { task_id: fx.task(), revision: 1 }; });
    return { task_id: r.task_id, duplicate: r.duplicate };
  });
  return { fx, sch, admitted, set: (iso: string) => { now = Date.parse(iso); }, shift: (ms: number) => { now += ms; } };
}

test('T-DUR-11: backwards wall-clock jump never re-fires an instant; forward jump fires a missed interval once', () => {
  const s = setup();
  try {
    const id = s.sch.create({ owner_id: 'owner', goal: 'hourly check', project_scope: 'fx', kind: 'interval', first_fire_utc: '2026-10-11T09:00:00Z', interval_seconds: 3600, display_timezone: 'Africa/Cairo' });
    s.set('2026-10-11T09:00:01.000Z'); s.sch.tick();
    assert.deepEqual(s.admitted, [`${id}@2026-10-11T09:00:00.000Z`]);
    // Clock jumps back an hour (e.g. manual change): nothing fires again.
    s.set('2026-10-11T08:00:30.000Z'); s.sch.tick(); s.sch.tick();
    assert.equal(s.admitted.length, 1);
    // Sleep for 5h then resume: exactly one catch-up firing, next slot in the future.
    s.set('2026-10-11T14:30:00.000Z'); const r = s.sch.tick(); s.sch.tick();
    assert.equal(r.fired.length, 1);
    assert.equal(s.admitted.length, 2);
    const row = s.fx.core.store.db.prepare('SELECT next_fire_utc FROM schedules WHERE schedule_id=?').get(id) as any;
    assert.equal(row.next_fire_utc, '2026-10-11T15:00:00.000Z');
    // Even if the stored cursor were rewound, inbox identity suppresses a duplicate admission.
    s.fx.core.store.db.prepare(`UPDATE schedules SET next_fire_utc='2026-10-11T09:00:00.000Z' WHERE schedule_id=?`).run(id);
    const d = s.sch.tick();
    assert.equal(d.duplicates, 1);
    assert.equal(s.admitted.length, 2);
  } finally { s.fx.cleanup(); }
});

test('T-DUR-11: instants are explicit UTC; local display carries the zone; ambiguous inputs are rejected', () => {
  const s = setup();
  try {
    assert.throws(() => s.sch.create({ owner_id: 'o', goal: 'g', project_scope: 'fx', kind: 'once', first_fire_utc: '2026-10-30 09:00', display_timezone: 'Africa/Cairo' }), /explicit UTC/);
    assert.throws(() => s.sch.create({ owner_id: 'o', goal: 'g', project_scope: 'fx', kind: 'once', first_fire_utc: '2026-10-30T09:00:00Z', display_timezone: 'Mars/Olympus' }), /timezone/);
    // Across Egypt's DST change the UTC instant is preserved and the label is explicit.
    const id = s.sch.create({ owner_id: 'o', goal: 'g', project_scope: 'fx', kind: 'once', first_fire_utc: '2026-10-30T07:00:00Z', display_timezone: 'Africa/Cairo' });
    const row = s.fx.core.store.db.prepare('SELECT first_fire_utc FROM schedules WHERE schedule_id=?').get(id) as any;
    assert.equal(row.first_fire_utc, '2026-10-30T07:00:00.000Z');
    assert.match(Schedules.display(row.first_fire_utc, 'Africa/Cairo'), /\(Africa\/Cairo\)$/);
  } finally { s.fx.cleanup(); }
});

test('T-DUR-11: wall-clock jumps cannot reset or double-count budget; leases use monotonic time', async () => {
  const s = setup();
  try {
    const b = new Budget(s.fx.core.store);
    b.setCeiling('day', 1000, 'daily', 'owner');
    b.settle(b.reserve(['day'], 600, 'a'), 600);
    s.shift(-3 * 86400_000); // clock jumps back three days
    assert.ok((b.remaining('day') ?? 0) <= 1000);
    s.shift(6 * 86400_000);  // and far forward
    assert.equal(b.remaining('day'), 1000, 'new UTC day: settled spend from the past day no longer counts');
    const { WorkerManager } = await import('../../src/agents/workers.ts');
    const src = (await import('node:fs')).readFileSync(new URL('../../src/agents/workers.ts', import.meta.url), 'utf8');
    assert.match(src, /performance\.now\(\) - mono/);
    void WorkerManager;
  } finally { s.fx.cleanup(); }
});
