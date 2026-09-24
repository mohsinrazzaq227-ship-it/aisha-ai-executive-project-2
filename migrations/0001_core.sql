-- 0001_core.sql — AISHA core schema (idempotent, safe to re-run on a populated database)
-- Applied by src/lib/migrations.ts inside a transaction and recorded in schema_migrations
-- with a sha256 checksum. Table shape mirrors src/db/schema.ts exactly.

create table if not exists agents (
  id text primary key,
  name text not null,
  callsign text not null,
  role text not null,
  tier text not null,
  station text not null,
  color text not null,
  accent text not null,
  glyph text not null,
  personality text not null,
  capabilities jsonb not null default '[]'::jsonb,
  tools jsonb not null default '[]'::jsonb,
  risk_profile text not null default 'MEDIUM',
  voice jsonb not null default '{"rate":1,"pitch":1}'::jsonb,
  brief text not null,
  updated_at timestamptz not null default now()
);

create table if not exists agent_states (
  agent_id text primary key,
  state text not null default 'IDLE',
  task_id text,
  step_id text,
  station_id text not null,
  position jsonb not null,
  walk jsonb default null,
  payload jsonb default null,
  last_message text,
  mood text not null default 'CALM',
  updated_at timestamptz not null default now()
);

create table if not exists tasks (
  id text primary key,
  request text not null,
  intent text not null,
  engine text not null,
  status text not null default 'PLANNING',
  risk text not null default 'LOW',
  plan_summary text not null default '',
  plan jsonb not null default '{}'::jsonb,
  result text,
  evidence jsonb not null default '{}'::jsonb,
  stats jsonb not null default '{"steps":0,"succeeded":0,"failed":0,"artifacts":0,"approvals":0,"ms":0}'::jsonb,
  error text,
  cancel_requested boolean not null default false,
  cancel_verified jsonb default null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index if not exists tasks_created_idx on tasks (created_at);

create table if not exists steps (
  id text primary key,
  task_id text not null,
  step_index integer not null,
  title text not null,
  agent_id text not null,
  tool_id text not null,
  params jsonb not null default '{}'::jsonb,
  depends_on jsonb not null default '[]'::jsonb,
  parallel boolean not null default false,
  resource_class text not null default 'LIGHT',
  risk text not null default 'LOW',
  status text not null default 'PENDING',
  attempts integer not null default 0,
  max_attempts integer not null default 2,
  approval_id text,
  output jsonb default null,
  evidence jsonb not null default '{}'::jsonb,
  verification jsonb default null,
  deferral text,
  error text,
  ms integer not null default 0,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index if not exists steps_task_idx on steps (task_id, step_index);

create table if not exists approvals (
  id text primary key,
  task_id text not null,
  step_id text not null,
  agent_id text not null,
  action text not null,
  target text not null default '',
  reason text not null,
  risk text not null,
  action_hash text not null,
  token text not null,
  status text not null default 'PENDING',
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null,
  decided_at timestamptz,
  decided_by text,
  decision_note text
);
create index if not exists approvals_status_idx on approvals (status);

create table if not exists events (
  id serial primary key,
  topic text not null,
  task_id text,
  step_id text,
  agent_id text,
  level text not null default 'info',
  message text not null,
  payload jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index if not exists events_task_idx on events (task_id);
create index if not exists events_at_idx on events (at);

create table if not exists artifacts (
  id text primary key,
  task_id text,
  step_id text,
  agent_id text,
  name text not null,
  kind text not null,
  path text not null,
  mime_type text not null default 'application/octet-stream',
  bytes integer not null default 0,
  sha256 text not null,
  origin text not null default 'deterministic',
  validation jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists artifacts_task_idx on artifacts (task_id);

create table if not exists audit_logs (
  id serial primary key,
  actor text not null,
  action text not null,
  target text not null default '',
  risk text not null default 'LOW',
  decision text not null default 'ALLOWED',
  detail jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index if not exists audit_at_idx on audit_logs (at);

create table if not exists tool_runs (
  id text primary key,
  task_id text,
  step_id text,
  tool_id text not null,
  risk text not null,
  status text not null,
  ms integer not null default 0,
  params jsonb not null default '{}'::jsonb,
  result jsonb default null,
  error text,
  at timestamptz not null default now()
);
create index if not exists tool_runs_tool_idx on tool_runs (tool_id);

create table if not exists capability_snapshots (
  id serial primary key,
  payload jsonb not null,
  summary text not null,
  at timestamptz not null default now()
);

create table if not exists resource_samples (
  id serial primary key,
  cpu_percent integer not null,
  load_per_core_x100 integer not null,
  total_mem_mb integer not null,
  free_mem_mb integer not null,
  disk_free_mb integer not null,
  active_steps integer not null default 0,
  pressure text not null default 'NORMAL',
  at timestamptz not null default now()
);

create table if not exists test_runs (
  id text primary key,
  suite text not null,
  passed integer not null,
  failed integer not null,
  total integer not null,
  ms integer not null default 0,
  results jsonb not null default '[]'::jsonb,
  at timestamptz not null default now()
);

create table if not exists messages (
  id text primary key,
  task_id text,
  role text not null,
  content text not null,
  engine text,
  at timestamptz not null default now()
);
create index if not exists messages_task_idx on messages (task_id);
