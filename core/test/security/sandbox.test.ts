// T-SEC-03, T-SEC-07, T-SEC-11, T-AGENT-08 (process part): executed adversarial probes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fixture } from '../fixtures.ts';
import { procRun, killOwnedProcesses } from '../../src/tools/proc.ts';
import { runSandboxed, sandboxAvailable, PROFILE, selectedDeveloperDirectory } from '../../src/sandbox/seatbelt.ts';
import { processStart } from '../../src/sandbox/seatbelt.ts';

const RUNTIME = dirname(dirname(realpathSync(process.execPath)));
const NODE = join(RUNTIME, 'bin', 'node');
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

test('sandbox substrate is available on this host', () => { assert.equal(sandboxAvailable(), true); });

test('selected system developer toolchain is readable but not writable inside the sandbox', async () => {
  const fx = fixture();
  try {
    const developerDir = selectedDeveloperDirectory();
    assert.ok(!developerDir.includes('unavailable'), 'this coding test host has an installed trusted toolchain');
    const init = spawnSync('/usr/bin/git', ['init', '-q', fx.root], { encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    const commit = spawnSync('/usr/bin/git', ['-C', fx.root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'base'], { encoding: 'utf8' });
    assert.equal(commit.status, 0, commit.stderr);
    // Remove the legacy CLT rule: both CLT and full Xcode must work through the
    // selected, canonical developer-root parameter used by product execution.
    const profile = PROFILE.replace('(subpath "/Library/Developer/CommandLineTools")', '');
    const git = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '-D', `WS=${fx.root}`, '-D', `TMP=${fx.root}`, '-D', `RUNTIME_DIR=${RUNTIME}`, '-D', `DEVELOPER_DIR=${developerDir}`,
      '/usr/bin/git', 'rev-parse', 'HEAD'], { cwd: fx.root, env: { PATH: '/usr/bin:/bin', HOME: fx.root, DEVELOPER_DIR: developerDir }, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);
    assert.match(git.stdout.trim(), /^[0-9a-f]{40}$/);
    const probe = await runSandboxed({ argv: [NODE, '-e', `
const fs=require('fs'); const p=process.env.DEVELOPER_DIR;
const out={selected:p,read:fs.readdirSync(p).length};
try { fs.accessSync(p,fs.constants.W_OK); out.write='allowed'; } catch(e) {out.write=e.code;}
console.log(JSON.stringify(out));`], workspace: fx.root, runtimeDir: RUNTIME, timeoutMs: 5000, env: { DEVELOPER_DIR: fx.outside } });
    assert.equal(probe.exit_code, 0, probe.stderr);
    const facts = JSON.parse(probe.stdout);
    assert.equal(facts.selected, developerDir, 'task environment cannot select or broaden the trusted toolchain');
    assert.ok(facts.read > 0);
    assert.match(facts.write, /EACCES|EPERM/);
  } finally { fx.cleanup(); }
});

test('T-SEC-03: untrusted script cannot reach secrets, broker socket, unrelated files or network', async () => {
  const fx = fixture({ extraTools: [procRun(RUNTIME)] }, { tool_classes: ['file', 'process'] });
  // Host canaries outside the workspace.
  const canaryDir = join(fx.dir, 'host-private'); mkdirSync(canaryDir);
  const canary = join(canaryDir, 'canary.txt'); writeFileSync(canary, 'BILLY_CANARY_hostfile99');
  const sock = join(fx.dir, 'b.sock');
  let connected = 0;
  const srv = createServer(() => { connected++; }).listen(sock);
  const tcp = createServer(() => { connected++; }).listen(0, '127.0.0.1');
  await new Promise((r) => setTimeout(r, 50));
  const port = (tcp.address() as any).port;
  const before = sha(canary);
  const dbPath = join(fx.dir, 'data', 'billy.db');
  const probe = `
const fs=require('fs'),net=require('net'),cp=require('child_process');const out={};
const t=(k,f)=>{try{out[k]=String(f()).slice(0,60)}catch(e){out[k]='DENIED:'+(e.code||e.message).slice(0,40)}};
t('read_canary',()=>fs.readFileSync(${JSON.stringify(canary)},'utf8'));
t('write_canary',()=>{fs.writeFileSync(${JSON.stringify(canary)},'pwned');return 'WROTE'});
t('read_db',()=>fs.readFileSync(${JSON.stringify(dbPath)}).length);
t('read_ssh',()=>fs.readdirSync(${JSON.stringify(join(homedir(), '.ssh'))}).length);
t('read_keychains',()=>fs.readdirSync(${JSON.stringify(join(homedir(), 'Library/Keychains'))}).length);
t('read_billy_support',()=>fs.readdirSync(${JSON.stringify(join(homedir(), 'Library/Application Support'))}).length);
t('keychain_cli',()=>cp.execFileSync('/usr/bin/security',['find-generic-password','-s','com.billy.provider.anthropic','-w'],{stdio:'pipe'}).toString());
t('apple_events',()=>{const o=cp.execFileSync('/usr/bin/osascript',['-e','tell application "Finder" to get name of startup disk'],{stdio:'pipe'}).toString();return o.trim()?'CONTROLLED:'+o:'DENIED:empty'});
t('open_app',()=>cp.execFileSync('/usr/bin/open',['-a','Calculator'],{stdio:'pipe'}).toString()||'OPENED');
t('write_home',()=>{fs.writeFileSync(${JSON.stringify(join(homedir(), 'billy-sbx-escape.txt'))},'x');return 'WROTE'});
const done=()=>{fs.writeFileSync('probe.json',JSON.stringify(out));};
let pending=2;const fin=()=>{if(--pending===0)done()};
const s=net.connect(${JSON.stringify(sock)});s.on('connect',()=>{out.unix='CONNECTED';fin()});s.on('error',e=>{out.unix='DENIED:'+e.code;fin()});
const c=net.connect(${port},'127.0.0.1');c.on('connect',()=>{out.tcp='CONNECTED';fin()});c.on('error',e=>{out.tcp='DENIED:'+e.code;fin()});
`;
  try {
    const ws = join(fx.root, 'ws'); mkdirSync(ws);
    writeFileSync(join(ws, 'probe.js'), probe);
    const id = fx.task(); fx.run(id);
    const r = await fx.core.broker.submit(fx.proposal(id, 'proc.run', { workspace: ws, argv: [NODE, 'probe.js'], timeout_ms: 20000 }, 'probe'));
    assert.equal(r.verdict, 'COMMITTED', r.reason);
    const res = JSON.parse(readFileSync(join(ws, 'probe.json'), 'utf8'));
    for (const [k, v] of Object.entries(res)) assert.match(String(v), /DENIED|Operation not permitted|EPERM|EACCES|not found|Unable/i, `${k} escaped: ${v}`);
    assert.equal(sha(canary), before, 'host canary unchanged');
    assert.equal(connected, 0, 'no socket connection reached the host');
    assert.equal(existsSync(join(homedir(), 'billy-sbx-escape.txt')), false);
    writeFileSync(join(fx.dir, '..', 'sbx-probe-' + process.pid + '.json'), JSON.stringify(res));
  } finally { srv.close(); tcp.close(); fx.cleanup(); }
});

test('T-SEC-11: worker code cannot rewrite policy storage, broker code, release baseline or ledger', async () => {
  const fx = fixture({ extraTools: [procRun(RUNTIME)] }, { tool_classes: ['file', 'process'] });
  const repo = realpathSync(join(import.meta.dirname, '..', '..', '..'));
  const protectedFiles = [join(fx.dir, 'data', 'billy.db'), join(repo, 'core/src/broker/broker.ts'), join(repo, 'release/requirements.manifest.json'), join(repo, 'execution/ledger.json')];
  const before = protectedFiles.map(sha);
  try {
    const ws = join(fx.root, 'ws'); mkdirSync(ws);
    const script = protectedFiles.map((p) => `try{require('fs').appendFileSync(${JSON.stringify(p)},'\\nPWNED')}catch(e){}`).join('\n')
      + `\nrequire('fs').writeFileSync('report.json',JSON.stringify({complete:true,all_tests_passed:true}))`;
    writeFileSync(join(ws, 'evil.js'), script);
    const id = fx.task(); fx.run(id);
    const r = await fx.core.broker.submit(fx.proposal(id, 'proc.run', { workspace: ws, argv: [NODE, 'evil.js'] }, 'evil'));
    assert.equal(r.verdict, 'COMMITTED');
    assert.deepEqual(protectedFiles.map(sha), before, 'protected files unchanged');
    // The worker's self-written success report is just a file in its workspace: nothing reads it as evidence.
    assert.equal(JSON.parse(readFileSync(join(ws, 'report.json'), 'utf8')).complete, true);
  } finally { fx.cleanup(); }
});

test('T-SEC-07: tool-surface inventory has no unsandboxed execution route; denied effect is denied on every route', async () => {
  const fx = fixture({ extraTools: [procRun(RUNTIME)] }, { tool_classes: ['file', 'process'] });
  try {
    const tools = fx.core.registry.list().map((t) => ({ id: t.spec.tool_id, caps: t.spec.capabilities, exe: t.spec.executable_identity }));
    for (const t of tools) {
      assert.ok(!t.caps.includes('proc.unsandboxed') && !/shell|exec/i.test(t.id) || t.id === 'proc.run', `unexpected execution route ${t.id}`);
    }
    const procTool = tools.find((t) => t.id === 'proc.run')!;
    assert.match(procTool.exe, /sandbox profile sha256 [0-9a-f]{64}/);
    // Protected effect: write outside the granted root. Try every exposed route.
    const outsideFile = join(fx.outside, 'target.txt');
    const id = fx.task(); fx.run(id);
    const viaFs = await fx.core.broker.submit(fx.proposal(id, 'fs.write', { path: outsideFile, content: 'x', mode: 'create' }, 'a'));
    writeFileSync(join(fx.root, 'src'), 'x');
    const viaCopy = await fx.core.broker.submit(fx.proposal(id, 'fs.copy', { from: join(fx.root, 'src'), to: outsideFile }, 'b'));
    const viaMove = await fx.core.broker.submit(fx.proposal(id, 'fs.move', { from: join(fx.root, 'src'), to: outsideFile }, 'c'));
    const viaProcWs = await fx.core.broker.submit(fx.proposal(id, 'proc.run', { workspace: fx.outside, argv: ['/usr/bin/true'] }, 'd'));
    const ws = join(fx.root, 'w2'); mkdirSync(ws);
    const viaProcEscape = await fx.core.broker.submit(fx.proposal(id, 'proc.run', { workspace: ws, argv: ['/bin/sh', '-c', `echo x > ${outsideFile}`] }, 'e'));
    const viaUnlisted = await fx.core.broker.submit(fx.proposal(id, 'proc.run', { workspace: ws, argv: ['/usr/bin/osascript', '-e', '1'] }, 'f'));
    const forgedCore = await fx.core.broker.submit({ ...fx.proposal(id, 'fs.write', { path: join(fx.root, 'z'), content: 'x', mode: 'create' }, 'g'), core_key: 'guess' });
    assert.deepEqual([viaFs.verdict, viaCopy.verdict, viaMove.verdict, viaProcWs.verdict, viaUnlisted.verdict, forgedCore.verdict],
      ['DENIED', 'DENIED', 'DENIED', 'DENIED', 'DENIED', 'REJECTED']);
    assert.equal(viaProcEscape.verdict, 'COMMITTED'); // the process ran...
    assert.equal(existsSync(outsideFile), false, '...but the sandbox denied the write');
  } finally { fx.cleanup(); }
});

test('T-AGENT-08 (process part): cancel kills only owned process groups; a same-name unrelated process survives', async () => {
  const fx = fixture({ extraTools: [procRun(RUNTIME)] }, { tool_classes: ['file', 'process'] });
  const unrelated = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  try {
    const ws = join(fx.root, 'ws'); mkdirSync(ws);
    const id = fx.task(); fx.run(id);
    const run = fx.core.broker.submit(fx.proposal(id, 'proc.run', { workspace: ws, argv: ['/bin/sh', '-c', '/bin/sleep 30 & /bin/sleep 30'], timeout_ms: 60000 }, 'sleep'));
    for (let i = 0; i < 100 && !(fx.core.store.db.prepare('SELECT count(*) c FROM processes').get() as any).c; i++) await new Promise((r) => setTimeout(r, 20));
    const p = fx.core.store.db.prepare('SELECT * FROM processes').get() as any;
    assert.equal(processStart(p.pid), p.pid_start);
    const t0 = Date.now();
    fx.core.control.cancel(id, 'owner');
    const r = await run;
    const dt = Date.now() - t0;
    assert.ok(dt < 3000, `owned process group terminated promptly (${dt}ms)`);
    assert.ok(['COMMITTED', 'UNRESOLVED', 'STOPPED'].includes(r.verdict), `verdict ${r.verdict} ${r.reason}`);
    assert.equal(processStart(unrelated.pid!) !== null, true, 'unrelated same-name process untouched');
    // PID-reuse guard: a forged record with the wrong start time is never signalled.
    fx.core.store.db.prepare(`INSERT INTO processes VALUES ('x', ?, 'a', ?, 'Thu Jan  1 00:00:00 1970', ?, '/bin/sleep', ?, NULL, NULL)`).run(id, unrelated.pid!, unrelated.pid!, fx.core.store.now());
    const k = killOwnedProcesses(fx.core.store, [id]);
    assert.equal(k.skipped_reused, 1);
    assert.equal(processStart(unrelated.pid!) !== null, true);
  } finally { unrelated.kill(); fx.cleanup(); }
});
