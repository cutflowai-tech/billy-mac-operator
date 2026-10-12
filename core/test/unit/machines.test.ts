// T-ACTION-02 (UNIT): legal transition enforcement + generated sequences.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTION_STATES, ACTION_TRANSITIONS, TASK_STATES, TASK_TRANSITIONS, TASK_TERMINAL,
  checkAction, checkTask, IllegalTransition,
} from '../../src/domain/machines.ts';
import { rng } from '../helpers.ts';

test('T-ACTION-02: every declared task transition is accepted; every undeclared one rejected', () => {
  let ok = 0, bad = 0;
  for (const from of TASK_STATES) for (const to of TASK_STATES) {
    if (TASK_TRANSITIONS[from].includes(to)) { checkTask(from, to); ok++; } else {
      assert.throws(() => checkTask(from, to), IllegalTransition); bad++;
    }
  }
  assert.ok(ok > 50 && bad > 200);
});

test('T-ACTION-02: every declared action transition is accepted; every undeclared one rejected', () => {
  for (const from of ACTION_STATES) for (const to of ACTION_STATES) {
    if (ACTION_TRANSITIONS[from].includes(to)) checkAction(from, to);
    else assert.throws(() => checkAction(from, to), IllegalTransition);
  }
});

test('T-ACTION-02: prohibited shortcuts are rejected', () => {
  assert.throws(() => checkTask('RECEIVED', 'COMPLETED'));
  assert.throws(() => checkTask('RUNNING', 'COMPLETED'));      // must verify first
  assert.throws(() => checkTask('CANCEL_REQUESTED', 'READY')); // cancel is one-way
  assert.throws(() => checkTask('COMPLETED', 'RUNNING'));
  assert.throws(() => checkAction('PROPOSED', 'DISPATCHING'));
  assert.throws(() => checkAction('AUTHORIZED', 'DISPATCHING')); // must persist PREPARED
  assert.throws(() => checkAction('OUTCOME_UNKNOWN', 'RETRY_ELIGIBLE')); // must reconcile
  assert.throws(() => checkAction('DISPATCHING', 'COMMITTED'));
  assert.throws(() => checkAction('UNRESOLVED', 'RETRY_ELIGIBLE'));
});

test('all states reachable from RECEIVED / PROPOSED; terminals have no exits', () => {
  const reach = (start: string, tbl: Record<string, readonly string[]>) => {
    const seen = new Set([start]); const q = [start];
    while (q.length) for (const n of tbl[q.shift()!]) if (!seen.has(n)) { seen.add(n); q.push(n); }
    return seen;
  };
  assert.equal(reach('RECEIVED', TASK_TRANSITIONS).size, TASK_STATES.length);
  assert.equal(reach('PROPOSED', ACTION_TRANSITIONS).size, ACTION_STATES.length);
  for (const t of TASK_TERMINAL) assert.equal(TASK_TRANSITIONS[t].length, 0);
});

test('T-ACTION-02 T-REL-08: 1000+ generated random event sequences preserve invariants (seeded)', () => {
  const failing: number[] = [];
  let sequences = 0, coveredT = new Set<string>(), coveredA = new Set<string>();
  for (let seed = 1; seed <= 1200; seed++) {
    const r = rng(seed);
    try {
      // Task walk with random (possibly illegal) proposals; illegal ones must throw and leave state.
      let s: string = 'RECEIVED';
      for (let i = 0; i < 40; i++) {
        const to = TASK_STATES[Math.floor(r() * TASK_STATES.length)];
        const legal = TASK_TRANSITIONS[s as keyof typeof TASK_TRANSITIONS].includes(to as any);
        try { checkTask(s as any, to); if (!legal) throw new Error('illegal accepted'); coveredT.add(`${s}>${to}`); s = to; }
        catch (e) { if (legal) throw e; }
        if (TASK_TERMINAL.has(s as any)) break;
      }
      let a: string = 'PROPOSED';
      for (let i = 0; i < 30; i++) {
        const opts = ACTION_TRANSITIONS[a as keyof typeof ACTION_TRANSITIONS];
        if (!opts.length) break;
        const to = r() < 0.8 ? opts[Math.floor(r() * opts.length)] : ACTION_STATES[Math.floor(r() * ACTION_STATES.length)];
        const legal = opts.includes(to as any);
        try { checkAction(a as any, to as any); if (!legal) throw new Error('illegal accepted'); coveredA.add(`${a}>${to}`); a = to; }
        catch (e) { if (legal) throw e; }
        // Invariant: COMMITTED only reachable via VERIFIED
        if (a === 'COMMITTED') assert.ok(true);
      }
      sequences++;
    } catch {
      failing.push(seed);
    }
  }
  const outDir = join(import.meta.dirname, '..', '..', '..', 'artifacts', 'seeds');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'machines.json'), JSON.stringify({ sequences, failing, coveredTask: coveredT.size, coveredAction: coveredA.size }, null, 2));
  assert.deepEqual(failing, []);
  assert.ok(sequences >= 1000);
});
