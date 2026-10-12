// Out-of-process driver for crash-boundary tests. Each invocation is a fresh
// Billy core process over the same data directory, exactly like a daemon restart.
//   node broker-proc.ts <dataDir> <fixtureJson>
// fixtureJson: {mode: 'setup'|'submit'|'recover', receiver, root, task_id?, tool, args, step}
import { Core } from '../../src/core.ts';
import { Tasks } from '../../src/tasks/tasks.ts';
import { apiSendMessage, type Endpoint } from '../../src/tools/api.ts';

const [dataDir, json] = process.argv.slice(2);
const fx = JSON.parse(json);
const endpoints = new Map<string, Endpoint>([['fixture', {
  id: 'fixture', base_url: fx.receiver, account_id: 'acct-fixture', supports_idempotency_keys: true, lookup_path: 'ops',
}]]);
const core = new Core({ dir: dataDir, allowUnsafeLocation: true, extraTools: [apiSendMessage], services: { endpoints } });
const tasks = new Tasks(core.store);
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n');

async function main() {
  if (fx.mode === 'setup') {
    const gid = crypto.randomUUID();
    core.policy.putGrant({ grant_id: gid, owner_id: 'owner', parent_grant_id: null, task_id: null,
      expires_at: '2099-01-01T00:00:00.000Z', source: 'harness-owner', scope: {
        apps: [], file_roots: [fx.root], browser_profiles: [], domains: [], account_ids: ['acct-fixture'],
        tool_classes: ['file', 'api.message'], allowed_effects: ['READ_ONLY', 'IDEMPOTENT_WRITE', 'NON_IDEMPOTENT_EFFECT'],
        secret_references: [], network_destinations: [new URL(fx.receiver).host], foreground: 'never', spend_scopes: [],
        protected_actions: [], delegation: { allowed: false, max_depth: 0 }, model_egress: [], recipients: ['*'] } });
    const id = tasks.create({ owner_id: 'owner', goal: 'crash fixture', project_scope: 'fx', grant_id: gid,
      success_criteria: { description: 'one effect', postconditions: [] } });
    core.store.transitionTask(id, 'PLANNING'); core.store.transitionTask(id, 'READY'); core.store.transitionTask(id, 'RUNNING');
    out({ task_id: id });
    return;
  }
  const t = core.store.db.prepare('SELECT revision, cancellation_generation FROM tasks WHERE task_id=?').get(fx.task_id) as any;
  const proposal = { task_id: fx.task_id, task_revision: t.revision, cancellation_generation: t.cancellation_generation,
    actor_id: `core:${fx.task_id}`, core_key: core.broker.coreKey, tool_id: fx.tool, arguments: fx.args, step_key: fx.step };
  const recovered = fx.mode === 'recover' ? await core.broker.recover() : [];
  if (fx.mode === 'recover') core.claims.clearAll();
  // Executor behaviour (single retry owner): submit the same semantic step until it is settled.
  const verdicts: string[] = [];
  for (let i = 0; i < 4; i++) {
    const r = await core.broker.submit(proposal);
    verdicts.push(r.verdict);
    if (r.verdict !== 'RETRY_ELIGIBLE') break;
  }
  const attempts = core.store.db.prepare('SELECT attempt_no, status FROM attempts ORDER BY attempt_no').all();
  out({ recovered, verdicts, attempts });
}
main().then(() => core.close(), (e) => { process.stderr.write(String(e?.stack ?? e)); process.exit(2); });
