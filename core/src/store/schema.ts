// Versioned schema migrations for Billy's authoritative store.
// Each migration is applied exactly once inside a transaction and recorded in
// schema_migrations with its digest; a mismatched digest on an applied version
// is a compatibility failure, not something to silently re-run.

export interface Migration { version: number; name: string; sql: string }

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'core-domains',
    sql: `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE stop_latch (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL,
  stopped INTEGER NOT NULL CHECK (stopped IN (0,1)),
  reason TEXT,
  source TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE grants (
  grant_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  owner_id TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  scope_digest TEXT NOT NULL,
  parent_grant_id TEXT,
  task_id TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (grant_id, revision)
);

CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  parent_task_id TEXT REFERENCES tasks(task_id),
  project_scope TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  status TEXT NOT NULL,
  cancellation_generation INTEGER NOT NULL DEFAULT 0,
  grant_id TEXT,
  budget_scope TEXT,
  wait_reason TEXT,
  wait_condition TEXT,
  result_json TEXT,
  locale TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX tasks_status ON tasks(status);
CREATE INDEX tasks_parent ON tasks(parent_task_id);

CREATE TABLE task_revisions (
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  revision INTEGER NOT NULL,
  goal TEXT NOT NULL,
  success_criteria_json TEXT NOT NULL,
  success_criteria_digest TEXT NOT NULL,
  source_command_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, revision)
);

CREATE TABLE task_edges (
  parent_task_id TEXT NOT NULL REFERENCES tasks(task_id),
  child_task_id TEXT NOT NULL REFERENCES tasks(task_id),
  kind TEXT NOT NULL CHECK (kind IN ('child','depends_on')),
  PRIMARY KEY (parent_task_id, child_task_id, kind),
  CHECK (parent_task_id <> child_task_id)
);

CREATE TABLE attempts (
  attempt_id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL,
  semantic_operation_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  task_revision INTEGER NOT NULL,
  cancellation_generation INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  tool_version INTEGER NOT NULL,
  effect_class TEXT NOT NULL,
  target_json TEXT NOT NULL,
  arguments_digest TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  status TEXT NOT NULL,
  receipt_json TEXT,
  uncertainty TEXT,
  evidence_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  dispatched_at TEXT,
  UNIQUE (semantic_operation_id, attempt_no)
);
-- At most one live (non-terminal) attempt per semantic operation.
CREATE UNIQUE INDEX attempts_one_live ON attempts(semantic_operation_id)
  WHERE status NOT IN ('RETRY_ELIGIBLE','FAILED','COMMITTED','REJECTED','CANCELLED');
CREATE INDEX attempts_task ON attempts(task_id);
CREATE INDEX attempts_status ON attempts(status);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  correlation_id TEXT,
  causation_id TEXT,
  payload_json TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX events_entity ON events(entity_id);

CREATE TABLE inbox (
  source TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  disposition TEXT NOT NULL,
  task_id TEXT,
  revision INTEGER,
  PRIMARY KEY (source, source_message_id)
);

CREATE TABLE outbox (
  delivery_id TEXT PRIMARY KEY,
  dedup_key TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL,
  destination TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','SENDING','DELIVERED','UNKNOWN','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TEXT NOT NULL,
  receipt_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE resource_claims (
  resource_key TEXT NOT NULL,
  holder TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('shared','exclusive')),
  generation INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  PRIMARY KEY (resource_key, holder)
);
CREATE TABLE resource_generations (resource_key TEXT PRIMARY KEY, generation INTEGER NOT NULL);
CREATE TABLE resource_waiters (
  resource_key TEXT NOT NULL,
  waiter TEXT NOT NULL,
  enqueued_seq INTEGER NOT NULL,
  PRIMARY KEY (resource_key, waiter)
);

CREATE TABLE workers (
  worker_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  generation INTEGER NOT NULL,
  pid INTEGER,
  pid_start TEXT,
  status TEXT NOT NULL CHECK (status IN ('STARTING','RUNNING','EXITED','LOST','FENCED')),
  heartbeat_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE budgets (
  scope TEXT PRIMARY KEY,
  ceiling_micros INTEGER NOT NULL CHECK (ceiling_micros >= 0),
  period TEXT NOT NULL CHECK (period IN ('total','daily')),
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE budget_entries (
  entry_id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('RESERVE','ACTUAL','UNCERTAIN','RELEASE')),
  amount_micros INTEGER NOT NULL,
  ref TEXT,
  at TEXT NOT NULL
);
CREATE INDEX budget_entries_scope ON budget_entries(scope);
CREATE INDEX budget_entries_res ON budget_entries(reservation_id);

CREATE TABLE evidence (
  evidence_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  task_id TEXT,
  attempt_id TEXT,
  captured_at TEXT NOT NULL,
  source TEXT NOT NULL,
  location TEXT,
  digest TEXT,
  sanitized INTEGER NOT NULL DEFAULT 1,
  retain_until TEXT,
  deleted_at TEXT
);

CREATE TABLE memory (
  memory_id TEXT PRIMARY KEY,
  project_scope TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('decision','preference','fact','observation','external')),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  trust TEXT NOT NULL CHECK (trust IN ('owner','verified','inferred','untrusted')),
  provenance_json TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  created_at TEXT NOT NULL,
  fresh_until TEXT,
  superseded_by TEXT REFERENCES memory(memory_id),
  deleted_at TEXT
);
CREATE INDEX memory_scope_key ON memory(project_scope, key);
CREATE VIRTUAL TABLE memory_fts USING fts5(memory_id UNINDEXED, project_scope UNINDEXED, key, value,
  tokenize = 'unicode61 remove_diacritics 2');
CREATE TABLE memory_tombstones (memory_id TEXT PRIMARY KEY, deleted_at TEXT NOT NULL, reason TEXT NOT NULL);

CREATE TABLE devices (
  device_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  platform_identity TEXT NOT NULL,
  label TEXT,
  paired_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (channel, platform_identity)
);
CREATE TABLE pairing_challenges (
  challenge_id TEXT PRIMARY KEY,
  code_digest TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE plans (
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  revision INTEGER NOT NULL,
  planner TEXT NOT NULL,
  state_json TEXT NOT NULL,
  replans INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, revision)
);
CREATE TABLE step_failures (
  task_id TEXT NOT NULL,
  signature TEXT NOT NULL,
  count INTEGER NOT NULL,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, signature)
);

CREATE TABLE processes (
  process_key TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  pid_start TEXT NOT NULL,
  pgid INTEGER NOT NULL,
  executable TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  exit_code INTEGER
);
`,
  },
  {
    version: 2,
    name: 'workers-and-delegation',
    sql: `
ALTER TABLE tasks ADD COLUMN driver TEXT NOT NULL DEFAULT 'core';
ALTER TABLE workers ADD COLUMN token_digest TEXT;
ALTER TABLE workers ADD COLUMN pgid INTEGER;
CREATE TABLE child_links (
  semantic_operation_id TEXT PRIMARY KEY,
  parent_task_id TEXT NOT NULL REFERENCES tasks(task_id),
  child_task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id),
  depth INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
`,
  },
  {
    version: 3,
    name: 'owner-schedules',
    sql: `
CREATE TABLE schedules (
  schedule_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  project_scope TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('once','interval')),
  first_fire_utc TEXT NOT NULL,
  interval_seconds INTEGER CHECK (interval_seconds IS NULL OR interval_seconds >= 60),
  display_timezone TEXT NOT NULL,
  next_fire_utc TEXT,
  last_fired_utc TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
`,
  },
];
