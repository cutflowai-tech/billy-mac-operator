import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, symlinkSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, scope } from '../fixtures.ts';
import { fsWrite } from '../../src/tools/fs.ts';
import type { ToolAdapter } from '../../src/broker/types.ts';
import { CycleError } from '../../src/tasks/tasks.ts';

const h = (s: string) => createHash('sha256').update(s).digest('hex');
const attempts = (fx: any) => fx.core.store.db.prepare('SELECT status, tool_id FROM attempts').all() as any[];

test('T-ACTION-01: malformed / unknown / oversized requests fail before any effect', async () => {
  const fx = fixture();
  try {
    const id = fx.task(); fx.run(id);
    const target = join(fx.root, 'a.txt');
    const cases: [string, any][] = [
      ['unknown field', { path: target, content: 'x', mode: 'create', extra: 1 }],
      ['wrong type', { path: target, content: 42, mode: 'create' }],
      ['missing field', { path: target, content: 'x' }],
      ['bad enum', { path: target, content: 'x', mode: 'append' }],
      ['relative path', { path: 'a.txt', content: 'x', mode: 'create' }],
      ['oversized', { path: target, content: 'x'.repeat(16 * 1024 * 1024 + 1), mode: 'create' }],
    ];
    for (const [name, args] of cases) {
      const r = await fx.core.broker.submit(fx.proposal(id, 'fs.write', args, name));
      assert.equal(r.verdict, 'REJECTED', name);
    }
    const unknownTool = await fx.core.broker.submit(fx.proposal(id, 'shell.exec', { cmd: 'touch x' }, 'u'));
    assert.equal(unknownTool.verdict, 'REJECTED');
    const badVersion = await fx.core.broker.submit({ ...fx.proposal(id, 'fs.write', { path: target, content: 'x', mode: 'create' }, 'v'), tool_version: 99 });
    assert.equal(badVersion.verdict, 'REJECTED');
    assert.equal(existsSync(target), false);
    assert.equal(attempts(fx).length, 0, 'no attempt record means no dispatch path was entered');
  } finally { fx.cleanup(); }
});

test('happy path: verified atomic write, then semantic dedup (no second effect)', async () => {
  const fx = fixture();
  try {
    const id = fx.task(); fx.run(id);
    const target = join(fx.root, 'report.txt');
    const p = fx.proposal(id, 'fs.write', { path: target, content: 'hello', mode: 'create' }, 'write-report');
    const r1 = await fx.core.broker.submit(p);
    assert.equal(r1.verdict, 'COMMITTED', r1.reason);
    assert.equal(readFileSync(target, 'utf8'), 'hello');
    const r2 = await fx.core.broker.submit(p);
    assert.equal(r2.verdict, 'DEDUPLICATED');
    assert.equal(attempts(fx).length, 1);
    const journal = fx.core.store.db.prepare(`SELECT json_extract(payload_json,'$.to') t FROM events WHERE entity_id=? AND kind='transition' ORDER BY seq`).all(r1.attempt_id!) as any[];
    assert.deepEqual(journal.map((j) => j.t), ['VALIDATED', 'AUTHORIZED', 'PREPARED', 'DISPATCHING', 'OBSERVED_SUCCESS', 'VERIFIED', 'COMMITTED']);
  } finally { fx.cleanup(); }
});

test('T-ACTION-04: tool reports success but wrote wrong bytes -> verification fails', async () => {
  const liar: ToolAdapter = { ...fsWrite, spec: { ...fsWrite.spec, tool_id: 'fs.write_liar' },
    async dispatch(a, r) { writeFileSync(r.facts.file_path!, String(a.content).toUpperCase()); return { outcome: 'success', receipt: { claimed: 'ok' } }; } };
  const fx = fixture({ extraTools: [liar] });
  try {
    const id = fx.task(); fx.run(id);
    const target = join(fx.root, 'out.txt');
    const r = await fx.core.broker.submit(fx.proposal(id, 'fs.write_liar', { path: target, content: 'abc', mode: 'create' }, 's'));
    assert.equal(r.verdict, 'FAILED');
    const ev = r.evidence as any[];
    assert.equal(ev[0].c.sha256, h('abc'));
    assert.equal(ev[0].got, h('ABC'));
  } finally { fx.cleanup(); }
});

test('T-ACTION-08: planner postconditions add to, never replace, tool postconditions; criteria bound to revision', async () => {
  const fx = fixture();
  try {
    const id = fx.task(); fx.run(id);
    const target = join(fx.root, 'r.txt');
    // Planner tries to declare an "easier" postcondition; the tool's own digest condition still binds.
    const liar: ToolAdapter = { ...fsWrite, spec: { ...fsWrite.spec, tool_id: 'fs.write_short' },
      async dispatch(_a, r) { writeFileSync(r.facts.file_path!, 'partial'); return { outcome: 'success' }; } };
    fx.core.registry.register(liar);
    const p = { ...fx.proposal(id, 'fs.write_short', { path: target, content: 'full content', mode: 'create' }, 's'),
      postconditions: [{ kind: 'file_contains', path: target, text: 'partial' }] };
    const r = await fx.core.broker.submit(p);
    assert.equal(r.verdict, 'FAILED');
    const d1 = fx.tasks.criteriaDigest(id, 1);
    assert.equal(fx.tasks.get(id).success_criteria_digest, d1);
  } finally { fx.cleanup(); }
});

test('T-ACTION-10 (part): stale revision and cancelled generation are rejected at the broker', async () => {
  const fx = fixture();
  try {
    const id = fx.task(); fx.run(id);
    const old = fx.proposal(id, 'fs.write', { path: join(fx.root, 'a'), content: 'x', mode: 'create' }, 'a');
    fx.tasks.revise(id, 'new goal', { description: 'v2', postconditions: [] }, 'cmd-2');
    const r = await fx.core.broker.submit(old);
    assert.equal(r.verdict, 'STALE');
    assert.equal(existsSync(join(fx.root, 'a')), false);
  } finally { fx.cleanup(); }
});

test('T-AGENT-06: cycle, self edge and duplicate edges are rejected; valid graph admitted', () => {
  const fx = fixture();
  try {
    const a = fx.task(), b = fx.task(), c = fx.task();
    fx.tasks.addEdge(a, b, 'depends_on');
    fx.tasks.addEdge(b, c, 'depends_on');
    assert.throws(() => fx.tasks.addEdge(c, a, 'depends_on'), CycleError);
    assert.throws(() => fx.tasks.addEdge(a, a, 'depends_on'), CycleError);
    assert.throws(() => fx.tasks.addEdge(a, b, 'depends_on'), /duplicate/);
    assert.equal(fx.tasks.dependenciesSatisfied(b), false);
    assert.equal(fx.tasks.dependenciesSatisfied(a), true);
  } finally { fx.cleanup(); }
});

test('fs.copy / fs.move / fs.trash: no clobber, verified, reversible', async () => {
  const trashHolder: Record<string, unknown> = {};
  const fx = fixture({ services: trashHolder });
  try {
    const id = fx.task(); fx.run(id);
    writeFileSync(join(fx.root, 'a.txt'), 'A');
    writeFileSync(join(fx.root, 'occupied.txt'), 'OWNER DATA');
    const c1 = await fx.core.broker.submit(fx.proposal(id, 'fs.copy', { from: join(fx.root, 'a.txt'), to: join(fx.root, 'occupied.txt') }, 'c1'));
    assert.equal(c1.verdict, 'REJECTED');
    assert.equal(readFileSync(join(fx.root, 'occupied.txt'), 'utf8'), 'OWNER DATA');
    const c2 = await fx.core.broker.submit(fx.proposal(id, 'fs.copy', { from: join(fx.root, 'a.txt'), to: join(fx.root, 'b.txt') }, 'c2'));
    assert.equal(c2.verdict, 'COMMITTED', c2.reason);
    const m = await fx.core.broker.submit(fx.proposal(id, 'fs.move', { from: join(fx.root, 'b.txt'), to: join(fx.root, 'c.txt') }, 'm'));
    assert.equal(m.verdict, 'COMMITTED', m.reason);
    assert.equal(existsSync(join(fx.root, 'b.txt')), false);
    const trash = join(fx.root, '.trash'); mkdirSync(trash); trashHolder.trashDir = trash;
    const t = await fx.core.broker.submit(fx.proposal(id, 'fs.trash', { path: join(fx.root, 'c.txt') }, 't'));
    assert.equal(t.verdict, 'COMMITTED', t.reason);
    const moved = (t.receipt as any).trashed_to;
    assert.equal(readFileSync(moved, 'utf8'), 'A');
  } finally { fx.cleanup(); }
});
