// billyd: the per-user Billy core service. Started by launchd (registered by
// Billy.app via SMAppService) or manually for development.
//   node main.ts [--data-dir <dir>] [--allow-unsafe-location]
import { join, dirname } from 'node:path';
import { mkdirSync, realpathSync } from 'node:fs';
import { Core } from '../core.ts';
import { defaultDataDir, CorruptionError, InstanceLockedError } from '../store/db.ts';
import { LocalApi, ApiError } from './api.ts';
import { installRoutes, admitOwnerCommand, type RouteDeps } from './routes.ts';
import { loadConfig, saveConfig, type BillyConfig } from './config.ts';
import { Keychain, KNOWN_REFS, type SecretStore } from '../secrets/keychain.ts';
import { apiSendMessage } from '../tools/api.ts';
import { procRun } from '../tools/proc.ts';
import { DESKTOP_TOOLS, type DesktopServices } from '../tools/desktop.ts';
import { agentDelegate, agentCollect } from '../tools/agents.ts';
import { memorySearch, memoryNote } from '../tools/memory.ts';
import { codeIntegrate } from '../tools/integrate.ts';
import { webFetch } from '../tools/web.ts';
import { Memory, ownerAuth } from '../memory/memory.ts';
import { ModelGateway, type ProviderDriver } from '../ai/gateway.ts';
import { AnthropicDriver } from '../ai/anthropic.ts';
import { ModelPlanner } from '../planner/model.ts';
import { FrozenCriteriaVerifier } from '../verify/frozen.ts';
import { WorkerManager } from '../agents/workers.ts';
import { DesktopArbiter, MacSessionProbe, type SessionProbe } from '../desktop/session.ts';
import { SocketTransport, launchPrivateDaemon, stopPrivateDaemon, verifyPin } from '../desktop/cua.ts';
import { TelegramRemote, BotApi, type TelegramTransport } from '../remote/telegram.ts';
import { Retention } from '../memory/retention.ts';
import type { Check } from './doctor.ts';
import { Schedules } from '../scheduler/schedules.ts';
import { BackupManager, KeychainKeyProvider, StaticKeyProvider, type KeyProvider } from '../store/backup.ts';
import { tmpdir } from 'node:os';
import { doctor } from './doctor.ts';
import { redactDeep } from '../util/redact.ts';

export const VERSION = '0.1.0';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export interface DaemonOverrides {
  secrets?: SecretStore;
  providerDriver?: ProviderDriver | null;   // tests inject a fake; null disables
  telegramTransport?: TelegramTransport | null;
  sessionProbe?: SessionProbe;
  desktopTransportPath?: string;            // tests: fake Cua socket; skips launching the real driver
  workerOptions?: Partial<import('../agents/workers.ts').WorkerOptions>;
  runtimeDir?: string;
  backupKeys?: KeyProvider;
}

export interface Daemon { core: Core; api: LocalApi; cfg: BillyConfig; workers: WorkerManager; telegram: TelegramRemote | null; gateway: ModelGateway; stop: () => Promise<void> }

export async function startDaemon(dataDir: string, allowUnsafe = false, ov: DaemonOverrides = {}): Promise<Daemon> {
  process.umask(0o077);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const cfg = loadConfig(dataDir);
  const secrets = ov.secrets ?? new Keychain();
  const runDir = join(dataDir, 'run');
  const runtimeDir = ov.runtimeDir ?? dirname(dirname(realpathSync(process.execPath)));
  const services: Record<string, unknown> = { endpoints: new Map((cfg.endpoints ?? []).map((e) => [e.id, e])), secrets };
  const gateway = new ModelGateway(null as any, null as any, null, { roles: { planner: cfg.provider.planner_model ?? 'claude-opus-5-5' }, refusalFallback: true });

  const core = new Core({
    dir: dataDir, allowUnsafeLocation: allowUnsafe, deviceId: cfg.device_id, maxConcurrent: 2, services,
    extraTools: [apiSendMessage, procRun(runtimeDir), codeIntegrate(runtimeDir), ...DESKTOP_TOOLS, agentDelegate, agentCollect, memorySearch, memoryNote],
  });
  core.registry.register(webFetch(core.policy));
  (core.executor as any).d.verifier = new FrozenCriteriaVerifier(core.store);
  const memory = new Memory(core.store);
  services.memory = memory;
  mkdirSync(join(dataDir, 'evidence'), { recursive: true, mode: 0o700 });
  const retention = new Retention(core.store, join(dataDir, 'evidence'));

  // ---- AI provider (only with an owner-configured credential; never borrowed) ----
  Object.assign(gateway, { store: core.store, budget: core.budget });
  const configureProvider = () => {
    let driver: ProviderDriver | null = ov.providerDriver === undefined ? null : ov.providerDriver;
    if (ov.providerDriver === undefined && cfg.provider.kind === 'anthropic_api') {
      const key = secrets.get(KNOWN_REFS.anthropic);
      if (key) driver = new AnthropicDriver(key, { refusalFallback: true });
    }
    gateway.setDriver(driver);
    gateway.cfg.roles = { planner: cfg.provider.planner_model ?? 'claude-opus-5-5', fallback: cfg.provider.planner_model ?? 'claude-opus-5-5' };
    if (driver) core.executor.wake('provider_configured');
  };
  configureProvider();
  core.planners.set('model', new ModelPlanner({
    gateway, registry: core.registry, policy: core.policy,
    egress: (t?: any) => { const gid = t?.grant_id ?? cfg.default_grant_id; const g = gid ? core.policy.effective(gid) : null; return g?.scope.model_egress ?? []; },
    memoryContext: (t) => memory.contextFor(t.project_scope, t.goal, 4000),
    budgetScopes: (t) => {
      const g = t.grant_id ? core.policy.effective(t.grant_id) : null;
      return [...new Set([t.budget_scope, ...(g?.scope.spend_scopes ?? [])].filter((s): s is string => !!s && !!core.budget.ceiling(s)))];
    },
  }));

  // ---- Desktop (pinned Cua driver, private bounded daemon, human-coexistence arbiter) ----
  const arbiter = new DesktopArbiter(ov.sessionProbe ?? new MacSessionProbe());
  let cuaGen = 0;
  let cuaSocket = ov.desktopTransportPath ?? '';
  const desktop: DesktopServices = {
    transport: () => {
      if (!cuaSocket) {
        const g = cfg.default_grant_id ? core.policy.effective(cfg.default_grant_id) : null;
        if (!g) throw new ApiError(409, 'no standing grant');
        const h = launchPrivateDaemon(cfg.cua, runDir, g.scope, ++cuaGen);
        cuaSocket = h.socketPath;
        core.store.tx(() => core.store.event('desktop', 'cua', 'daemon_launched', { generation: cuaGen, manifest_sha256: h.manifestSha256 }));
      }
      return new SocketTransport(cuaSocket);
    },
    generation: () => cuaGen, arbiter, observations: new Map(), sessionId: 'billy',
    // The task's OWN effective grant decides (a child's narrower scope is respected).
    foreground: (taskId?: string) => {
      const gid = taskId ? (core.store.db.prepare('SELECT grant_id FROM tasks WHERE task_id=?').get(taskId) as any)?.grant_id : cfg.default_grant_id;
      const g = gid ? core.policy.effective(gid) : null;
      return g?.scope.foreground ?? 'never';
    },
    ocrPath: process.env.BILLY_OCR_PATH ?? join(dirname(dirname(dirname(realpathSync(process.execPath)))), 'bin', 'billy-ocr'),
  };
  /** A grant revision regenerates the driver manifest: restart the private daemon under a new generation. */
  const restartDesktop = (reason: string) => {
    if (cuaSocket && !ov.desktopTransportPath) { stopPrivateDaemon(cuaSocket); cuaSocket = ''; desktop.observations.clear(); core.store.tx(() => core.store.event('desktop', 'cua', 'daemon_retired', { generation: cuaGen, reason })); }
  };
  services.desktop = desktop;
  arbiter.onTakeover.push(() => { desktop.observations.clear(); });
  arbiter.start();

  // ---- Workers ----
  const workers = new WorkerManager(core, runDir, ov.workerOptions ?? {});
  services.workers = workers;

  // ---- Remote (Telegram) ----
  let telegram: TelegramRemote | null = null;
  const routeDeps: RouteDeps = { core, cfg, dataDir, secrets, startedAt: new Date().toISOString() };
  const setupTelegram = () => {
    if (!cfg.remote.telegram_enabled) return;
    let transport = ov.telegramTransport ?? null;
    if (ov.telegramTransport === undefined) { const tok = secrets.get(KNOWN_REFS.telegram); if (tok) transport = new BotApi(tok); }
    if (!transport) return;
    telegram = new TelegramRemote(core, transport, cfg.owner_id, (mid, sender, goal) => {
      const r = admitOwnerCommand(routeDeps, 'telegram', mid, sender, goal);
      return { task_id: r.task_id, duplicate: r.duplicate };
    });
    core.outbox.register(telegram.channel());
    for (const d of telegram.devices().filter((x) => !x.revoked_at)) core.notifyTargets.push({ channel: 'telegram', destination: d.platform_identity });
    telegram.onPaired.push((uid) => { if (!core.notifyTargets.some((t) => t.channel === 'telegram' && t.destination === uid)) core.notifyTargets.push({ channel: 'telegram', destination: uid }); });
    telegram.run().catch(() => {});
  };
  const stopTelegram = () => { telegram?.stop(); telegram = null; core.notifyTargets = core.notifyTargets.filter((t) => t.channel !== 'telegram'); };
  setupTelegram();

  const schedules = new Schedules(core.store, (mid, goal, scope) => {
    const r = admitOwnerCommand(routeDeps, 'schedule', mid, cfg.owner_id, goal, { project_scope: scope });
    return { task_id: r.task_id, duplicate: r.duplicate };
  });
  const rec = await core.recover();
  const api = new LocalApi(core, runDir);
  routeDeps.onConfigChanged = (c) => { Object.assign(cfg, c); configureProvider(); };
  routeDeps.onGrantChanged = () => restartDesktop('grant revised');
  let permCache: { at: number; check: Check } | null = null;
  const permissionCheck = (): Check => {
    if (permCache && Date.now() - permCache.at < 10_000) return permCache.check;
    let check: Check = { id: 'desktop.permissions', capability: 'Accessibility + Screen Recording for CuaDriver', status: 'unknown',
      detail: 'not checked yet: the driver reports its own TCC state only while its daemon runs', fix: 'cua-driver permissions grant (setup packet S3)', blocks: ['REQ-11', 'REQ-12'] };
    if (cuaSocket) {
      new SocketTransport(cuaSocket).call('check_permissions', {}, 'billy-doctor', 5000).then((resp) => {
        const sc = resp?.result?.structuredContent ?? {};
        const ax = sc.accessibility ?? sc.accessibility_granted; const sr = sc.screen_recording ?? sc.screen_recording_granted;
        const ok = (v: unknown) => v === true || v === 'granted';
        permCache = { at: Date.now(), check: { ...check, status: ok(ax) && ok(sr) ? 'ok' : 'fail', detail: `accessibility=${JSON.stringify(ax)} screen_recording=${JSON.stringify(sr)}` } };
      }).catch(() => {});
    }
    return check;
  };
  routeDeps.extraChecks = (): Check[] => {
    const pin = verifyPin(cfg.cua);
    const f = arbiter.facts();
    return [permissionCheck(),
      { id: 'desktop.session', capability: 'interactive session', status: f.locked ? 'warn' : 'ok', detail: f.locked ? 'screen locked: GUI work waits' : `unlocked, owner idle ${Math.round(f.idle_ms / 1000)}s` },
      { id: 'desktop.driver', capability: 'native control driver', status: pin.ok ? (cuaSocket ? 'ok' : 'warn') : 'fail', detail: pin.ok ? (cuaSocket ? `private bounded daemon generation ${cuaGen}` : 'pinned; daemon starts on first desktop task') : 'driver binary does not match pin', fix: 'cua-driver permissions grant (setup packet S3)' },
      { id: 'provider.models', capability: 'AI provider', status: gateway.providerId ? 'ok' : 'fail', detail: gateway.providerId ? `${gateway.providerId}, planner ${gateway.cfg.roles.planner}` : 'no provider configured' },
    ];
  };
  installRoutes(api, routeDeps);
  api.route('POST', /^\/v1\/schedules$/, ({ body }) => {
    try { return { status: 201, body: { schedule_id: schedules.create({ owner_id: cfg.owner_id, goal: String(body?.goal ?? ''), project_scope: body?.project_scope ?? cfg.default_project_scope, kind: body?.kind, first_fire_utc: String(body?.first_fire_utc ?? ''), interval_seconds: body?.interval_seconds, display_timezone: body?.display_timezone ?? cfg.timezone }) } }; }
    catch (e) { throw new ApiError(400, (e as Error).message); }
  });
  api.route('GET', /^\/v1\/schedules$/, () => ({ body: (core.store.db.prepare('SELECT * FROM schedules ORDER BY created_at DESC').all() as any[]).map((s) => ({ ...s, next_fire_display: s.next_fire_utc ? Schedules.display(s.next_fire_utc, s.display_timezone) : null })) }));
  // Test-only key: honoured solely for data directories inside the system temp dir, never for a real install.
  const testKeyHex = process.env.BILLY_TEST_BACKUP_KEY_HEX;
  const inTmp = [realpathSync(tmpdir()), '/private/tmp/'].some((t) => realpathSync(dataDir).startsWith(t));
  const keys = ov.backupKeys ?? (testKeyHex && inTmp ? new StaticKeyProvider(Buffer.from(testKeyHex, 'hex')) : new KeychainKeyProvider({ allowCreate: true }));
  const backups = new BackupManager({ dataDir, keys, store: core.store, appVersion: VERSION });
  api.route('POST', /^\/v1\/backups$/, async ({ body }) => ({ status: 201, body: await backups.create(String(body?.label ?? 'manual')) }));
  api.route('GET', /^\/v1\/backups$/, () => ({ body: backups.list() }));
  api.route('POST', /^\/v1\/backups\/([A-Za-z0-9._-]+)\/verify$/, ({ params }) => ({ body: backups.verify(params[0]) }));
  api.route('GET', /^\/v1\/diagnostics\/export$/, () => ({ body: redactDeep({
    exported_at: new Date().toISOString(), version: VERSION, node: process.version, schema: core.store.schemaVersion(), pragmas: core.store.pragmas(),
    doctor: doctor(core, cfg, dataDir, secrets, routeDeps.extraChecks?.() ?? []),
    task_counts: core.store.db.prepare('SELECT status, count(*) c FROM tasks GROUP BY status').all(),
    recent_events: core.store.db.prepare('SELECT seq, domain, kind, at FROM events ORDER BY seq DESC LIMIT 200').all(),
    workers: core.store.db.prepare('SELECT generation, status, started_at, ended_at FROM workers ORDER BY started_at DESC LIMIT 20').all(),
    note: 'Privacy-filtered: no goals, file contents, receipts, tokens or keys are included.' }) }));
  installExtraRoutes(api, { core, cfg, dataDir, memory, telegram: () => telegram, desktop, gateway, onConfig: () => { saveConfig(dataDir, cfg); configureProvider(); if (cfg.remote.telegram_enabled && !telegram) setupTelegram(); if (!cfg.remote.telegram_enabled && telegram) stopTelegram(); } });
  api.route('POST', /^\/v1\/policy\/revoke$/, ({ body }) => {
    if (!cfg.default_grant_id) throw new ApiError(409, 'no standing grant');
    core.policy.revoke(cfg.default_grant_id, String(body?.reason ?? 'owner revoked'));
    cfg.default_grant_id = null; saveConfig(dataDir, cfg); restartDesktop('grant revoked');
    core.executor.wake('grant_changed');
    return { body: { revoked: true, note: 'Queued and in-flight actions under this grant are refused at dispatch. Create a new grant to continue.' } };
  });
  await api.listen();
  core.executor.start(250);
  await workers.start(250);
  const timers = [
    setInterval(() => { core.outbox.deliverDue().catch(() => {}); }, 2000),
    setInterval(() => { core.control.finalizeCancellations(); if (arbiter.state() === 'idle') core.executor.wake('session_available'); }, 2000),
    setInterval(() => { core.executor.wake('provider_available'); }, 30_000),
    setInterval(() => { try { schedules.tick(); } catch { /* recorded */ } }, 10_000),
    // Uncertain effects are re-reconciled periodically (destination may become reachable), not only at startup.
    setInterval(async () => {
      try {
        const rows = core.store.db.prepare(`SELECT attempt_id FROM attempts WHERE status='UNRESOLVED' ORDER BY updated_at LIMIT 5`).all() as any[];
        for (const r of rows) if (!core.broker.isInflight(r.attempt_id)) await core.broker.reconcileAttempt(r.attempt_id);
        const blocked = core.store.db.prepare(`SELECT task_id FROM tasks WHERE status='BLOCKED_EXTERNAL' AND wait_condition='reconcile'`).all() as any[];
        for (const b of blocked) {
          const open = core.store.db.prepare(`SELECT count(*) c FROM attempts WHERE task_id=? AND status IN ('UNRESOLVED','RECONCILING','OUTCOME_UNKNOWN','DISPATCHING')`).get(b.task_id) as any;
          if (!open.c) core.store.transitionTask(b.task_id, 'READY', { wait_reason: null, wait_condition: null }, 'reconciliation settled');
        }
      } catch { /* next sweep retries */ }
    }, 60_000),
    setInterval(() => { try { retention.sweep(new Date().toISOString()); } catch { /* recorded by retention */ } }, 15 * 60_000),
  ];
  core.store.tx(() => core.store.event('daemon', 'billyd', 'started', { pid: process.pid, version: VERSION, recovery: { attempts: rec.attempts.length, outbox: rec.outbox } }));
  const stop = async () => {
    for (const t of timers) clearInterval(t);
    arbiter.stop();
    telegram?.stop();
    // Stop admission, planner/provider calls and worker leases together. Interrupted
    // RUNNING work is recovered on restart; shutdown does not set the owner's stop latch.
    const closingApi = api.close();
    let shutdownTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all([core.executor.stop(), workers.stop(), closingApi]),
        new Promise<never>((_resolve, reject) => { shutdownTimer = setTimeout(() => reject(new Error('daemon shutdown timeout')), 15_000); }),
      ]);
    } finally { if (shutdownTimer) clearTimeout(shutdownTimer); }
    if (cuaSocket && !ov.desktopTransportPath) stopPrivateDaemon(cuaSocket);
    core.store.tx(() => core.store.event('daemon', 'billyd', 'stopped', { pid: process.pid }));
    core.close();
  };
  return { core, api, cfg, workers, telegram, gateway, stop };
}

interface ExtraDeps { core: Core; cfg: BillyConfig; dataDir: string; memory: Memory; telegram: () => TelegramRemote | null; desktop: DesktopServices; gateway: ModelGateway; onConfig: () => void }

function installExtraRoutes(api: LocalApi, d: ExtraDeps): void {
  const { core, memory } = d;
  api.route('GET', /^\/v1\/desktop$/, () => {
    const holders = core.store.db.prepare(`SELECT resource_key, holder, acquired_at FROM resource_claims WHERE resource_key LIKE 'desktop:%'`).all();
    return { body: { desktop_owner: holders.length ? 'billy' : null, holders, arbiter: d.desktop.arbiter.state(), takeovers: d.desktop.arbiter.takeovers.slice(-10) } };
  });
  api.route('GET', /^\/v1\/memory$/, ({ query }) => ({ body: memory.search(query.get('scope') ?? d.cfg.default_project_scope, query.get('q') ?? '', { limit: 20 }) }));
  api.route('POST', /^\/v1\/memory$/, ({ body }) => {
    const id = memory.record({ project_scope: body?.project_scope ?? d.cfg.default_project_scope, kind: body?.kind ?? 'decision', key: String(body?.key ?? ''), value: String(body?.value ?? ''),
      trust: 'owner', confidence: 1, provenance: { source_kind: 'owner_command', source_ref: 'local-app', captured_at: new Date().toISOString() } } as any, ownerAuth('local-app'));
    return { status: 201, body: memory.get(id) };
  });
  api.route('POST', /^\/v1\/memory\/([0-9a-f-]{36})\/correct$/, ({ params, body }) => ({ body: memory.get(memory.correct({ memory_id: params[0] }, String(body?.value ?? ''), ownerAuth('local-app'))) }));
  api.route('DELETE', /^\/v1\/memory\/([0-9a-f-]{36})$/, ({ params }) => ({ body: memory.delete(params[0], ownerAuth('local-app'), 'owner deleted from app') }));
  api.route('GET', /^\/v1\/memory\/export$/, ({ query }) => ({ body: JSON.parse(memory.export(query.get('scope') ?? d.cfg.default_project_scope)) }));
  api.route('POST', /^\/v1\/remote\/telegram\/pairing$/, () => {
    const t = d.telegram();
    if (!t) throw new ApiError(409, 'Telegram is not configured (setup packet S4)');
    return { body: t.createPairingCode() };
  });
  api.route('GET', /^\/v1\/remote\/devices$/, () => ({ body: d.telegram()?.devices() ?? [] }));
  api.route('POST', /^\/v1\/remote\/devices\/(\d+)\/revoke$/, ({ params }) => { d.telegram()?.revoke(params[0]); return { body: d.telegram()?.devices() ?? [] }; });
  api.route('PUT', /^\/v1\/provider$/, ({ body }) => {
    const kind = body?.kind; const model = body?.planner_model;
    if (!['anthropic_api', 'none'].includes(kind)) throw new ApiError(400, 'unsupported provider kind');
    if (model !== undefined && !/^claude-[a-z0-9-]{3,60}$/.test(String(model))) throw new ApiError(400, 'invalid model id');
    d.cfg.provider.kind = kind; if (model) d.cfg.provider.planner_model = model;
    d.onConfig();
    return { body: d.cfg.provider };
  });
  api.route('POST', /^\/v1\/provider\/discover$/, async () => ({ body: await d.gateway.discover() }));
  api.route('PUT', /^\/v1\/remote\/telegram$/, ({ body }) => { d.cfg.remote.telegram_enabled = !!body?.enabled; d.onConfig(); return { body: d.cfg.remote }; });
}

if (import.meta.main) {
  const dataDir = arg('--data-dir') ?? defaultDataDir();
  startDaemon(dataDir, process.argv.includes('--allow-unsafe-location')).then((d) => {
    process.stdout.write(`billyd ${VERSION} listening on ${d.api.socketPath}\n`);
    let stopping = false;
    const shutdown = (sig: string) => {
      if (stopping) return; stopping = true;
      process.stdout.write(`billyd received ${sig}; stopping\n`);
      d.stop().then(() => process.exit(0), () => process.exit(1));
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }, (e) => {
    const code = e instanceof InstanceLockedError ? 75 : e instanceof CorruptionError ? 70 : 1;
    process.stderr.write(`billyd failed to start: ${(e as Error).message}\n`);
    process.exit(code);
  });
}
