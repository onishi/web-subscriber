-- Web Subscriber 初期スキーマ（docs/design.md §3）

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  input_url TEXT NOT NULL,
  display_title TEXT,
  status TEXT NOT NULL,                      -- setup | active | paused | archived
  active_config_version_id TEXT,
  schedule_minute_of_day INTEGER NOT NULL,   -- 0..1439（timezone の壁時計）
  schedule_interval_minutes INTEGER NOT NULL DEFAULT 1440, -- 将来の頻度調整用
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  next_run_at TEXT,
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_change_at TEXT,
  baseline_status TEXT NOT NULL DEFAULT 'none', -- none | partial | complete
  baseline_identity_scheme TEXT,
  health TEXT NOT NULL DEFAULT 'unknown',    -- ok | fetch_error | extract_error | degraded | unknown
  health_detail TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  consecutive_extract_failures INTEGER NOT NULL DEFAULT 0,
  current_setup_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX subscriptions_next_run ON subscriptions(status, next_run_at);

CREATE TABLE config_versions (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  version INTEGER NOT NULL,
  state TEXT NOT NULL,                       -- draft | active | superseded | rejected
  config_json TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  identity_scheme_hash TEXT NOT NULL,
  hash_scheme_hash TEXT NOT NULL,
  origin TEXT NOT NULL,                      -- ai_setup | ai_repair | manual | heuristic
  setup_session_id TEXT,
  parent_version_id TEXT,
  validation_report_key TEXT,
  validation_summary_json TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  UNIQUE(subscription_id, version)
);

CREATE TABLE channels (
  subscription_id TEXT PRIMARY KEY,
  data_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  first_seen_run_id TEXT,
  last_changed_run_id TEXT,
  updated_at TEXT
);
CREATE TABLE channel_revisions (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  run_id TEXT,
  data_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  identity_scheme TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  source_id TEXT,
  data_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  hash_scheme TEXT NOT NULL,
  title_text TEXT,
  primary_link TEXT,
  published_sort TEXT,
  is_baseline INTEGER NOT NULL,
  first_seen_run_id TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_run_id TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_changed_run_id TEXT,
  last_changed_at TEXT,
  revision_count INTEGER NOT NULL DEFAULT 1,
  UNIQUE(subscription_id, identity_scheme, identity_key)
);
CREATE INDEX items_feed ON items(is_baseline, first_seen_at DESC);
CREATE INDEX items_sub ON items(subscription_id, first_seen_at DESC);
CREATE INDEX items_changed ON items(last_changed_at DESC);
CREATE INDEX items_link ON items(subscription_id, primary_link);
CREATE INDEX items_source ON items(subscription_id, source_id);

CREATE TABLE item_revisions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  run_id TEXT,
  content_hash TEXT NOT NULL,
  data_json TEXT NOT NULL,
  change_kind TEXT NOT NULL,                 -- created | updated
  created_at TEXT NOT NULL
);
CREATE INDEX item_revisions_item ON item_revisions(item_id, created_at);

CREATE TABLE item_observations (
  run_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  page_seq INTEGER NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY(run_id, item_id)
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                        -- crawl | probe
  subscription_id TEXT,
  run_id TEXT,
  probe_id TEXT,
  status TEXT NOT NULL,                      -- queued | leased | done | failed | cancelled
  not_before TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  lease_token TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE UNIQUE INDEX jobs_one_active_crawl ON jobs(subscription_id) WHERE kind = 'crawl' AND status IN ('queued', 'leased');
CREATE INDEX jobs_queue ON jobs(status, priority DESC, not_before);

CREATE TABLE crawl_runs (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  job_id TEXT,
  trigger TEXT NOT NULL,                     -- scheduled | manual | retry | activation
  config_version_id TEXT NOT NULL,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  run_status TEXT NOT NULL,                  -- queued | running | completed | partial | failed
  extract_status TEXT,                       -- success | failed | skipped
  change_status TEXT,                        -- initial | changed | unchanged | unknown
  channel_changed INTEGER NOT NULL DEFAULT 0,
  new_items INTEGER NOT NULL DEFAULT 0,
  updated_items INTEGER NOT NULL DEFAULT 0,
  seen_items INTEGER NOT NULL DEFAULT 0,
  invalid_items INTEGER NOT NULL DEFAULT 0,
  pages_fetched INTEGER NOT NULL DEFAULT 0,
  actions_performed INTEGER NOT NULL DEFAULT 0,
  end_reason TEXT,
  error_stage TEXT,
  error_detail TEXT,
  baseline_run INTEGER NOT NULL DEFAULT 0,   -- 基準データ作成中の実行
  rebaseline INTEGER NOT NULL DEFAULT 0,     -- 識別方式変更による再基準化
  baseline_incomplete INTEGER NOT NULL DEFAULT 0,
  retry_of_run_id TEXT,
  worker_id TEXT,
  crawler_version TEXT,
  engine_version TEXT
);
CREATE INDEX crawl_runs_sub ON crawl_runs(subscription_id, queued_at DESC);

CREATE TABLE crawl_pages (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  url TEXT,
  fetched_at TEXT,
  http_status INTEGER,
  http_status_source TEXT,
  action_result TEXT,
  extract_status TEXT,
  item_count INTEGER,
  new_unique_items INTEGER,
  field_failures_json TEXT,
  list_signature TEXT,
  error TEXT,
  subresource_failures INTEGER,
  snapshot_key TEXT,
  timings_json TEXT,
  PRIMARY KEY(run_id, seq)
);

CREATE TABLE reading_states (
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  read_at TEXT NOT NULL,
  PRIMARY KEY(user_id, item_id)
);

CREATE TABLE setup_sessions (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  kind TEXT NOT NULL,                        -- setup | repair
  status TEXT NOT NULL,                      -- running | ready | failed
  workflow_instance_id TEXT,
  progress_json TEXT NOT NULL DEFAULT '[]',
  result_config_version_id TEXT,
  report_key TEXT,
  error TEXT,
  trigger_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE probes (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  kind TEXT NOT NULL,
  request_json TEXT NOT NULL,
  status TEXT NOT NULL,                      -- queued | running | ok | error
  result_key TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE crawler_workers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  last_seen_at TEXT,
  version TEXT,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE submissions (
  job_id TEXT NOT NULL,
  submission_key TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(job_id, submission_key)
);
