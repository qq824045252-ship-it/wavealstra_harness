-- Auto-generated DuckDB 2.0.1 schema from canonical_schema.sql (263 tables),
-- runtime-schema-inventory.json (22 dynamic runtime tables), and new native DuckDB contracts.
-- Do NOT re-add SQLite AUTONCREMENT, PRAGMA, FTS5, TRIGGERS, COLLATE NOCASE, or inline FOREIGN KEY constraints.


-- Canonical domain tables (263)

CREATE TABLE IF NOT EXISTS spaces (
  id VARCHAR PRIMARY KEY,
  name VARCHAR NOT NULL,
  path VARCHAR,
  parent_id VARCHAR,
  sort_order BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  archived BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS workspace_notes (
  workspace_id VARCHAR PRIMARY KEY,
  content VARCHAR NOT NULL,
  revision BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_icons (
  workspace_id VARCHAR PRIMARY KEY NOT NULL,
  shape VARCHAR NOT NULL,
  color VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id VARCHAR PRIMARY KEY,
  title VARCHAR NOT NULL,
  space_id VARCHAR,
  project_id VARCHAR,
  status VARCHAR,
  updated_at BIGINT NOT NULL,
  session_file VARCHAR,
  cwd VARCHAR,
  welcome_mode VARCHAR,
  model_id VARCHAR,
  permission_mode VARCHAR,
  archived BIGINT NOT NULL DEFAULT 0,
  expert_id VARCHAR,
  mode_preset_id VARCHAR,
  context_used_tokens BIGINT,
  context_window_tokens BIGINT,
  context_cache_hit_rate DOUBLE,
  start_at BIGINT,
  due_at BIGINT,
  space_sort_order BIGINT NOT NULL DEFAULT 0,
  is_favorited BIGINT NOT NULL DEFAULT 0,
  external_agent_pin_json VARCHAR,
  done_acked_at BIGINT
);

CREATE TABLE IF NOT EXISTS task_write_grants (
  task_id VARCHAR NOT NULL,
  path VARCHAR NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (task_id, path)
);

CREATE TABLE IF NOT EXISTS soul (
  id BIGINT PRIMARY KEY CHECK (id = 1),
  name VARCHAR NOT NULL,
  alias VARCHAR NOT NULL,
  persona VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS cron_jobs (
  id VARCHAR PRIMARY KEY,
  name VARCHAR NOT NULL,
  prompt VARCHAR NOT NULL,
  schedule_type VARCHAR NOT NULL,
  schedule_expr VARCHAR NOT NULL,
  timezone VARCHAR NOT NULL DEFAULT 'Asia/Shanghai',
  space_id VARCHAR,
  cwd VARCHAR,
  enabled BIGINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  last_run_at BIGINT,
  execution_json VARCHAR,
  permission_mode VARCHAR,
  model_id VARCHAR,
  expert_id VARCHAR,
  skill_ids_json VARCHAR NOT NULL DEFAULT '[]',
  connector_ids_json VARCHAR NOT NULL DEFAULT '[]',
  effective_from BIGINT,
  effective_to BIGINT,
  welcome_mode VARCHAR,
  project_id VARCHAR
);

CREATE TABLE IF NOT EXISTS cron_runs (
  id VARCHAR PRIMARY KEY,
  job_id VARCHAR NOT NULL,
  started_at BIGINT NOT NULL,
  finished_at BIGINT,
  status VARCHAR NOT NULL,
  error VARCHAR,
  task_id VARCHAR
);

CREATE TABLE IF NOT EXISTS gateway_sidebar_conversations (
  task_id VARCHAR PRIMARY KEY,
  channel_id VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS gateway_channels (
  id VARCHAR PRIMARY KEY,
  type VARCHAR NOT NULL,
  name VARCHAR NOT NULL,
  config_json VARCHAR NOT NULL DEFAULT '{}',
  connected BIGINT NOT NULL DEFAULT 0,
  status_text VARCHAR
);

CREATE TABLE IF NOT EXISTS gateway_channel_revisions (
  channel_id VARCHAR PRIMARY KEY,
  revision BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS gateway_messages (
  id BIGINT PRIMARY KEY,
  channel_id VARCHAR NOT NULL,
  chat_id VARCHAR NOT NULL DEFAULT '',
  direction VARCHAR NOT NULL,
  sender_id VARCHAR,
  sender_name VARCHAR,
  text VARCHAR NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id VARCHAR PRIMARY KEY,
  name VARCHAR NOT NULL,
  description VARCHAR,
  instructions VARCHAR,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  archived BIGINT NOT NULL DEFAULT 0,
  resource_budget_chars BIGINT NOT NULL DEFAULT 128000,
  template_id VARCHAR,
  default_space_id VARCHAR,
  goal VARCHAR,
  current_stage VARCHAR
);

CREATE TABLE IF NOT EXISTS project_notes (
  project_id VARCHAR PRIMARY KEY,
  content VARCHAR NOT NULL,
  revision BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_write_receipts (
  operation_id VARCHAR NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS project_delete_receipts (
  operation_id VARCHAR PRIMARY KEY,
  result_json VARCHAR NOT NULL CHECK (json_valid(result_json))
);

CREATE TABLE IF NOT EXISTS project_expert_policy (
  project_id VARCHAR PRIMARY KEY,
  allow_json VARCHAR NOT NULL DEFAULT '[]',
  deny_json VARCHAR NOT NULL DEFAULT '[]',
  recommended_json VARCHAR NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS project_skill_policy (
  project_id VARCHAR PRIMARY KEY,
  prefer_json VARCHAR NOT NULL DEFAULT '[]',
  demote_json VARCHAR NOT NULL DEFAULT '[]',
  hide_json VARCHAR NOT NULL DEFAULT '[]',
  allow_json VARCHAR NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS project_connector_policy (
  project_id VARCHAR PRIMARY KEY,
  allow_json VARCHAR NOT NULL DEFAULT '[]',
  deny_json VARCHAR NOT NULL DEFAULT '[]',
  recommended_json VARCHAR NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS project_mcp_policy (
  project_id VARCHAR PRIMARY KEY,
  mode VARCHAR NOT NULL DEFAULT 'hard',
  allow_json VARCHAR NOT NULL DEFAULT '[]',
  deny_json VARCHAR NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS project_resources (
  id VARCHAR PRIMARY KEY,
  project_id VARCHAR NOT NULL,
  kind VARCHAR NOT NULL CHECK (kind IN ('text', 'file', 'url', 'folder')),
  title VARCHAR NOT NULL,
  value VARCHAR NOT NULL,
  enabled BIGINT NOT NULL DEFAULT 1,
  sort_order BIGINT NOT NULL DEFAULT 0,
  parent_id VARCHAR,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_posts (
  id VARCHAR PRIMARY KEY,
  project_id VARCHAR NOT NULL,
  body VARCHAR NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_todos (
  id VARCHAR PRIMARY KEY,
  project_id VARCHAR NOT NULL,
  title VARCHAR NOT NULL,
  description VARCHAR,
  status VARCHAR NOT NULL DEFAULT 'todo',
  assignee VARCHAR,
  priority VARCHAR,
  tags_json VARCHAR NOT NULL DEFAULT '[]',
  start_at BIGINT,
  due_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_audit_payloads (
  hash VARCHAR PRIMARY KEY NOT NULL,
  body VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_snapshot_receipts (
  write_id VARCHAR PRIMARY KEY,
  task_id VARCHAR,
  request_hash VARCHAR NOT NULL,
  result BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_runtime_context_snapshots (
  id VARCHAR PRIMARY KEY,
  task_id VARCHAR NOT NULL,
  user_message_id VARCHAR NOT NULL,
  assistant_message_id VARCHAR NOT NULL,
  created_at BIGINT NOT NULL,
  schema_version BIGINT NOT NULL DEFAULT 1,
  welcome_mode VARCHAR NOT NULL,
  tag_id VARCHAR,
  project_id VARCHAR,
  project_updated_at BIGINT,
  resolved_instructions_json VARCHAR NOT NULL,
  resolved_capabilities_json VARCHAR NOT NULL,
  warnings_json VARCHAR NOT NULL DEFAULT '[]',
  execution_id VARCHAR,
  status VARCHAR NOT NULL DEFAULT 'completed',
  started_at BIGINT,
  completed_at BIGINT,
  error VARCHAR,
  assembly_hash VARCHAR,
  model_id VARCHAR,
  permission_mode VARCHAR,
  storage_bytes BIGINT NOT NULL DEFAULT 0,
  material_usage_json VARCHAR,
  working_directory VARCHAR,
  instructions_hash VARCHAR,
  capabilities_hash VARCHAR
);

CREATE TABLE IF NOT EXISTS task_execution_workspace_state (
  task_id VARCHAR PRIMARY KEY,
  directory_name VARCHAR NOT NULL,
  state VARCHAR NOT NULL DEFAULT 'active',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  trashed_at BIGINT,
  purge_after BIGINT,
  trash_path VARCHAR
);

CREATE TABLE IF NOT EXISTS cad_models (
  model_id VARCHAR PRIMARY KEY,
  task_id VARCHAR NOT NULL,
  graph_id VARCHAR NOT NULL,
  kind VARCHAR NOT NULL DEFAULT 'custom',
  title VARCHAR,
  model_dir VARCHAR NOT NULL,
  parameters_json VARCHAR NOT NULL DEFAULT '{}',
  tags_json VARCHAR NOT NULL DEFAULT '[]',
  features_json VARCHAR NOT NULL DEFAULT '[]',
  outputs_json VARCHAR NOT NULL DEFAULT '{}',
  validation_json VARCHAR,
  version BIGINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_code_review (
  task_id VARCHAR NOT NULL,
  target_key VARCHAR NOT NULL,
  root_entity VARCHAR NOT NULL,
  path VARCHAR NOT NULL,
  relative_path VARCHAR NOT NULL,
  id VARCHAR NOT NULL UNIQUE,
  status VARCHAR NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
  before_present BIGINT NOT NULL,
  before_stamp VARCHAR NOT NULL,
  before_bytes BLOB,
  before_mode BIGINT,
  after_present BIGINT NOT NULL,
  after_stamp VARCHAR NOT NULL,
  after_bytes BLOB,
  after_mode BIGINT,
  additions BIGINT NOT NULL,
  deletions BIGINT NOT NULL,
  stats_available BIGINT NOT NULL,
  capture_reason VARCHAR,
  failure_reason VARCHAR,
  restoring BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, target_key)
);

CREATE TABLE IF NOT EXISTS project_events (
  id VARCHAR PRIMARY KEY,
  project_id VARCHAR NOT NULL,
  source VARCHAR NOT NULL,
  kind VARCHAR NOT NULL,
  title VARCHAR NOT NULL,
  body VARCHAR,
  ref VARCHAR,
  payload_json VARCHAR NOT NULL DEFAULT '{}',
  triage_status VARCHAR NOT NULL DEFAULT 'open'
          CHECK (triage_status IN ('open', 'dismissed')),
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_event_promotions (
  id VARCHAR PRIMARY KEY,
  project_id VARCHAR NOT NULL,
  event_id VARCHAR NOT NULL,
  event_title VARCHAR NOT NULL,
  target_kind VARCHAR NOT NULL CHECK (target_kind IN ('memory', 'todo', 'library')),
  target_id VARCHAR NOT NULL,
  target_title VARCHAR,
  promoted_by VARCHAR NOT NULL CHECK (promoted_by IN ('user', 'agent')),
  note VARCHAR,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS library_spaces (
  id VARCHAR PRIMARY KEY,
  name VARCHAR NOT NULL,
  kind VARCHAR NOT NULL CHECK (kind IN ('personal', 'team')),
  project_id VARCHAR,
  workspace_id VARCHAR CHECK (workspace_id IS NULL OR (project_id IS NULL AND kind = 'team')),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS library_collections (
  id VARCHAR PRIMARY KEY,
  space_id VARCHAR NOT NULL,
  parent_id VARCHAR,
  name VARCHAR NOT NULL,
  owner VARCHAR NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS library_items (
  id VARCHAR PRIMARY KEY,
  space_id VARCHAR NOT NULL,
  collection_id VARCHAR,
  kind VARCHAR NOT NULL CHECK (kind IN ('markdown', 'html', 'csv', 'office', 'pdf', 'image', 'file', 'url')),
  title VARCHAR NOT NULL,
  filename VARCHAR NOT NULL,
  mime_type VARCHAR NOT NULL DEFAULT '',
  size_bytes BIGINT NOT NULL DEFAULT 0,
  owner VARCHAR NOT NULL DEFAULT '',
  favorite BIGINT NOT NULL DEFAULT 0,
  url VARCHAR,
  source_type VARCHAR NOT NULL DEFAULT 'created',
  source_task_id VARCHAR,
  source_artifact_id VARCHAR,
  original_path VARCHAR,
  content_hash VARCHAR,
  extract_status VARCHAR,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  last_visited_at BIGINT,
  trashed_at BIGINT,
  note_metadata VARCHAR
);

CREATE TABLE IF NOT EXISTS library_versions (
  id VARCHAR PRIMARY KEY,
  item_id VARCHAR NOT NULL,
  version BIGINT NOT NULL,
  content_hash VARCHAR NOT NULL,
  path VARCHAR NOT NULL,
  created_by VARCHAR NOT NULL DEFAULT '',
  source_task_id VARCHAR,
  created_at BIGINT NOT NULL,
  snapshot BLOB
);

CREATE TABLE IF NOT EXISTS library_text_saves (
  item_id VARCHAR PRIMARY KEY,
  operation_id VARCHAR NOT NULL,
  root VARCHAR NOT NULL,
  path VARCHAR NOT NULL,
  old_content BLOB,
  old_hash VARCHAR,
  new_hash VARCHAR NOT NULL,
  committed BIGINT NOT NULL CHECK (committed IN (0,1))
);

CREATE TABLE IF NOT EXISTS library_file_cleanup (
  root VARCHAR NOT NULL,
  space_id VARCHAR NOT NULL,
  item_id VARCHAR NOT NULL,
  filename VARCHAR,
  PRIMARY KEY (root, space_id, item_id)
);

CREATE TABLE IF NOT EXISTS library_restore_files (
  root VARCHAR NOT NULL,
  operation_id VARCHAR NOT NULL,
  space_id VARCHAR NOT NULL,
  item_id VARCHAR NOT NULL,
  filename VARCHAR NOT NULL,
  PRIMARY KEY (root, item_id)
);

CREATE TABLE IF NOT EXISTS library_restore_receipts (
  root VARCHAR PRIMARY KEY,
  operation_id VARCHAR NOT NULL,
  result_json VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS task_library_references (
  task_id VARCHAR NOT NULL,
  item_id VARCHAR NOT NULL,
  project_id VARCHAR,
  added_at BIGINT NOT NULL,
  added_by VARCHAR NOT NULL DEFAULT '',
  PRIMARY KEY (task_id, item_id)
);

CREATE TABLE IF NOT EXISTS project_context_pins (
  id VARCHAR PRIMARY KEY,
  project_id VARCHAR NOT NULL,
  item_id VARCHAR NOT NULL,
  note VARCHAR,
  created_by VARCHAR NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  UNIQUE (project_id, item_id)
);

CREATE TABLE IF NOT EXISTS project_reviews (
  id VARCHAR PRIMARY KEY,
  project_id VARCHAR NOT NULL,
  reviewed_at BIGINT NOT NULL,
  note VARCHAR,
  created_by VARCHAR NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS project_action_proposals (
  id VARCHAR PRIMARY KEY,
  project_id VARCHAR NOT NULL,
  action_type VARCHAR NOT NULL CHECK (action_type IN ('locate_task', 'locate_plan', 'update_plan_status', 'needs_confirmation')),
  title VARCHAR NOT NULL,
  rationale VARCHAR NOT NULL,
  source_refs_json VARCHAR NOT NULL DEFAULT '[]',
  executable BIGINT NOT NULL DEFAULT 0,
  target_ref VARCHAR,
  status VARCHAR NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'applied', 'stale', 'obsolete')),
  fingerprint VARCHAR NOT NULL,
  created_by VARCHAR NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  applied_at BIGINT,
  applied_result VARCHAR,
  UNIQUE (project_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS usage_events (
  entry_id VARCHAR PRIMARY KEY,
  task_id VARCHAR,
  session_file VARCHAR,
  source_kind VARCHAR NOT NULL DEFAULT 'main',
  source_detail VARCHAR,
  provider VARCHAR,
  model VARCHAR,
  response_model VARCHAR,
  ts BIGINT NOT NULL,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read BIGINT NOT NULL DEFAULT 0,
  cache_write BIGINT NOT NULL DEFAULT 0,
  cache_write_1h BIGINT,
  reasoning_tokens BIGINT,
  total_tokens BIGINT NOT NULL DEFAULT 0,
  cost_total DOUBLE NOT NULL DEFAULT 0,
  cost_input DOUBLE NOT NULL DEFAULT 0,
  cost_output DOUBLE NOT NULL DEFAULT 0,
  cost_cache_read DOUBLE NOT NULL DEFAULT 0,
  cost_cache_write DOUBLE NOT NULL DEFAULT 0,
  stop_reason VARCHAR,
  error_message VARCHAR,
  request_started_at BIGINT,
  first_response_at BIGINT,
  completed_at BIGINT,
  ttft_ms BIGINT,
  decode_ms BIGINT,
  generation_tps DOUBLE,
  model_wall_ms BIGINT,
  response_id VARCHAR,
  turn_index BIGINT,
  user_turn BIGINT,
  backfilled BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS usage_backfill_state (
  session_file VARCHAR PRIMARY KEY,
  last_entry_id VARCHAR,
  file_size BIGINT,
  file_mtime BIGINT,
  user_messages BIGINT,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id VARCHAR PRIMARY KEY,
  type VARCHAR NOT NULL,
  level VARCHAR NOT NULL,
  title VARCHAR NOT NULL,
  body VARCHAR,
  source_type VARCHAR NOT NULL,
  source_id VARCHAR,
  task_id VARCHAR,
  project_id VARCHAR,
  workspace_id VARCHAR,
  dedupe_key VARCHAR,
  created_at BIGINT NOT NULL,
  read_at BIGINT,
  dismissed_at BIGINT
);

CREATE TABLE IF NOT EXISTS workspace_library_links (
  workspace_id VARCHAR NOT NULL,
  library_space_id VARCHAR NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, library_space_id)
);

CREATE TABLE IF NOT EXISTS workspace_library_collection_links (
  workspace_id VARCHAR NOT NULL,
  library_space_id VARCHAR NOT NULL,
  collection_id VARCHAR NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, collection_id)
);

CREATE TABLE IF NOT EXISTS python_project_bindings (
  dir_key VARCHAR PRIMARY KEY,
  project_dir VARCHAR NOT NULL,
  python_path VARCHAR NOT NULL,
  python_version VARCHAR,
  manifest_path VARCHAR,
  bound_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS library_chunks (
  id VARCHAR PRIMARY KEY,
  item_id VARCHAR NOT NULL,
  chunk_index BIGINT NOT NULL,
  content VARCHAR NOT NULL,
  char_offset BIGINT NOT NULL,
  hash VARCHAR NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS library_chunk_embeddings (
  chunk_id VARCHAR NOT NULL,
  model_id VARCHAR NOT NULL,
  model_version VARCHAR NOT NULL,
  chunk_hash VARCHAR NOT NULL,
  dimension BIGINT NOT NULL,
  embedding BLOB NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (chunk_id, model_id, model_version)
);

CREATE TABLE IF NOT EXISTS semantic_index_jobs (
  job_id VARCHAR PRIMARY KEY,
  model_id VARCHAR NOT NULL,
  model_version VARCHAR NOT NULL,
  status VARCHAR NOT NULL CHECK (status IN ('pending','running','done','failed')),
  last_chunk_id VARCHAR,
  processed BIGINT NOT NULL DEFAULT 0,
  failed BIGINT NOT NULL DEFAULT 0,
  error VARCHAR,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS material_retrieval_settings (
  singleton BIGINT PRIMARY KEY CHECK (singleton = 1),
  mode VARCHAR NOT NULL CHECK (mode IN ('keyword', 'hybrid')),
  decision_model VARCHAR
);

CREATE TABLE IF NOT EXISTS material_retrieval_spaces (
  id VARCHAR PRIMARY KEY,
  mode VARCHAR NOT NULL CHECK (mode IN ('keyword', 'hybrid'))
);

CREATE TABLE IF NOT EXISTS material_retrieval_projects (
  id VARCHAR PRIMARY KEY,
  mode VARCHAR NOT NULL CHECK (mode IN ('keyword', 'hybrid'))
);

CREATE TABLE IF NOT EXISTS work_graph_edges (
  id            VARCHAR PRIMARY KEY,
  from_type     VARCHAR NOT NULL,
  from_id       VARCHAR NOT NULL,
  relation      VARCHAR NOT NULL,
  to_type       VARCHAR NOT NULL,
  to_id         VARCHAR NOT NULL,
  metadata_json VARCHAR NOT NULL DEFAULT '{}',
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  UNIQUE(from_type, from_id, relation, to_type, to_id)
);

CREATE TABLE IF NOT EXISTS gadgets (
  id VARCHAR PRIMARY KEY,
  name VARCHAR NOT NULL,
  description VARCHAR,
  scope_type VARCHAR NOT NULL CHECK (scope_type IN ('global', 'workspace', 'task')),
  scope_id VARCHAR,
  type VARCHAR NOT NULL DEFAULT 'web' CHECK (type IN ('web')),
  manifest_path VARCHAR NOT NULL,
  source_path VARCHAR NOT NULL,
  created_by_task_id VARCHAR,
  blueprint_id VARCHAR,
  metadata_json VARCHAR NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CHECK (
          (scope_type = 'global' AND scope_id IS NULL) OR
          (scope_type = 'workspace' AND scope_id IS NOT NULL AND length(trim(scope_id)) > 0) OR
          (scope_type = 'task' AND scope_id IS NOT NULL AND length(trim(scope_id)) > 0)
        )
);

CREATE TABLE IF NOT EXISTS gadget_source_commits (
  gadget_id VARCHAR NOT NULL PRIMARY KEY,
  operation_id VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS blueprints (
  id VARCHAR PRIMARY KEY,
  name VARCHAR NOT NULL,
  description VARCHAR,
  kind VARCHAR NOT NULL CHECK (kind IN ('workspace', 'gadget', 'composite')),
  schema_version BIGINT NOT NULL CHECK (schema_version > 0),
  definition_json VARCHAR NOT NULL CHECK (json_valid(definition_json)),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS workbench_write_receipts (
  operation_id VARCHAR PRIMARY KEY,
  target_kind VARCHAR NOT NULL,
  target_id VARCHAR NOT NULL,
  fingerprint VARCHAR NOT NULL,
  status VARCHAR NOT NULL CHECK (status IN ('changed','missing','scopeChanged')),
  recorded_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workbench_receipts_by_target ON workbench_write_receipts(target_kind,target_id,recorded_at);

CREATE TABLE IF NOT EXISTS blueprint_instance_receipts (
  operation_id VARCHAR NOT NULL UNIQUE,
  result_json VARCHAR NOT NULL CHECK (json_valid(result_json))
);

CREATE TABLE IF NOT EXISTS memory_forget_watermarks (
  scope_type VARCHAR NOT NULL,
  scope_id VARCHAR NOT NULL DEFAULT '',
  cutoff_at BIGINT NOT NULL,
  allowed_message_id VARCHAR,
  PRIMARY KEY(scope_type, scope_id)
);

CREATE TABLE IF NOT EXISTS memory_forget_targets (
  scope_type VARCHAR NOT NULL,
  scope_id VARCHAR NOT NULL DEFAULT '',
  fingerprint VARCHAR NOT NULL,
  text_length BIGINT NOT NULL,
  cutoff_at BIGINT NOT NULL,
  value_fingerprint VARCHAR,
  guard_fingerprint VARCHAR,
  guard_length BIGINT,
  allowed_message_id VARCHAR,
  PRIMARY KEY(scope_type, scope_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS memory_forget_receipts (
  scope_type VARCHAR NOT NULL,
  scope_id VARCHAR NOT NULL DEFAULT '',
  source_message_id VARCHAR NOT NULL,
  request_fingerprint VARCHAR NOT NULL,
  PRIMARY KEY(scope_type,scope_id,source_message_id,request_fingerprint)
);

CREATE TABLE IF NOT EXISTS memory_organization_runs (
  id VARCHAR PRIMARY KEY,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  state_json VARCHAR NOT NULL CHECK (json_valid(state_json))
);

CREATE TABLE IF NOT EXISTS memory_records (
  id VARCHAR PRIMARY KEY,
  kind VARCHAR NOT NULL CHECK (kind IN ('identity','preference','fact','decision','constraint','risk','open_question','progress','procedure')),
  title VARCHAR NOT NULL,
  content VARCHAR NOT NULL DEFAULT '',
  status VARCHAR NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','resolved','invalid')),
  importance BIGINT NOT NULL DEFAULT 0 CHECK (importance BETWEEN 0 AND 3),
  confidence DOUBLE NOT NULL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
  explicit BIGINT NOT NULL DEFAULT 0 CHECK (explicit IN (0,1)),
  source_type VARCHAR NOT NULL DEFAULT 'agent' CHECK (source_type IN ('user','agent','tool','library','event','manual','import')),
  source_id VARCHAR,
  source_task_id VARCHAR,
  valid_from BIGINT,
  valid_until BIGINT,
  content_hash VARCHAR NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  last_recalled_at BIGINT,
  recall_count BIGINT NOT NULL DEFAULT 0,
  metadata_json VARCHAR NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json))
);

CREATE TABLE IF NOT EXISTS memory_scopes (
  id VARCHAR PRIMARY KEY,
  memory_id VARCHAR NOT NULL,
  scope_type VARCHAR NOT NULL CHECK (scope_type IN ('global','workspace','project','task','bot','team','conversation','work')),
  scope_id VARCHAR,
  binding VARCHAR NOT NULL DEFAULT 'owned' CHECK (binding IN ('owned','promoted')),
  created_at BIGINT NOT NULL,
  CHECK ((scope_type='global' AND scope_id IS NULL) OR (scope_type!='global' AND scope_id IS NOT NULL AND length(trim(scope_id)) > 0))
);

CREATE TABLE IF NOT EXISTS memory_evidence (
  id VARCHAR PRIMARY KEY,
  memory_id VARCHAR NOT NULL,
  evidence_kind VARCHAR NOT NULL CHECK (evidence_kind IN ('conversation','message','task','artifact','library_item','library_chunk','project_event','agent_run','external')),
  ref_id VARCHAR NOT NULL,
  ref_title VARCHAR,
  excerpt VARCHAR,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_revisions (
  id VARCHAR PRIMARY KEY,
  memory_id VARCHAR NOT NULL,
  revision BIGINT NOT NULL,
  kind VARCHAR NOT NULL,
  title VARCHAR NOT NULL,
  content VARCHAR NOT NULL,
  status VARCHAR NOT NULL,
  importance BIGINT NOT NULL,
  confidence DOUBLE NOT NULL,
  valid_from BIGINT,
  valid_until BIGINT,
  changed_by VARCHAR NOT NULL,
  change_reason VARCHAR,
  created_at BIGINT NOT NULL,
  UNIQUE(memory_id, revision)
);

CREATE TABLE IF NOT EXISTS memory_relations (
  id VARCHAR PRIMARY KEY,
  from_memory_id VARCHAR NOT NULL,
  relation VARCHAR NOT NULL CHECK (relation IN ('SUPERSEDES','CONTRADICTS','SUPPORTS','DUPLICATE_OF','DERIVED_FROM')),
  to_memory_id VARCHAR NOT NULL,
  created_at BIGINT NOT NULL,
  CHECK (from_memory_id <> to_memory_id),
  UNIQUE(from_memory_id, relation, to_memory_id)
);

CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id VARCHAR NOT NULL,
  model_id VARCHAR NOT NULL,
  model_version VARCHAR NOT NULL,
  content_hash VARCHAR NOT NULL,
  dimension BIGINT NOT NULL,
  embedding BLOB NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (memory_id, model_id, model_version)
);

CREATE TABLE IF NOT EXISTS memory_candidates (
  id VARCHAR PRIMARY KEY,
  task_id VARCHAR NOT NULL,
  kind VARCHAR NOT NULL,
  title VARCHAR NOT NULL,
  content VARCHAR NOT NULL,
  scope_type VARCHAR NOT NULL,
  scope_id VARCHAR,
  confidence DOUBLE NOT NULL,
  importance BIGINT NOT NULL,
  explicit BIGINT NOT NULL DEFAULT 0,
  operation_hint VARCHAR NOT NULL CHECK (operation_hint IN ('create','update','supersede','resolve','forget')),
  replaces VARCHAR,
  status VARCHAR NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','committed','rejected','needs_review')),
  raw_json VARCHAR,
  created_at BIGINT NOT NULL,
  resolved_at BIGINT,
  resolved_memory_id VARCHAR
);

CREATE TABLE IF NOT EXISTS memory_turns (
  id VARCHAR PRIMARY KEY,
  task_id VARCHAR NOT NULL,
  session_id VARCHAR,
  user_message_id VARCHAR,
  assistant_message_id VARCHAR,
  user_text VARCHAR NOT NULL,
  assistant_text VARCHAR NOT NULL,
  content_hash VARCHAR NOT NULL,
  captured_at BIGINT NOT NULL,
  extraction_state VARCHAR NOT NULL DEFAULT 'pending' CHECK (extraction_state IN ('pending','processing','completed','failed','skipped')),
  extracted_at BIGINT,
  attempt_count BIGINT NOT NULL DEFAULT 0,
  last_error VARCHAR,
  metadata_json VARCHAR NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json))
);

CREATE TABLE IF NOT EXISTS memory_pipeline_state (
  task_id VARCHAR PRIMARY KEY,
  captured_turns BIGINT NOT NULL DEFAULT 0,
  turns_since_l1 BIGINT NOT NULL DEFAULT 0,
  last_l1_at BIGINT,
  last_l2_at BIGINT,
  last_l3_at BIGINT,
  l1_run_count BIGINT NOT NULL DEFAULT 0,
  l2_run_count BIGINT NOT NULL DEFAULT 0,
  l3_run_count BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_projection_dismissals (
  id VARCHAR PRIMARY KEY,
  kind VARCHAR NOT NULL CHECK (kind IN ('scenario','profile')),
  title VARCHAR NOT NULL DEFAULT '',
  scope_type VARCHAR NOT NULL,
  scope_id VARCHAR,
  dismissed_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_projection_proposals (
  id VARCHAR PRIMARY KEY,
  kind VARCHAR NOT NULL CHECK (kind IN ('scenario','profile')),
  scope_type VARCHAR NOT NULL,
  scope_id VARCHAR,
  title VARCHAR NOT NULL,
  body VARCHAR NOT NULL,
  source_ids_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(source_ids_json)),
  target_id VARCHAR NOT NULL,
  status VARCHAR NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','rejected')),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_skill_effectiveness (
  id VARCHAR PRIMARY KEY,
  task_id VARCHAR NOT NULL,
  assistant_message_id VARCHAR NOT NULL,
  skill_id VARCHAR NOT NULL,
  candidate_id VARCHAR,
  source_memory_ids_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(source_memory_ids_json)),
  exposed_at BIGINT NOT NULL,
  invoked_at BIGINT,
  invocation_kind VARCHAR CHECK (invocation_kind IS NULL OR invocation_kind IN ('read','command')),
  tool_call_id VARCHAR,
  outcome VARCHAR NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending','completed','failed','aborted')),
  outcome_at BIGINT,
  feedback_kind VARCHAR CHECK (feedback_kind IS NULL OR feedback_kind IN ('helpful','needs_revision','incorrect')),
  feedback_note VARCHAR,
  feedback_at BIGINT,
  updated_at BIGINT NOT NULL,
  UNIQUE(task_id,assistant_message_id,skill_id),
  CHECK ((invoked_at IS NULL AND invocation_kind IS NULL) OR (invoked_at IS NOT NULL AND invocation_kind IS NOT NULL)),
  CHECK ((feedback_kind IS NULL AND feedback_at IS NULL) OR (feedback_kind IS NOT NULL AND feedback_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS memory_skill_revision_candidates (
  id VARCHAR PRIMARY KEY,
  skill_id VARCHAR NOT NULL,
  base_candidate_id VARCHAR,
  base_version VARCHAR NOT NULL,
  base_content_hash VARCHAR NOT NULL,
  title VARCHAR NOT NULL,
  status VARCHAR NOT NULL CHECK (status IN ('draft','ready','rejected','materialized','stale')),
  issue_summary VARCHAR NOT NULL,
  base_description VARCHAR NOT NULL,
  base_instructions VARCHAR NOT NULL,
  proposed_description VARCHAR NOT NULL,
  proposed_instructions VARCHAR NOT NULL,
  negative_feedback_ids_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(negative_feedback_ids_json)),
  source_memory_ids_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(source_memory_ids_json)),
  feedback_signature VARCHAR NOT NULL,
  needs_revision_count BIGINT NOT NULL DEFAULT 0 CHECK (needs_revision_count >= 0),
  incorrect_count BIGINT NOT NULL DEFAULT 0 CHECK (incorrect_count >= 0),
  failed_invocation_count BIGINT NOT NULL DEFAULT 0 CHECK (failed_invocation_count >= 0),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  resolved_at BIGINT,
  materialized_candidate_id VARCHAR,
  materialized_version VARCHAR
);

CREATE TABLE IF NOT EXISTS memory_capture_receipts (
  source_key VARCHAR PRIMARY KEY,
  memory_id VARCHAR NOT NULL,
  content_hash VARCHAR NOT NULL,
  suppressed BIGINT NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS "memory_skill_candidates" (
  id VARCHAR PRIMARY KEY,
  slug VARCHAR NOT NULL,
  title VARCHAR NOT NULL,
  description VARCHAR NOT NULL,
  instructions VARCHAR NOT NULL,
  status VARCHAR NOT NULL CHECK (status IN ('draft','ready','rejected','materialized','stale')),
  scope_type VARCHAR NOT NULL CHECK (scope_type IN ('global','workspace','project','bot')),
  scope_id VARCHAR,
  source_memory_ids_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(source_memory_ids_json)),
  source_signature VARCHAR NOT NULL,
  support_count BIGINT NOT NULL DEFAULT 0 CHECK (support_count >= 0),
  distinct_task_count BIGINT NOT NULL DEFAULT 0 CHECK (distinct_task_count >= 0),
  completed_task_count BIGINT NOT NULL DEFAULT 0 CHECK (completed_task_count >= 0 AND completed_task_count <= distinct_task_count),
  evidence_count BIGINT NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
  confidence DOUBLE NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  score DOUBLE NOT NULL DEFAULT 0 CHECK (score >= 0 AND score <= 1),
  installed_skill_id VARCHAR,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  resolved_at BIGINT,
  CHECK ((scope_type='global' AND scope_id IS NULL) OR (scope_type!='global' AND scope_id IS NOT NULL AND length(trim(scope_id)) > 0))
);

CREATE TABLE IF NOT EXISTS memory_scenarios (
  id VARCHAR PRIMARY KEY,
  scope_type VARCHAR NOT NULL CHECK (scope_type IN ('global','workspace','project') OR (scope_type='task' AND scope_id='mybuddy-dots')),
  scope_id VARCHAR,
  title VARCHAR NOT NULL,
  summary VARCHAR NOT NULL,
  status VARCHAR NOT NULL DEFAULT 'active' CHECK (status IN ('active','stale')),
  source_memory_ids_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(source_memory_ids_json)),
  content_hash VARCHAR NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CHECK ((scope_type='global' AND scope_id IS NULL) OR (scope_type!='global' AND scope_id IS NOT NULL AND length(trim(scope_id)) > 0))
);

CREATE TABLE IF NOT EXISTS memory_core_profiles (
  id VARCHAR PRIMARY KEY,
  scope_type VARCHAR NOT NULL CHECK (scope_type IN ('global','workspace','project') OR (scope_type='task' AND scope_id='mybuddy-dots')),
  scope_id VARCHAR,
  title VARCHAR NOT NULL,
  content VARCHAR NOT NULL,
  status VARCHAR NOT NULL DEFAULT 'active' CHECK (status IN ('active','stale')),
  source_scenario_ids_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(source_scenario_ids_json)),
  content_hash VARCHAR NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CHECK ((scope_type='global' AND scope_id IS NULL) OR (scope_type!='global' AND scope_id IS NOT NULL AND length(trim(scope_id)) > 0))
);

CREATE TABLE IF NOT EXISTS memory_search_epoch(
  id BIGINT PRIMARY KEY CHECK(id=1),
  text_version BIGINT NOT NULL,
  vector_version BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_loadout_observations (
  id VARCHAR PRIMARY KEY,
  task_id VARCHAR NOT NULL,
  user_message_id VARCHAR NOT NULL,
  assistant_message_id VARCHAR NOT NULL,
  query_hash VARCHAR NOT NULL,
  context_json VARCHAR NOT NULL DEFAULT '{}' CHECK (json_valid(context_json)),
  recommended_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(recommended_json)),
  actual_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(actual_json)),
  matched_actual_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(matched_actual_json)),
  not_selected_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(not_selected_json)),
  blocked_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(blocked_json)),
  used_skill_ids_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(used_skill_ids_json)),
  outcome VARCHAR NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending','completed','failed','aborted')),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  completed_at BIGINT,
  UNIQUE(task_id, assistant_message_id)
);

CREATE TABLE IF NOT EXISTS conversation_branches (
  child_task_id            VARCHAR PRIMARY KEY,
  parent_task_id           VARCHAR NOT NULL,
  root_task_id             VARCHAR NOT NULL,
  parent_title_snapshot    VARCHAR NOT NULL,
  source_session_file      VARCHAR NOT NULL,
  source_leaf_entry_id     VARCHAR NOT NULL,
  source_user_message_index BIGINT NOT NULL,
  request_id               VARCHAR NOT NULL UNIQUE,
  source_position          VARCHAR NOT NULL
          CHECK (source_position IN ('after_user', 'after_reply')),
  workspace_strategy       VARCHAR NOT NULL
          CHECK (workspace_strategy IN ('shared_space', 'current_snapshot', 'conversation_only')),
  created_at               BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_attempts (
  id VARCHAR PRIMARY KEY,
  task_id VARCHAR NOT NULL,
  execution_id VARCHAR NOT NULL,
  assistant_message_id VARCHAR NOT NULL,
  tool_call_id VARCHAR NOT NULL,
  target VARCHAR NOT NULL,
  status VARCHAR NOT NULL CHECK(status IN ('running','passed','failed','inconclusive')),
  record_json VARCHAR NOT NULL CHECK(json_valid(record_json)),
  created_at BIGINT NOT NULL,
  finished_at BIGINT
);

CREATE TABLE IF NOT EXISTS conversation_interactions (
  id VARCHAR PRIMARY KEY,
  task_id VARCHAR NOT NULL,
  execution_id VARCHAR NOT NULL,
  assistant_message_id VARCHAR NOT NULL,
  kind VARCHAR NOT NULL CHECK (kind IN ('confirm','single_select','multi_select','short_text','long_text')),
  title VARCHAR NOT NULL,
  description VARCHAR,
  options_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(options_json)),
  min_selections BIGINT,
  max_selections BIGINT,
  allow_custom BIGINT NOT NULL DEFAULT 0 CHECK (allow_custom IN (0,1)),
  custom_placeholder VARCHAR,
  status VARCHAR NOT NULL CHECK (status IN ('pending','resolved','cancelled','expired')),
  answer_json VARCHAR CHECK (answer_json IS NULL OR json_valid(answer_json)),
  version BIGINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  resolved_at BIGINT
);

CREATE TABLE IF NOT EXISTS bots (
  bot_id VARCHAR PRIMARY KEY,
  user_id VARCHAR NOT NULL,
  display_name VARCHAR NOT NULL,
  responsibility_summary VARCHAR NOT NULL DEFAULT '',
  expert_profile_json VARCHAR NOT NULL CHECK (json_valid(expert_profile_json)),
  memory_scope_json VARCHAR NOT NULL CHECK (json_valid(memory_scope_json)),
  authorization_json VARCHAR NOT NULL CHECK (json_valid(authorization_json)),
  foreground_allowed_tools_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(foreground_allowed_tools_json)),
  notification_policy_json VARCHAR NOT NULL DEFAULT '{}' CHECK (json_valid(notification_policy_json)),
  status VARCHAR NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','disabled')),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_channel_bindings (
  channel_type VARCHAR NOT NULL CHECK (channel_type IN ('desktop','mobile','remote','gateway')),
  channel_identifier VARCHAR NOT NULL,
  bot_id VARCHAR NOT NULL,
  bound_at BIGINT NOT NULL,
  PRIMARY KEY (channel_type, channel_identifier)
);

CREATE TABLE IF NOT EXISTS bot_expert_versions (
  bot_id VARCHAR NOT NULL,
  version BIGINT NOT NULL CHECK (version > 0),
  state VARCHAR NOT NULL CHECK (state IN ('pending','active','superseded')),
  expert_id VARCHAR NOT NULL,
  source_revision VARCHAR NOT NULL,
  system_prompt_hash VARCHAR NOT NULL,
  configuration_json VARCHAR CHECK (configuration_json IS NULL OR json_valid(configuration_json)),
  skill_packages_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(skill_packages_json)),
  allowed_mcp_ids_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(allowed_mcp_ids_json)),
  allowed_skill_ids_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(allowed_skill_ids_json)),
  allowed_connector_ids_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(allowed_connector_ids_json)),
  staged_by VARCHAR NOT NULL,
  created_at BIGINT NOT NULL,
  adopted_at BIGINT,
  PRIMARY KEY (bot_id, version)
);

CREATE TABLE IF NOT EXISTS works (
  work_id VARCHAR PRIMARY KEY,
  user_id VARCHAR NOT NULL,
  project_id VARCHAR,
  workspace_path VARCHAR,
  source_message_id VARCHAR,
  legacy_task_id VARCHAR,
  owner_bot_id VARCHAR NOT NULL,
  owner_epoch BIGINT NOT NULL DEFAULT 1 CHECK (owner_epoch > 0),
  intent_revision BIGINT NOT NULL DEFAULT 1 CHECK (intent_revision > 0),
  source_version BIGINT NOT NULL DEFAULT 1 CHECK (source_version > 0),
  title VARCHAR NOT NULL,
  goal_description VARCHAR,
  constraints_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(constraints_json)),
  criteria_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(criteria_json)),
  authorization_json VARCHAR NOT NULL CHECK (json_valid(authorization_json)),
  active_intent_snapshot_id VARCHAR NOT NULL,
  input_snapshot_id VARCHAR NOT NULL,
  goal_sources_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(goal_sources_json)),
  mode VARCHAR NOT NULL DEFAULT 'once' CHECK (mode IN ('once','watch')),
  lifecycle VARCHAR NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','paused','closing','closed')),
  pending_conclusion VARCHAR CHECK (pending_conclusion IS NULL OR pending_conclusion IN ('succeeded','cancelled','ended_unsuccessfully')),
  cancel_requested_at BIGINT,
  closure_conclusion VARCHAR CHECK (closure_conclusion IS NULL OR closure_conclusion IN ('succeeded','cancelled','ended_unsuccessfully')),
  closure_summary VARCHAR,
  accepted_deliverable_ids_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(accepted_deliverable_ids_json)),
  active_execution_ids_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(active_execution_ids_json)),
  progress_summary VARCHAR,
  watch_rule_json VARCHAR CHECK (watch_rule_json IS NULL OR json_valid(watch_rule_json)),
  state_version BIGINT NOT NULL DEFAULT 1 CHECK (state_version > 0),
  created_by VARCHAR NOT NULL CHECK (created_by IN ('user','bot')),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  closed_at BIGINT,
  close_operation_id VARCHAR,
  deadline_at BIGINT,
  deadline_revision BIGINT NOT NULL DEFAULT 1,
  deadline_set_at BIGINT,
  causal_policy_json VARCHAR NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS work_intent_snapshots (
  snapshot_id VARCHAR PRIMARY KEY,
  work_id VARCHAR NOT NULL,
  intent_revision BIGINT NOT NULL,
  source_version BIGINT NOT NULL,
  title VARCHAR NOT NULL,
  goal_description VARCHAR,
  constraints_json VARCHAR NOT NULL CHECK (json_valid(constraints_json)),
  criteria_json VARCHAR NOT NULL CHECK (json_valid(criteria_json)),
  authorization_json VARCHAR NOT NULL CHECK (json_valid(authorization_json)),
  expert_snapshot_json VARCHAR NOT NULL CHECK (json_valid(expert_snapshot_json)),
  input_snapshot_id VARCHAR NOT NULL,
  goal_sources_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(goal_sources_json)),
  created_by VARCHAR NOT NULL CHECK (created_by IN ('user','bot')),
  source_message_id VARCHAR,
  created_at BIGINT NOT NULL,
  UNIQUE (work_id, intent_revision, source_version)
);

CREATE TABLE IF NOT EXISTS work_conversations (
  work_id VARCHAR NOT NULL,
  conversation_id VARCHAR NOT NULL,
  channel_type VARCHAR NOT NULL DEFAULT 'desktop',
  last_referenced_at BIGINT NOT NULL,
  PRIMARY KEY (work_id, conversation_id)
);

CREATE TABLE IF NOT EXISTS work_message_refs (
  work_id VARCHAR NOT NULL,
  conversation_id VARCHAR NOT NULL,
  message_id VARCHAR NOT NULL,
  PRIMARY KEY (work_id, conversation_id, message_id)
);

CREATE TABLE IF NOT EXISTS work_participants (
  work_id VARCHAR NOT NULL,
  bot_id VARCHAR NOT NULL,
  role VARCHAR NOT NULL CHECK (role IN ('collaborator','worker','watcher')),
  delegated_scope_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(delegated_scope_json)),
  expert_snapshot_json VARCHAR NOT NULL CHECK (json_valid(expert_snapshot_json)),
  added_at BIGINT NOT NULL,
  PRIMARY KEY (work_id, bot_id)
);

CREATE TABLE IF NOT EXISTS work_execution_bindings (
  binding_id VARCHAR PRIMARY KEY,
  work_id VARCHAR NOT NULL,
  operation_id VARCHAR NOT NULL,
  bot_id VARCHAR NOT NULL,
  task_id VARCHAR NOT NULL,
  durable_store_key VARCHAR NOT NULL,
  conversation_id VARCHAR NOT NULL,
  intent_revision BIGINT NOT NULL,
  owner_epoch BIGINT NOT NULL,
  input_snapshot_id VARCHAR NOT NULL,
  expert_snapshot_json VARCHAR NOT NULL CHECK (json_valid(expert_snapshot_json)),
  delegated_scope_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(delegated_scope_json)),
  workspace_binding VARCHAR NOT NULL,
  status VARCHAR NOT NULL CHECK (status IN ('pending','submitted','running','completed','failed','stopped','unknown','invalidated')),
  attempt_id VARCHAR,
  submission_receipt VARCHAR,
  settlement_note VARCHAR,
  admitted_at BIGINT NOT NULL,
  submitted_at BIGINT,
  invalidated_at BIGINT,
  settled_at BIGINT,
  inbox_event_id VARCHAR,
  UNIQUE (work_id, operation_id)
);

CREATE TABLE IF NOT EXISTS work_action_admissions (
  admission_id VARCHAR PRIMARY KEY,
  work_id VARCHAR NOT NULL,
  binding_id VARCHAR,
  operation_id VARCHAR NOT NULL,
  action_kind VARCHAR NOT NULL,
  state VARCHAR NOT NULL CHECK (state IN ('admitted','consumed','released','unknown')),
  intent_revision BIGINT NOT NULL,
  owner_epoch BIGINT NOT NULL,
  admitted_at BIGINT NOT NULL,
  settled_at BIGINT,
  UNIQUE (work_id, operation_id, admission_id)
);

CREATE TABLE IF NOT EXISTS work_deliverables (
  deliverable_id VARCHAR PRIMARY KEY,
  work_id VARCHAR NOT NULL,
  producer_bot_id VARCHAR NOT NULL,
  execution_id VARCHAR NOT NULL,
  intent_revision BIGINT NOT NULL,
  owner_epoch BIGINT NOT NULL,
  input_snapshot_id VARCHAR NOT NULL,
  status VARCHAR NOT NULL CHECK (status IN ('proposed','accepted','rejected','superseded')),
  summary VARCHAR NOT NULL,
  artifact_refs_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(artifact_refs_json)),
  evidence_refs_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_refs_json)),
  uncovered_scope_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(uncovered_scope_json)),
  uncovered_criterion_ids_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(uncovered_criterion_ids_json)),
  is_speculation BIGINT NOT NULL DEFAULT 0 CHECK (is_speculation IN (0,1)),
  has_write_conflicts BIGINT NOT NULL DEFAULT 0 CHECK (has_write_conflicts IN (0,1)),
  rejected_reason VARCHAR,
  created_at BIGINT NOT NULL,
  reviewed_at BIGINT,
  reviewed_by_bot_id VARCHAR
);

CREATE TABLE IF NOT EXISTS work_evidence (
  evidence_id VARCHAR PRIMARY KEY,
  work_id VARCHAR NOT NULL,
  deliverable_id VARCHAR,
  execution_id VARCHAR,
  criterion_ids_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(criterion_ids_json)),
  kind VARCHAR NOT NULL CHECK (kind IN ('automated_test','tool_receipt','inspection','artifact','real_environment','user_attestation')),
  provenance VARCHAR NOT NULL CHECK (provenance IN ('execution','user','system')),
  source_ref VARCHAR NOT NULL,
  source_sha VARCHAR,
  input_snapshot_id VARCHAR NOT NULL,
  environment VARCHAR,
  intent_revision BIGINT NOT NULL,
  detail VARCHAR,
  recorded_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_blockers (
  blocker_id VARCHAR PRIMARY KEY,
  work_id VARCHAR NOT NULL,
  reported_by_bot_id VARCHAR,
  reason VARCHAR NOT NULL,
  kind VARCHAR NOT NULL CHECK (kind IN ('external_effect','backpressure','write_conflict','operational')),
  unknown_external_effect_ref VARCHAR,
  waiting_for_user_input BIGINT NOT NULL DEFAULT 0 CHECK (waiting_for_user_input IN (0,1)),
  status VARCHAR NOT NULL DEFAULT 'open' CHECK (status IN ('open','cleared')),
  created_at BIGINT NOT NULL,
  cleared_at BIGINT,
  reason_code VARCHAR,
  details_json VARCHAR NOT NULL DEFAULT '{}',
  source_ref VARCHAR,
  subscription_id VARCHAR,
  causal_chain_id VARCHAR
);

CREATE TABLE IF NOT EXISTS work_operation_receipts (
  user_id VARCHAR NOT NULL,
  operation_id VARCHAR NOT NULL,
  work_id VARCHAR,
  operation_type VARCHAR NOT NULL,
  payload_hash VARCHAR NOT NULL,
  result_snapshot_json VARCHAR NOT NULL CHECK (json_valid(result_snapshot_json)),
  outbox_event_id VARCHAR,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, operation_id)
);

CREATE TABLE IF NOT EXISTS work_host_lease (
  lease_id VARCHAR PRIMARY KEY CHECK (lease_id = 'singleton'),
  authority_id VARCHAR NOT NULL,
  acquired_at BIGINT NOT NULL,
  heartbeat_at BIGINT NOT NULL,
  released_at BIGINT
);

CREATE TABLE IF NOT EXISTS work_telemetry_state (
  work_id VARCHAR PRIMARY KEY,
  active_execution_id VARCHAR,
  streaming_text VARCHAR,
  tokens_per_second DOUBLE,
  last_heartbeat_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_source_events (
  source VARCHAR NOT NULL,
  source_event_id VARCHAR NOT NULL,
  event_type VARCHAR NOT NULL,
  source_version VARCHAR,
  causal_event_id VARCHAR,
  payload_json VARCHAR NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  received_at BIGINT NOT NULL,
  occurred_at BIGINT,
  target_key VARCHAR,
  payload_bytes BIGINT NOT NULL DEFAULT 0,
  adapter VARCHAR,
  trusted_origin VARCHAR,
  PRIMARY KEY (source, source_event_id)
);

CREATE TABLE IF NOT EXISTS work_events_inbox (
  event_id VARCHAR PRIMARY KEY,
  dedupe_key VARCHAR NOT NULL UNIQUE,
  source VARCHAR NOT NULL,
  source_event_id VARCHAR NOT NULL,
  event_type VARCHAR NOT NULL,
  work_id VARCHAR NOT NULL,
  subscription_id VARCHAR,
  intent_revision BIGINT NOT NULL,
  state_version BIGINT NOT NULL,
  owner_epoch BIGINT NOT NULL,
  source_version VARCHAR,
  causal_event_id VARCHAR,
  payload_json VARCHAR NOT NULL CHECK (json_valid(payload_json)),
  status VARCHAR NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','merged','skipped','blocked','processed')),
  merged_count BIGINT NOT NULL DEFAULT 1,
  merge_deadline_at BIGINT,
  received_at BIGINT NOT NULL,
  processed_at BIGINT,
  queued_while_paused BIGINT NOT NULL DEFAULT 0 CHECK(queued_while_paused IN (0,1)),
  batch_id VARCHAR,
  batch_deadline_at BIGINT,
  frozen_at BIGINT,
  frozen_payload_json VARCHAR,
  claim_version BIGINT NOT NULL DEFAULT 0,
  target_key VARCHAR,
  process_reason VARCHAR
);

CREATE TABLE IF NOT EXISTS work_events_outbox (
  event_id VARCHAR PRIMARY KEY,
  dedupe_key VARCHAR NOT NULL UNIQUE,
  event_type VARCHAR NOT NULL,
  work_id VARCHAR NOT NULL,
  binding_id VARCHAR,
  intent_revision BIGINT NOT NULL,
  state_version BIGINT NOT NULL,
  owner_epoch BIGINT NOT NULL,
  request_id VARCHAR NOT NULL,
  causal_event_id VARCHAR,
  payload_json VARCHAR NOT NULL CHECK (json_valid(payload_json)),
  delivery_status VARCHAR NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending','attempted','delivered','unknown','invalidated')),
  attempt_id VARCHAR,
  attempt_count BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  delivered_at BIGINT
);

CREATE TABLE IF NOT EXISTS work_subscriptions (
  subscription_id VARCHAR PRIMARY KEY,
  work_id VARCHAR NOT NULL,
  source VARCHAR NOT NULL,
  filter_json VARCHAR NOT NULL DEFAULT '{}' CHECK (json_valid(filter_json)),
  catch_up_policy VARCHAR NOT NULL CHECK (catch_up_policy IN ('latest','each','skip')),
  max_merge_wait_ms BIGINT NOT NULL,
  max_queue_depth BIGINT NOT NULL,
  stop_condition_text VARCHAR,
  timezone VARCHAR,
  cron_expression VARCHAR,
  next_wake_at BIGINT,
  last_processed_source_version VARCHAR,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  stopped_at BIGINT,
  schedule_revision BIGINT NOT NULL DEFAULT 1,
  config_revision BIGINT NOT NULL DEFAULT 1,
  source_target VARCHAR,
  version_mode VARCHAR NOT NULL DEFAULT 'readback',
  dst_policy VARCHAR NOT NULL DEFAULT 'first-valid',
  max_backlog_events BIGINT NOT NULL DEFAULT 400,
  max_backlog_bytes BIGINT NOT NULL DEFAULT 8388608,
  last_checked_at BIGINT,
  stopped_reason VARCHAR,
  config_json VARCHAR NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS work_notifications (
  notification_id VARCHAR PRIMARY KEY,
  work_id VARCHAR NOT NULL,
  semantic_key VARCHAR NOT NULL UNIQUE,
  kind VARCHAR NOT NULL CHECK (kind IN ('result','blocked','closed','handoff','summary')),
  title VARCHAR NOT NULL,
  body VARCHAR,
  state_version BIGINT NOT NULL,
  intent_revision BIGINT NOT NULL,
  delivery VARCHAR NOT NULL DEFAULT 'pending' CHECK (delivery IN ('pending','sent','unknown','failed')),
  channel VARCHAR,
  idempotency_key VARCHAR,
  attempt_count BIGINT NOT NULL DEFAULT 0,
  external_receipt VARCHAR,
  read_at BIGINT,
  created_at BIGINT NOT NULL,
  sent_at BIGINT,
  card_key VARCHAR,
  target_key VARCHAR,
  effect_key VARCHAR
);

CREATE TABLE IF NOT EXISTS bot_conversations (
  conversation_id VARCHAR PRIMARY KEY,
  bot_id VARCHAR NOT NULL,
  user_id VARCHAR NOT NULL,
  revision BIGINT NOT NULL DEFAULT 0,
  current_request_id VARCHAR,
  archived_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  team_id VARCHAR,
  ingress_kind VARCHAR NOT NULL DEFAULT 'desktop' CHECK(ingress_kind IN ('desktop','gateway')),
  source_kind VARCHAR NOT NULL DEFAULT 'user' CHECK(source_kind IN ('user','peer'))
);

CREATE TABLE IF NOT EXISTS bot_messages (
  ordinal BIGINT PRIMARY KEY,
  message_id VARCHAR NOT NULL UNIQUE,
  conversation_id VARCHAR NOT NULL,
  bot_id VARCHAR NOT NULL,
  request_id VARCHAR NOT NULL,
  role VARCHAR NOT NULL CHECK(role IN ('user','assistant')),
  text VARCHAR NOT NULL,
  status VARCHAR NOT NULL CHECK(status IN ('queued','running','completed','cancelled','unknown','failed')),
  work_ids_json VARCHAR NOT NULL DEFAULT '[]' CHECK(json_valid(work_ids_json)),
  error VARCHAR,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(conversation_id,request_id,role)
);

CREATE TABLE IF NOT EXISTS bot_message_revisions (
  message_id VARCHAR PRIMARY KEY,
  revision BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_request_runs (
  message_id VARCHAR PRIMARY KEY,
  runtime_key VARCHAR NOT NULL UNIQUE,
  context_json VARCHAR NOT NULL CHECK(json_valid(context_json)),
  transcript_json VARCHAR CHECK(transcript_json IS NULL OR json_valid(transcript_json)),
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_message_activity (
  message_id VARCHAR PRIMARY KEY,
  activity_json VARCHAR NOT NULL CHECK(json_valid(activity_json))
);

CREATE TABLE IF NOT EXISTS bot_message_attachments (
  message_id VARCHAR PRIMARY KEY,
  attachments_json VARCHAR NOT NULL CHECK(json_valid(attachments_json))
);

CREATE TABLE IF NOT EXISTS bot_work_attachments (
  work_id VARCHAR NOT NULL,
  input_snapshot_id VARCHAR NOT NULL,
  attachments_json VARCHAR NOT NULL CHECK(json_valid(attachments_json)),
  PRIMARY KEY(work_id, input_snapshot_id)
);

CREATE TABLE IF NOT EXISTS bot_work_user_inputs (
  work_id VARCHAR NOT NULL,
  source_message_id VARCHAR NOT NULL,
  intent_revision BIGINT NOT NULL,
  source_version BIGINT NOT NULL,
  messages_json VARCHAR NOT NULL CHECK(json_valid(messages_json)),
  references_json VARCHAR NOT NULL CHECK(json_valid(references_json)),
  PRIMARY KEY(work_id, source_message_id)
);

CREATE TABLE IF NOT EXISTS bot_work_feedback (
  message_id VARCHAR PRIMARY KEY,
  metadata_json VARCHAR NOT NULL CHECK(json_valid(metadata_json))
);

CREATE TABLE IF NOT EXISTS bot_send_receipts (
  user_id VARCHAR NOT NULL,
  bot_id VARCHAR NOT NULL,
  request_id VARCHAR NOT NULL,
  payload_hash VARCHAR NOT NULL,
  conversation_id VARCHAR NOT NULL,
  user_message_id VARCHAR NOT NULL,
  assistant_message_id VARCHAR NOT NULL,
  selected_work_id VARCHAR,
  reference_message_id VARCHAR,
  PRIMARY KEY(user_id,bot_id,request_id)
);

CREATE TABLE IF NOT EXISTS bot_cancel_intents (
  conversation_id VARCHAR NOT NULL,
  request_id VARCHAR NOT NULL,
  confirmed_at BIGINT,
  PRIMARY KEY(conversation_id,request_id)
);

CREATE TABLE IF NOT EXISTS work_dispatch_requests (
  operation_id VARCHAR PRIMARY KEY,
  work_id VARCHAR NOT NULL,
  task_id VARCHAR NOT NULL UNIQUE,
  bot_id VARCHAR NOT NULL,
  intent_revision BIGINT NOT NULL,
  input_snapshot_id VARCHAR NOT NULL,
  state VARCHAR NOT NULL CHECK(state IN ('pending','dispatched','cancelled','blocked')),
  error VARCHAR,
  attempts BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  continuation_plan_id VARCHAR,
  inbox_event_id VARCHAR
);

CREATE TABLE IF NOT EXISTS bot_work_reads (
  conversation_id VARCHAR NOT NULL,
  request_id VARCHAR NOT NULL,
  work_id VARCHAR NOT NULL,
  guard_json VARCHAR NOT NULL CHECK(json_valid(guard_json)),
  PRIMARY KEY(conversation_id,request_id,work_id)
);

CREATE TABLE IF NOT EXISTS work_native_inbox (
  fact_id VARCHAR PRIMARY KEY,
  binding_id VARCHAR NOT NULL,
  namespace_hash VARCHAR NOT NULL,
  payload_json VARCHAR NOT NULL CHECK(json_valid(payload_json)),
  received_at BIGINT NOT NULL,
  consumed_at BIGINT,
  consume_error VARCHAR
);

CREATE TABLE IF NOT EXISTS work_native_cursors (
  binding_id VARCHAR PRIMARY KEY,
  fact_id VARCHAR NOT NULL,
  read_failures BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_native_recovery (
  binding_id VARCHAR PRIMARY KEY,
  failures BIGINT NOT NULL DEFAULT 0,
  cycle_id VARCHAR NOT NULL DEFAULT (lower(replace(CAST(uuid() AS VARCHAR), '-', ''))),
  first_failure_at BIGINT NOT NULL,
  last_error VARCHAR NOT NULL,
  exhausted_at BIGINT
);

CREATE TABLE IF NOT EXISTS work_projection_streams (
  user_id VARCHAR PRIMARY KEY,
  epoch VARCHAR NOT NULL DEFAULT (lower(replace(CAST(uuid() AS VARCHAR), '-', ''))),
  sequence BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS work_projection_events (
  user_id VARCHAR NOT NULL,
  sequence BIGINT NOT NULL,
  work_id VARCHAR NOT NULL,
  PRIMARY KEY(user_id,sequence)
);

CREATE TABLE IF NOT EXISTS work_subitem_results (
  fact_id VARCHAR PRIMARY KEY,
  work_id VARCHAR NOT NULL,
  binding_id VARCHAR NOT NULL,
  item_id VARCHAR NOT NULL,
  result_json VARCHAR NOT NULL CHECK(json_valid(result_json)),
  deliverable_id VARCHAR,
  created_at BIGINT NOT NULL,
  UNIQUE(binding_id,item_id)
);

CREATE TABLE IF NOT EXISTS work_continuation_plans (
  plan_id VARCHAR PRIMARY KEY,
  work_id VARCHAR NOT NULL,
  source_binding_id VARCHAR NOT NULL,
  operation_id VARCHAR NOT NULL,
  intent_revision BIGINT NOT NULL,
  input_snapshot_id VARCHAR NOT NULL,
  owner_epoch BIGINT NOT NULL,
  owner_bot_id VARCHAR NOT NULL,
  gap_items_json VARCHAR NOT NULL CHECK(json_valid(gap_items_json)),
  reason VARCHAR NOT NULL,
  state VARCHAR NOT NULL CHECK(state IN ('pending','dispatched','settled','cancelled')),
  created_at BIGINT NOT NULL,
  UNIQUE(work_id,operation_id)
);

CREATE TABLE IF NOT EXISTS work_continuation_gaps (
  gap_key VARCHAR PRIMARY KEY,
  plan_id VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS work_artifact_dependencies (
  binding_id VARCHAR NOT NULL,
  path VARCHAR NOT NULL,
  work_id VARCHAR NOT NULL,
  fingerprint_json VARCHAR NOT NULL CHECK(json_valid(fingerprint_json)),
  invalidated_at BIGINT,
  PRIMARY KEY(binding_id,path)
);

CREATE TABLE IF NOT EXISTS work_generated_artifacts (
  binding_id VARCHAR NOT NULL,
  path VARCHAR NOT NULL,
  digest VARCHAR NOT NULL,
  payload_json VARCHAR NOT NULL CHECK(json_valid(payload_json)),
  PRIMARY KEY(binding_id,path,digest)
);

CREATE TABLE IF NOT EXISTS work_paused_source_routes (
  source VARCHAR NOT NULL,
  source_event_id VARCHAR NOT NULL,
  subscription_id VARCHAR NOT NULL,
  catch_up_policy VARCHAR NOT NULL CHECK(catch_up_policy IN ('latest','each','skip')),
  inbox_event_id VARCHAR,
  PRIMARY KEY(source,source_event_id,subscription_id)
);

CREATE TABLE IF NOT EXISTS work_collaboration_messages (
  message_id VARCHAR PRIMARY KEY,
  work_id VARCHAR NOT NULL,
  sender_bot_id VARCHAR,
  sender_kind VARCHAR NOT NULL CHECK(sender_kind IN ('user','bot','worker')),
  user_id VARCHAR NOT NULL,
  kind VARCHAR NOT NULL CHECK(kind IN ('delegate','accepted','question','result','blocked','change','cancel','handoff')),
  payload_hash VARCHAR NOT NULL,
  payload_json VARCHAR NOT NULL CHECK(json_valid(payload_json)),
  intent_revision BIGINT NOT NULL,
  input_snapshot_id VARCHAR NOT NULL,
  owner_epoch BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_handoff_preparations (
  preparation_id VARCHAR PRIMARY KEY,
  work_id VARCHAR NOT NULL,
  target_bot_id VARCHAR NOT NULL,
  state_version BIGINT NOT NULL,
  owner_epoch BIGINT NOT NULL,
  input_snapshot_id VARCHAR NOT NULL,
  snapshot_json VARCHAR NOT NULL CHECK(json_valid(snapshot_json)),
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_delegation_adoptions (
  binding_id VARCHAR NOT NULL,
  owner_epoch BIGINT NOT NULL,
  adopted_by_bot_id VARCHAR NOT NULL,
  intent_revision BIGINT NOT NULL,
  input_snapshot_id VARCHAR NOT NULL,
  delegated_scope_json VARCHAR NOT NULL CHECK(json_valid(delegated_scope_json)),
  operation_id VARCHAR NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY(binding_id,owner_epoch)
);

CREATE TABLE IF NOT EXISTS work_notification_identity (
  notification_id VARCHAR PRIMARY KEY,
  input_snapshot_id VARCHAR NOT NULL,
  owner_epoch BIGINT NOT NULL,
  sender_bot_id VARCHAR NOT NULL,
  semantic_validity VARCHAR NOT NULL DEFAULT 'active' CHECK(semantic_validity IN ('active','superseded','cancelled'))
);

CREATE TABLE IF NOT EXISTS work_notification_attempts (
  attempt_id VARCHAR PRIMARY KEY,
  notification_id VARCHAR NOT NULL,
  ordinal BIGINT NOT NULL CHECK(ordinal>0),
  channel VARCHAR NOT NULL,
  idempotency_key VARCHAR NOT NULL,
  provider_effect_key VARCHAR,
  payload_hash VARCHAR,
  delivery_guarantee VARCHAR,
  claim_generation BIGINT NOT NULL DEFAULT 1 CHECK(claim_generation>0),
  payload_json VARCHAR NOT NULL CHECK(json_valid(payload_json)),
  status VARCHAR NOT NULL CHECK(status IN ('unknown','sent','missing','failed')),
  claimed_at BIGINT NOT NULL,
  settled_at BIGINT,
  receipt VARCHAR,
  UNIQUE(notification_id,ordinal)
);

CREATE TABLE IF NOT EXISTS work_subscription_cursors (
  subscription_id VARCHAR NOT NULL,
  source VARCHAR NOT NULL,
  target_key VARCHAR NOT NULL,
  highest_accepted_version VARCHAR,
  highest_consumed_version VARCHAR,
  highest_frozen_version VARCHAR,
  replay_cursor VARCHAR,
  enumeration_watermark VARCHAR,
  accepted_events BIGINT NOT NULL DEFAULT 0,
  consumed_events BIGINT NOT NULL DEFAULT 0,
  accepted_bytes BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (subscription_id, source, target_key)
);

CREATE TABLE IF NOT EXISTS work_ingress_routes (
  source VARCHAR NOT NULL,
  source_event_id VARCHAR NOT NULL,
  subscription_id VARCHAR NOT NULL,
  work_id VARCHAR NOT NULL,
  target_key VARCHAR NOT NULL,
  inbox_event_id VARCHAR,
  state VARCHAR NOT NULL CHECK (state IN ('pending','accepted','merged','skipped','blocked','duplicate','rejected')),
  reason_code VARCHAR,
  source_version VARCHAR,
  trust VARCHAR NOT NULL DEFAULT 'adapter' CHECK (trust IN ('adapter','host','system')),
  accepted_at BIGINT NOT NULL,
  PRIMARY KEY (source, source_event_id, subscription_id)
);

CREATE TABLE IF NOT EXISTS work_schedule_ticks (
  tick_id VARCHAR PRIMARY KEY,
  subscription_id VARCHAR NOT NULL,
  work_id VARCHAR NOT NULL,
  schedule_revision BIGINT NOT NULL,
  logical_slot_key VARCHAR NOT NULL,
  planned_at BIGINT NOT NULL,
  effective_at BIGINT NOT NULL,
  status VARCHAR NOT NULL CHECK (status IN ('pending','dispatched','skipped','blocked')),
  merged_from_slot_keys_json VARCHAR NOT NULL DEFAULT '[]',
  inbox_event_id VARCHAR,
  offline_gap_id VARCHAR,
  created_at BIGINT NOT NULL,
  UNIQUE (subscription_id, schedule_revision, logical_slot_key)
);

CREATE TABLE IF NOT EXISTS work_offline_gaps (
  gap_id VARCHAR PRIMARY KEY,
  host_session_id VARCHAR NOT NULL,
  subscription_id VARCHAR,
  work_id VARCHAR,
  offline_gap_from BIGINT NOT NULL,
  offline_gap_to BIGINT NOT NULL,
  detected_by VARCHAR NOT NULL,
  confidence VARCHAR NOT NULL CHECK (confidence IN ('evidence','inferred')),
  policy VARCHAR NOT NULL CHECK (policy IN ('latest','each','skip')),
  policy_revision BIGINT NOT NULL,
  source_cursor VARCHAR,
  queryable BIGINT NOT NULL DEFAULT 0 CHECK (queryable IN (0,1)),
  recovered_count BIGINT NOT NULL DEFAULT 0,
  merged_count BIGINT NOT NULL DEFAULT 0,
  skipped_count BIGINT,
  unknown_count BIGINT,
  state VARCHAR NOT NULL CHECK (state IN ('open','recovering','recovered','unqueryable')),
  continuation_cursor VARCHAR,
  gap_reason VARCHAR,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (host_session_id, subscription_id, offline_gap_from)
);

CREATE TABLE IF NOT EXISTS work_causal_chains (
  chain_id VARCHAR PRIMARY KEY,
  root_event_id VARCHAR NOT NULL,
  parent_chain_id VARCHAR,
  parent_causal_event_id VARCHAR,
  origin_work_id VARCHAR NOT NULL,
  origin_bot_id VARCHAR,
  target_work_id VARCHAR NOT NULL,
  target_subscription_id VARCHAR,
  source VARCHAR NOT NULL,
  source_event_id VARCHAR,
  input_snapshot_id VARCHAR,
  target_state_hash VARCHAR,
  depth BIGINT NOT NULL CHECK (depth >= 0),
  hops BIGINT NOT NULL CHECK (hops >= 0),
  dispatch_count BIGINT NOT NULL DEFAULT 0 CHECK (dispatch_count >= 0),
  admission_key VARCHAR NOT NULL UNIQUE,
  decision VARCHAR NOT NULL CHECK (decision IN ('admitted','blocked-loop','blocked-depth','blocked-hops','unknown-attribution')),
  reason_code VARCHAR,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_watch_host_state (
  authority_id VARCHAR PRIMARY KEY,
  session_id VARCHAR NOT NULL,
  last_scan_at BIGINT,
  last_scan_cursor VARCHAR,
  active_since BIGINT,
  last_seen_at BIGINT NOT NULL,
  suspend_evidence VARCHAR,
  stopped_at BIGINT,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_deadline_instances (
  work_id VARCHAR NOT NULL,
  deadline_revision BIGINT NOT NULL,
  deadline_at BIGINT NOT NULL,
  state VARCHAR NOT NULL CHECK (state IN ('armed','followed-up','cancelled')),
  inbox_event_id VARCHAR,
  created_at BIGINT NOT NULL,
  followed_at BIGINT,
  PRIMARY KEY (work_id, deadline_revision, deadline_at)
);

CREATE TABLE IF NOT EXISTS work_result_cards (
  card_key VARCHAR PRIMARY KEY,
  semantic_card_key VARCHAR NOT NULL UNIQUE,
  work_id VARCHAR NOT NULL,
  user_id VARCHAR NOT NULL,
  kind VARCHAR NOT NULL CHECK (kind IN ('accepted_result','closure_succeeded','closure_cancelled','closure_failed','blocked_escalation','owner_summary')),
  previous_card_key VARCHAR,
  intent_revision BIGINT NOT NULL CHECK (intent_revision > 0),
  input_snapshot_id VARCHAR NOT NULL,
  origin_owner_epoch BIGINT NOT NULL CHECK (origin_owner_epoch > 0),
  canonical_outcome_hash VARCHAR NOT NULL,
  canonical_outcome_json VARCHAR NOT NULL CHECK (json_valid(canonical_outcome_json)),
  title VARCHAR NOT NULL,
  summary VARCHAR NOT NULL DEFAULT '',
  deliverable_ids_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(deliverable_ids_json)),
  evidence_ids_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_ids_json)),
  source_refs_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(source_refs_json)),
  artifact_refs_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(artifact_refs_json)),
  unverified_scope_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(unverified_scope_json)),
  created_at BIGINT NOT NULL,
  read_at BIGINT,
  read_by_user_id VARCHAR,
  read_version BIGINT NOT NULL DEFAULT 0 CHECK (read_version >= 0),
  CHECK (read_at IS NULL OR read_by_user_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS work_notification_effects (
  effect_key VARCHAR PRIMARY KEY,
  notification_id VARCHAR NOT NULL,
  payload_hash VARCHAR NOT NULL,
  payload_json VARCHAR NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  channel VARCHAR NOT NULL,
  target_key VARCHAR,
  delivery_guarantee VARCHAR NOT NULL CHECK (delivery_guarantee IN ('idempotent-queryable','idempotent-unqueryable','best-effort-unqueryable')),
  supports_idempotency_key BIGINT NOT NULL CHECK (supports_idempotency_key IN (0,1)),
  supports_receipt_query BIGINT NOT NULL CHECK (supports_receipt_query IN (0,1)),
  authorization_kind VARCHAR NOT NULL CHECK (authorization_kind IN ('initial','manual-resend')),
  authorization_operation_id VARCHAR NOT NULL,
  authorization_reason VARCHAR,
  resend_of_attempt_id VARCHAR,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS gateway_work_targets (
  target_key VARCHAR PRIMARY KEY,
  user_id VARCHAR NOT NULL,
  conversation_id VARCHAR NOT NULL,
  source_message_id VARCHAR NOT NULL,
  channel_id VARCHAR NOT NULL,
  channel_type VARCHAR NOT NULL,
  connection_key VARCHAR NOT NULL,
  chat_id VARCHAR NOT NULL,
  sender_id VARCHAR NOT NULL,
  target_json VARCHAR NOT NULL CHECK (json_valid(target_json)),
  created_at BIGINT NOT NULL,
  UNIQUE(user_id, conversation_id, source_message_id)
);

CREATE TABLE IF NOT EXISTS work_owner_summaries (
  work_id VARCHAR PRIMARY KEY,
  intent_revision BIGINT NOT NULL CHECK (intent_revision > 0),
  input_snapshot_id VARCHAR NOT NULL,
  owner_epoch BIGINT NOT NULL CHECK (owner_epoch > 0),
  digest VARCHAR NOT NULL,
  card_key VARCHAR,
  pending_decision_codes_json VARCHAR NOT NULL DEFAULT '[]' CHECK (json_valid(pending_decision_codes_json)),
  handled_watermark_json VARCHAR NOT NULL DEFAULT '{}' CHECK (json_valid(handled_watermark_json)),
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS gateway_inbox (
  delivery_id VARCHAR PRIMARY KEY,
  platform VARCHAR NOT NULL,
  channel_id VARCHAR NOT NULL,
  account_key VARCHAR NOT NULL,
  chat_id VARCHAR NOT NULL,
  session_key VARCHAR NOT NULL,
  message_id VARCHAR NOT NULL,
  payload_json VARCHAR NOT NULL,
  payload_hash VARCHAR NOT NULL,
  status VARCHAR NOT NULL CHECK(status IN ('pending','running','reply_pending','completed','blocked','unknown')),
  retry_count BIGINT NOT NULL DEFAULT 0 CHECK(retry_count >= 0),
  receipt_mode VARCHAR NOT NULL CHECK(receipt_mode IN ('pi-durable','none')),
  last_error VARCHAR,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(channel_id,account_key,chat_id,message_id)
);

CREATE TABLE IF NOT EXISTS gateway_outbox (
  delivery_id VARCHAR PRIMARY KEY,
  reply_text VARCHAR NOT NULL,
  reply_hash VARCHAR NOT NULL,
  status VARCHAR NOT NULL CHECK(status IN ('pending','sending','sent','blocked','failed','unknown')),
  retry_count BIGINT NOT NULL DEFAULT 0 CHECK(retry_count >= 0),
  next_attempt_at BIGINT NOT NULL DEFAULT 0,
  last_error VARCHAR,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  sent_at BIGINT
);

CREATE TABLE IF NOT EXISTS gateway_conversation_routes (
  seq BIGINT PRIMARY KEY,
  scope_id VARCHAR NOT NULL,
  delivery_key VARCHAR NOT NULL,
  task_id VARCHAR NOT NULL,
  kind VARCHAR NOT NULL CHECK(kind IN ('turn','new','obsolete_new')),
  accepted_at BIGINT NOT NULL,
  UNIQUE(scope_id, delivery_key)
);

CREATE TABLE IF NOT EXISTS work_effect_retirement_audit (
  entity_type VARCHAR NOT NULL,
  entity_id VARCHAR NOT NULL,
  provenance_json VARCHAR NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY(entity_type,entity_id)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id VARCHAR PRIMARY KEY,
  task_id VARCHAR NOT NULL,
  space_id VARCHAR,
  kind VARCHAR NOT NULL,
  source_type VARCHAR NOT NULL,
  entry_file VARCHAR,
  root_dir VARCHAR NOT NULL,
  storage_path VARCHAR,
  version BIGINT NOT NULL DEFAULT 1,
  capabilities_json VARCHAR NOT NULL DEFAULT '{}',
  title VARCHAR,
  mime_type VARCHAR,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  created_by_message_id VARCHAR,
  created_by_tool_call_id VARCHAR
);

CREATE TABLE IF NOT EXISTS artifact_task_revisions (
  task_id VARCHAR PRIMARY KEY,
  revision BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifact_write_receipts (
  task_id VARCHAR NOT NULL,
  operation_id VARCHAR NOT NULL,
  request_hash VARCHAR NOT NULL,
  result_json VARCHAR NOT NULL,
  PRIMARY KEY (task_id, operation_id)
);

CREATE TABLE IF NOT EXISTS artifact_task_state (
  task_id VARCHAR PRIMARY KEY,
  legacy_migrated_at BIGINT
);

CREATE TABLE IF NOT EXISTS artifact_message_refs (
  task_id VARCHAR NOT NULL,
  message_id VARCHAR NOT NULL,
  artifact_id VARCHAR NOT NULL,
  relation VARCHAR NOT NULL,
  tool_call_id VARCHAR,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (task_id, message_id, artifact_id, relation)
);

CREATE TABLE IF NOT EXISTS artifact_file_dependencies (
  artifact_id VARCHAR NOT NULL,
  file_path VARCHAR NOT NULL,
  dependency_kind VARCHAR NOT NULL DEFAULT 'runtime',
  created_at BIGINT NOT NULL,
  PRIMARY KEY (artifact_id, file_path)
);

CREATE TABLE IF NOT EXISTS library_index_state (
  key VARCHAR PRIMARY KEY,
  value VARCHAR NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_activation_targets (
  notification_id VARCHAR PRIMARY KEY,
  target_json VARCHAR NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_desktop_claims (
  dedupe_key VARCHAR PRIMARY KEY,
  claimed_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS dots_foreground_reads (
  input_id VARCHAR NOT NULL,
  call_id VARCHAR NOT NULL,
  source VARCHAR NOT NULL,
  description VARCHAR NOT NULL,
  characters BIGINT NOT NULL,
  excerpt VARCHAR,
  PRIMARY KEY(input_id,call_id)
);

CREATE TABLE IF NOT EXISTS dots_foreground_policies (
  input_id VARCHAR PRIMARY KEY,
  policy VARCHAR NOT NULL,
  exhausted BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS dots_foreground_handoffs (
  input_id VARCHAR PRIMARY KEY,
  data VARCHAR NOT NULL,
  linked BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS answer_rules (
  id VARCHAR PRIMARY KEY,
  revision BIGINT NOT NULL,
  project_id VARCHAR,
  source_id VARCHAR,
  source_hash VARCHAR,
  enabled BIGINT NOT NULL,
  config VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS answer_rule_uses (
  task_id VARCHAR NOT NULL,
  input_id VARCHAR NOT NULL,
  rule_id VARCHAR NOT NULL,
  revision BIGINT NOT NULL,
  title VARCHAR NOT NULL,
  "at" BIGINT NOT NULL,
  detail VARCHAR NOT NULL,
  PRIMARY KEY(task_id, input_id, rule_id, revision)
);

CREATE TABLE IF NOT EXISTS answer_rule_turns (
  task_id VARCHAR NOT NULL,
  input_id VARCHAR NOT NULL,
  rule_id VARCHAR NOT NULL,
  revision BIGINT NOT NULL,
  title VARCHAR NOT NULL,
  "at" BIGINT NOT NULL,
  detail VARCHAR NOT NULL,
  phrase VARCHAR NOT NULL,
  evidence VARCHAR,
  scope VARCHAR NOT NULL,
  status VARCHAR NOT NULL DEFAULT 'applied',
  snapshot VARCHAR,
  PRIMARY KEY(task_id, input_id)
);

CREATE TABLE IF NOT EXISTS answer_rule_versions (
  rule_id VARCHAR NOT NULL,
  revision BIGINT NOT NULL,
  "at" BIGINT NOT NULL,
  source VARCHAR NOT NULL,
  title VARCHAR NOT NULL,
  note VARCHAR NOT NULL DEFAULT '',
  config VARCHAR NOT NULL,
  PRIMARY KEY(rule_id, revision)
);

CREATE TABLE IF NOT EXISTS execution_failures (
  id VARCHAR PRIMARY KEY,
  task_id VARCHAR NOT NULL,
  cause_code VARCHAR NOT NULL,
  record_json VARCHAR NOT NULL,
  created_at BIGINT NOT NULL,
  resolved_at BIGINT,
  dismissed_at BIGINT
);

CREATE TABLE IF NOT EXISTS conversation_goal_generations (
  task_id VARCHAR NOT NULL,
  conversation_id VARCHAR NOT NULL,
  generation_id BIGINT NOT NULL,
  work_id VARCHAR NOT NULL,
  metadata VARCHAR NOT NULL CHECK(json_valid(metadata)),
  outcome VARCHAR,
  PRIMARY KEY(task_id, conversation_id, generation_id)
);

CREATE TABLE IF NOT EXISTS conversation_goal_auxiliary_scopes (
  execution_scope VARCHAR PRIMARY KEY,
  task_id VARCHAR NOT NULL,
  conversation_id VARCHAR NOT NULL,
  generation_id BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_goal_learned_skills (
  task_id VARCHAR NOT NULL,
  conversation_id VARCHAR NOT NULL,
  generation_id BIGINT NOT NULL,
  evidence_key VARCHAR NOT NULL,
  evidence_json VARCHAR NOT NULL CHECK(json_valid(evidence_json)),
  PRIMARY KEY(task_id, conversation_id, generation_id, evidence_key)
);

CREATE TABLE IF NOT EXISTS conversation_goal_saved_artifact_verification (
  work_id VARCHAR NOT NULL,
  artifact_id VARCHAR NOT NULL,
  verified_at BIGINT NOT NULL,
  PRIMARY KEY(work_id,artifact_id)
);

CREATE TABLE IF NOT EXISTS task_expert_bindings (
  task_id VARCHAR PRIMARY KEY,
  desired_json VARCHAR,
  active_json VARCHAR,
  desired_skills_json VARCHAR NOT NULL DEFAULT '[]',
  active_skills_json VARCHAR NOT NULL DEFAULT '[]',
  warnings_json VARCHAR NOT NULL DEFAULT '[]',
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS cron_run_inputs (
  run_id VARCHAR PRIMARY KEY,
  request_json VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS dots_schedule_origins(
  job_id VARCHAR PRIMARY KEY,
  source VARCHAR NOT NULL,
  conversation BIGINT NOT NULL,
  entry BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS dots_schedule_scopes(
  job_id VARCHAR PRIMARY KEY,
  task_id VARCHAR,
  space_id VARCHAR
);

CREATE TABLE IF NOT EXISTS dots_schedule_holds(
  job_id VARCHAR NOT NULL,
  holder VARCHAR NOT NULL,
  PRIMARY KEY(job_id,holder)
);

CREATE TABLE IF NOT EXISTS dots_schedule_notices(
  job_id VARCHAR PRIMARY KEY,
  occurrence BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS external_agent_runs (
  id VARCHAR PRIMARY KEY,
  task_id VARCHAR NOT NULL,
  agent_id VARCHAR NOT NULL,
  agent_name VARCHAR NOT NULL,
  protocol VARCHAR NOT NULL DEFAULT 'acp',
  status VARCHAR NOT NULL,
  cwd VARCHAR NOT NULL,
  session_id VARCHAR,
  user_message_id VARCHAR NOT NULL,
  assistant_message_id VARCHAR NOT NULL,
  prompt VARCHAR NOT NULL,
  display_text VARCHAR,
  attachments_json VARCHAR,
  final_text VARCHAR NOT NULL DEFAULT '',
  thinking_text VARCHAR NOT NULL DEFAULT '',
  tools_json VARCHAR NOT NULL DEFAULT '[]',
  started_at BIGINT NOT NULL,
  completed_at BIGINT,
  error VARCHAR,
  continued_from_run_id VARCHAR,
  continuation_mode VARCHAR,
  output_cursor BIGINT NOT NULL DEFAULT 0,
  artifact_refs_json VARCHAR NOT NULL DEFAULT '[]',
  resume_supported BIGINT NOT NULL DEFAULT 0,
  cancellation_evidence VARCHAR,
  cancel_supported BIGINT NOT NULL DEFAULT 1,
  verification_status VARCHAR NOT NULL DEFAULT 'not_verified',
  recovery_state VARCHAR NOT NULL DEFAULT 'none',
  recovery_message VARCHAR
);

CREATE TABLE IF NOT EXISTS task_request_diagnostics (
  request_id VARCHAR PRIMARY KEY,
  task_id VARCHAR,
  started_at BIGINT NOT NULL,
  record_json VARCHAR NOT NULL CHECK(json_valid(record_json))
);

CREATE TABLE IF NOT EXISTS task_tool_diagnostics (
  id VARCHAR PRIMARY KEY,
  task_id VARCHAR NOT NULL,
  started_at BIGINT NOT NULL,
  record_json VARCHAR NOT NULL CHECK(json_valid(record_json))
);

CREATE TABLE IF NOT EXISTS scope_tool_diagnostics (
  id VARCHAR PRIMARY KEY,
  task_id VARCHAR NOT NULL,
  started_at BIGINT NOT NULL,
  record_json VARCHAR NOT NULL CHECK(json_valid(record_json))
);

CREATE TABLE IF NOT EXISTS bot_gateway_conversations (
  conversation_id VARCHAR PRIMARY KEY,
  user_id VARCHAR NOT NULL,
  bot_id VARCHAR NOT NULL,
  channel_id VARCHAR NOT NULL,
  connection_key VARCHAR NOT NULL,
  chat_id VARCHAR NOT NULL,
  audience VARCHAR NOT NULL CHECK(audience IN ('private','shared'))
);

CREATE TABLE IF NOT EXISTS bot_turn_origins (
  user_message_id VARCHAR PRIMARY KEY,
  user_id VARCHAR NOT NULL,
  bot_id VARCHAR NOT NULL,
  conversation_id VARCHAR NOT NULL,
  origin_json VARCHAR NOT NULL CHECK(json_valid(origin_json))
);

CREATE TABLE IF NOT EXISTS bot_gateway_references (
  user_message_id VARCHAR PRIMARY KEY,
  context_text VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS work_execution_metrics(
  binding_id VARCHAR PRIMARY KEY,
  task_id VARCHAR NOT NULL UNIQUE,
  conversation_id VARCHAR NOT NULL,
  started_at BIGINT NOT NULL,
  value_json VARCHAR,
  dirty BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS work_execution_usage(
  binding_id VARCHAR NOT NULL,
  call_key VARCHAR NOT NULL,
  value_json VARCHAR NOT NULL,
  PRIMARY KEY(binding_id,call_key)
);

CREATE TABLE IF NOT EXISTS work_execution_timings(
  binding_id VARCHAR NOT NULL,
  message_id VARCHAR NOT NULL,
  value_json VARCHAR NOT NULL,
  PRIMARY KEY(binding_id,message_id)
);

CREATE TABLE IF NOT EXISTS conversation_goal_sources (
  work_id VARCHAR PRIMARY KEY,
  source_json VARCHAR NOT NULL CHECK(json_valid(source_json))
);

CREATE TABLE IF NOT EXISTS work_teams (
  work_id VARCHAR PRIMARY KEY,
  user_id VARCHAR NOT NULL,
  operation_id VARCHAR NOT NULL,
  request_hash VARCHAR NOT NULL,
  plan_json VARCHAR NOT NULL,
  intent_revision BIGINT NOT NULL,
  input_snapshot_id VARCHAR NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(user_id,operation_id)
);

CREATE TABLE IF NOT EXISTS work_team_ownership (
  work_id VARCHAR PRIMARY KEY,
  team_id VARCHAR NOT NULL,
  team_name VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS work_team_record_visibility (
  work_id VARCHAR PRIMARY KEY,
  removed_at BIGINT,
  removal_requested_at BIGINT
);

CREATE TABLE IF NOT EXISTS work_team_executions (
  work_id VARCHAR NOT NULL,
  ordinal BIGINT NOT NULL,
  bot_id VARCHAR NOT NULL,
  task_id VARCHAR NOT NULL UNIQUE,
  role VARCHAR NOT NULL,
  responsibility VARCHAR NOT NULL,
  scopes_json VARCHAR NOT NULL,
  input_json VARCHAR,
  error VARCHAR,
  cancelled BIGINT NOT NULL DEFAULT 0,
  reported BIGINT NOT NULL DEFAULT 0,
  reported_binding_id VARCHAR,
  original_input_json VARCHAR,
  PRIMARY KEY(work_id,ordinal)
);

CREATE TABLE IF NOT EXISTS work_team_workspaces (
  work_id VARCHAR PRIMARY KEY,
  canonical_path VARCHAR NOT NULL,
  entity VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS work_team_execution_history (
  task_id VARCHAR PRIMARY KEY,
  work_id VARCHAR NOT NULL,
  input_json VARCHAR,
  execution_json VARCHAR NOT NULL,
  archived_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_team_templates (
  template_id VARCHAR PRIMARY KEY,
  user_id VARCHAR NOT NULL,
  operation_id VARCHAR NOT NULL,
  request_hash VARCHAR NOT NULL,
  name VARCHAR NOT NULL,
  plan_json VARCHAR NOT NULL,
  created_at BIGINT NOT NULL,
  deleted_at BIGINT,
  UNIQUE(user_id,operation_id)
);

CREATE TABLE IF NOT EXISTS work_team_recovery_attempts (
  recovery_id VARCHAR PRIMARY KEY,
  work_id VARCHAR NOT NULL,
  task_id VARCHAR NOT NULL,
  bot_id VARCHAR NOT NULL,
  role VARCHAR NOT NULL,
  intent_revision BIGINT NOT NULL,
  input_snapshot_id VARCHAR NOT NULL,
  owner_epoch BIGINT NOT NULL,
  source_key VARCHAR NOT NULL,
  source_binding_id VARCHAR,
  generation BIGINT NOT NULL,
  operation_id VARCHAR NOT NULL UNIQUE,
  state VARCHAR NOT NULL CHECK (state IN ('pending','claimed','dispatched','completed','stopped')),
  failure_class VARCHAR NOT NULL,
  failure_message VARCHAR NOT NULL,
  progress_hash VARCHAR,
  outcome VARCHAR,
  attempt_count BIGINT NOT NULL DEFAULT 0,
  binding_id VARCHAR,
  claimed_at BIGINT,
  dispatched_at BIGINT,
  settled_at BIGINT,
  created_at BIGINT NOT NULL,
  missing_json VARCHAR,
  UNIQUE(work_id,task_id,source_key),
  UNIQUE(work_id,task_id,generation)
);

CREATE TABLE IF NOT EXISTS work_team_watch_cycles (
  work_id VARCHAR NOT NULL,
  inbox_event_id VARCHAR PRIMARY KEY,
  sequence BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(work_id,sequence)
);

CREATE TABLE IF NOT EXISTS bot_identity_roles (
  user_id VARCHAR NOT NULL,
  role VARCHAR NOT NULL CHECK(role='primary'),
  bot_id VARCHAR NOT NULL UNIQUE,
  assigned_at BIGINT NOT NULL,
  PRIMARY KEY(user_id,role)
);

CREATE TABLE IF NOT EXISTS bot_collaborations (
  collaboration_id VARCHAR PRIMARY KEY,
  user_id VARCHAR NOT NULL,
  source_bot_id VARCHAR NOT NULL,
  source_conversation_id VARCHAR NOT NULL,
  target_bot_id VARCHAR NOT NULL,
  initiation_key VARCHAR NOT NULL UNIQUE,
  initiation_hash VARCHAR NOT NULL,
  value_json VARCHAR NOT NULL CHECK(json_valid(value_json)),
  work_id VARCHAR UNIQUE,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  status VARCHAR NOT NULL,
  times_json VARCHAR NOT NULL CHECK(json_valid(times_json)),
  next_ordinal BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bot_collaboration_requests (
  collaboration_id VARCHAR NOT NULL,
  conversation_id VARCHAR NOT NULL,
  request_id VARCHAR NOT NULL,
  user_message_id VARCHAR NOT NULL,
  assistant_message_id VARCHAR NOT NULL,
  PRIMARY KEY(collaboration_id,request_id)
);

CREATE TABLE IF NOT EXISTS bot_collaboration_messages (
  message_id VARCHAR PRIMARY KEY,
  collaboration_id VARCHAR NOT NULL,
  operation_key VARCHAR NOT NULL,
  ordinal BIGINT NOT NULL,
  payload_hash VARCHAR NOT NULL,
  value_json VARCHAR NOT NULL CHECK(json_valid(value_json)),
  UNIQUE(collaboration_id,operation_key),
  UNIQUE(collaboration_id,ordinal)
);

CREATE TABLE IF NOT EXISTS bot_collaboration_events (
  event_id VARCHAR PRIMARY KEY,
  collaboration_id VARCHAR NOT NULL,
  operation_key VARCHAR NOT NULL,
  ordinal BIGINT NOT NULL,
  payload_hash VARCHAR NOT NULL,
  value_json VARCHAR NOT NULL CHECK(json_valid(value_json)),
  UNIQUE(collaboration_id,operation_key),
  UNIQUE(collaboration_id,ordinal)
);

CREATE TABLE IF NOT EXISTS bot_collaboration_previews (
  collaboration_id VARCHAR NOT NULL,
  exchange_id VARCHAR NOT NULL,
  value_json VARCHAR NOT NULL CHECK(json_valid(value_json)),
  PRIMARY KEY(collaboration_id,exchange_id)
);

CREATE TABLE IF NOT EXISTS bot_collaboration_message_order (
  sequence BIGINT PRIMARY KEY,
  message_id VARCHAR NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS bot_foreground_metrics(
  message_id VARCHAR PRIMARY KEY,
  value_json VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_foreground_usage(
  message_id VARCHAR NOT NULL,
  generation_id BIGINT NOT NULL,
  value_json VARCHAR NOT NULL,
  PRIMARY KEY(message_id,generation_id)
);

CREATE TABLE IF NOT EXISTS bot_peer_calls (
  call_id VARCHAR PRIMARY KEY,
  parent_message_id VARCHAR NOT NULL,
  value_json VARCHAR NOT NULL CHECK(json_valid(value_json))
);

CREATE TABLE IF NOT EXISTS bot_peer_inputs (
  user_message_id VARCHAR PRIMARY KEY,
  assistant_message_id VARCHAR NOT NULL UNIQUE,
  origin_json VARCHAR NOT NULL CHECK(json_valid(origin_json))
);

CREATE TABLE IF NOT EXISTS bot_peer_deliveries (
  operation_id VARCHAR PRIMARY KEY,
  user_id VARCHAR NOT NULL,
  origin_json VARCHAR NOT NULL CHECK(json_valid(origin_json)),
  text VARCHAR NOT NULL,
  target_bot_id VARCHAR NOT NULL,
  conversation_id VARCHAR,
  request_id VARCHAR NOT NULL UNIQUE,
  accepted_message_id VARCHAR,
  cancelled_at BIGINT,
  error VARCHAR,
  journal_message_id VARCHAR,
  observed_status VARCHAR,
  returned_at BIGINT
);

CREATE TABLE IF NOT EXISTS bot_message_segments (
  message_id VARCHAR PRIMARY KEY,
  segments_json VARCHAR NOT NULL CHECK(json_valid(segments_json))
);

CREATE TABLE IF NOT EXISTS bot_message_tools (
  message_id VARCHAR PRIMARY KEY,
  task_id VARCHAR NOT NULL,
  tools_json VARCHAR NOT NULL CHECK(json_valid(tools_json))
);

CREATE TABLE IF NOT EXISTS bot_clarification_answers (
  question_message_id VARCHAR NOT NULL,
  goal_id VARCHAR NOT NULL,
  answer_message_id VARCHAR NOT NULL,
  PRIMARY KEY(question_message_id,goal_id)
);

CREATE TABLE IF NOT EXISTS bot_message_execution_settings (
  message_id VARCHAR PRIMARY KEY,
  bot_id VARCHAR NOT NULL,
  settings_json VARCHAR NOT NULL,
  profile_json VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_execution_settings (
  bot_id VARCHAR PRIMARY KEY,
  revision BIGINT NOT NULL,
  settings_json VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_work_settings (
  work_id VARCHAR PRIMARY KEY,
  settings_json VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_workspace_navigation_spaces (
  space_id VARCHAR PRIMARY KEY,
  auto_name VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_goal_continuations (
  work_id VARCHAR PRIMARY KEY,
  task_id VARCHAR NOT NULL,
  intent_revision BIGINT NOT NULL,
  attempts BIGINT NOT NULL DEFAULT 0,
  attempt_serial BIGINT NOT NULL DEFAULT 0,
  tokens_used BIGINT NOT NULL DEFAULT 0,
  tokens_budget BIGINT,
  time_used_seconds BIGINT NOT NULL DEFAULT 0,
  usage_cursor BIGINT NOT NULL DEFAULT 0,
  progress_fingerprint VARCHAR,
  progress_stalls BIGINT NOT NULL DEFAULT 0,
  run_cursor BIGINT NOT NULL DEFAULT 0,
  last_token_at BIGINT,
  last_continuation_at BIGINT,
  state VARCHAR NOT NULL DEFAULT 'idle'
      CHECK (state IN ('idle','igniting','deferred','exhausted')),
  defer_reason VARCHAR
      CHECK (defer_reason IS NULL OR defer_reason IN
        ('user_interrupt','turn_aborted','run_failed','restart','no_progress','manual_stop','attempts','budget')),
  deferred_at BIGINT,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_goal_usage_events (
  event_key VARCHAR PRIMARY KEY,
  task_id VARCHAR NOT NULL,
  tokens BIGINT NOT NULL,
  recorded_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_goal_last_check (
  work_id VARCHAR PRIMARY KEY,
  task_id VARCHAR NOT NULL,
  intent_revision BIGINT NOT NULL,
  trigger VARCHAR NOT NULL CHECK(trigger IN ('settled','resumed','continued')),
  reason VARCHAR NOT NULL,
  "at" BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_goal_last_wake (
  work_id VARCHAR PRIMARY KEY,
  task_id VARCHAR NOT NULL,
  intent_revision BIGINT NOT NULL,
  trigger VARCHAR NOT NULL CHECK(trigger IN ('settled','resumed','continued')),
  "at" BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_gap_coverages (
  fact_id VARCHAR NOT NULL,
  work_id VARCHAR NOT NULL,
  operation_id VARCHAR NOT NULL,
  receipt_json VARCHAR NOT NULL CHECK(json_valid(receipt_json)),
  created_at BIGINT NOT NULL,
  PRIMARY KEY(fact_id,operation_id)
);

CREATE TABLE IF NOT EXISTS work_record_archive (
  work_id VARCHAR PRIMARY KEY,
  archived_at BIGINT NOT NULL,
  deleted_at BIGINT
);

CREATE TABLE IF NOT EXISTS work_source_associations (
  user_id VARCHAR NOT NULL,
  source_key VARCHAR NOT NULL,
  source_version VARCHAR NOT NULL,
  work_id VARCHAR NOT NULL,
  previous_work_id VARCHAR,
  source_revision BIGINT,
  observed_at BIGINT NOT NULL,
  PRIMARY KEY(user_id,source_key,source_version)
);

CREATE TABLE IF NOT EXISTS work_automatic_completion (
  binding_id VARCHAR PRIMARY KEY,
  work_id VARCHAR NOT NULL,
  consumed_at BIGINT,
  recovered BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS work_automatic_completion_deliveries (
  binding_id VARCHAR PRIMARY KEY,
  summary VARCHAR NOT NULL,
  outcome VARCHAR NOT NULL DEFAULT 'completed',
  goal_reviewed BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS work_completion_review_evidence (
  binding_id VARCHAR PRIMARY KEY,
  fingerprint VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS work_automatic_recovery (
  source_binding_id VARCHAR PRIMARY KEY,
  plan_id VARCHAR NOT NULL,
  fingerprint VARCHAR NOT NULL,
  mode VARCHAR NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_terminal_evidence_reads (
  binding_id VARCHAR PRIMARY KEY,
  version BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_continuation_progress (
  binding_id VARCHAR PRIMARY KEY,
  work_id VARCHAR NOT NULL,
  intent_revision BIGINT NOT NULL,
  input_snapshot_id VARCHAR NOT NULL,
  fingerprint VARCHAR NOT NULL,
  recorded_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_board_days(
  id VARCHAR NOT NULL,
  kind VARCHAR NOT NULL,
  day VARCHAR NOT NULL,
  "at" BIGINT NOT NULL,
  detail VARCHAR NOT NULL DEFAULT '',
  PRIMARY KEY(id,kind,day)
);

CREATE TABLE IF NOT EXISTS task_board_plans(
  id VARCHAR PRIMARY KEY,
  day VARCHAR,
  later_until BIGINT,
  deferred_at BIGINT
);

CREATE TABLE IF NOT EXISTS dots_delegations(
  seq BIGINT PRIMARY KEY,
  operation_id VARCHAR NOT NULL UNIQUE,
  task_id VARCHAR NOT NULL,
  source_message_id VARCHAR NOT NULL,
  title VARCHAR NOT NULL,
  status VARCHAR NOT NULL DEFAULT 'pending',
  text VARCHAR NOT NULL DEFAULT '',
  files VARCHAR NOT NULL DEFAULT '[]',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  supersedes BIGINT NOT NULL DEFAULT 0,
  interaction_id VARCHAR,
  request_json VARCHAR,
  space_id VARCHAR,
  space_path VARCHAR,
  cwd VARCHAR,
  goal_id VARCHAR
);

CREATE TABLE IF NOT EXISTS dots_tool_observations(
  operation_id VARCHAR PRIMARY KEY,
  "at" BIGINT NOT NULL,
  tool VARCHAR NOT NULL,
  phase VARCHAR NOT NULL,
  next_at BIGINT,
  last_report_at BIGINT
);

CREATE TABLE IF NOT EXISTS dots_verified_progress(
  operation_id VARCHAR NOT NULL,
  identity VARCHAR NOT NULL,
  "at" BIGINT NOT NULL,
  PRIMARY KEY(operation_id,identity)
);

CREATE TABLE IF NOT EXISTS dots_tool_observation_receipts(
  operation_id VARCHAR NOT NULL,
  conversation VARCHAR NOT NULL,
  tool_task BIGINT NOT NULL,
  phase VARCHAR NOT NULL,
  PRIMARY KEY(operation_id,conversation,tool_task,phase)
);

CREATE TABLE IF NOT EXISTS dots_control_receipts(
  operation_id VARCHAR PRIMARY KEY,
  target_task_id VARCHAR NOT NULL,
  outcome VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS dots_target_controls(
  task_id VARCHAR PRIMARY KEY,
  state VARCHAR NOT NULL,
  operation_id VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS dots_dependency_waits(
  operation_id VARCHAR PRIMARY KEY,
  prerequisite_id VARCHAR NOT NULL,
  title VARCHAR NOT NULL,
  deadline_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS dots_verified_commits(
  operation_id VARCHAR PRIMARY KEY,
  sha VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS dots_reply_origins(
  source VARCHAR PRIMARY KEY,
  conversation BIGINT NOT NULL,
  entry BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS dots_followup_plans(
  operation_id VARCHAR PRIMARY KEY,
  plan VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS dots_followup_requests(
  operation_id VARCHAR PRIMARY KEY,
  request VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS dots_reply_events(
  event_key VARCHAR PRIMARY KEY,
  operation_id VARCHAR NOT NULL,
  task_id VARCHAR NOT NULL,
  status VARCHAR NOT NULL,
  interaction_id VARCHAR,
  snapshot VARCHAR NOT NULL,
  reply VARCHAR,
  settled BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS dots_deferred_requirements (
  id VARCHAR PRIMARY KEY,
  conversationId BIGINT NOT NULL,
  taskId VARCHAR NOT NULL,
  prerequisiteId VARCHAR NOT NULL,
  text VARCHAR NOT NULL,
  operationId VARCHAR,
  applied BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS dots_control_batches(
  id VARCHAR PRIMARY KEY,
  selection VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS dots_proactive_pauses(
  scope VARCHAR PRIMARY KEY,
  timer_ids VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS dots_continuation_targets(
  source VARCHAR NOT NULL,
  task_id VARCHAR NOT NULL,
  prior_operation_id VARCHAR,
  assignment_quote VARCHAR,
  PRIMARY KEY(source,task_id)
);

CREATE TABLE IF NOT EXISTS dots_file_watches(
  id VARCHAR PRIMARY KEY,
  task_id VARCHAR NOT NULL,
  space_id VARCHAR NOT NULL,
  root VARCHAR NOT NULL,
  file VARCHAR NOT NULL,
  instruction VARCHAR NOT NULL,
  source VARCHAR NOT NULL,
  baseline VARCHAR NOT NULL,
  input_version VARCHAR NOT NULL,
  state VARCHAR NOT NULL,
  note VARCHAR NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS dots_file_watch_notices(
  watch_id VARCHAR NOT NULL,
  revision VARCHAR NOT NULL,
  PRIMARY KEY(watch_id,revision)
);

CREATE TABLE IF NOT EXISTS dots_report_text (
  delivery_key VARCHAR PRIMARY KEY,
  operation_id VARCHAR NOT NULL,
  text VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS dots_proactive_delivery (
  delivery_key VARCHAR PRIMARY KEY,
  source VARCHAR NOT NULL,
  text VARCHAR NOT NULL,
  queued_at BIGINT NOT NULL,
  message_id VARCHAR,
  workspace VARCHAR,
  archived_at BIGINT,
  archive_retry_at BIGINT
);

CREATE TABLE IF NOT EXISTS bot_gateway_continuations(
  delivery_id VARCHAR PRIMARY KEY,
  operation_id VARCHAR NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS gateway_memory_isolation (
  singleton BIGINT PRIMARY KEY CHECK(singleton=1),
  installed_at BIGINT NOT NULL
);
INSERT INTO gateway_memory_isolation VALUES (1, epoch_ms(now())) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS gateway_dots_bindings (
  id VARCHAR PRIMARY KEY,
  channel_id VARCHAR NOT NULL,
  connection_key VARCHAR NOT NULL,
  sender_id VARCHAR NOT NULL,
  active BIGINT NOT NULL,
  bound_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS gateway_dots_admissions (
  channel_id VARCHAR NOT NULL,
  connection_key VARCHAR NOT NULL,
  chat_id VARCHAR NOT NULL,
  message_id VARCHAR NOT NULL,
  binding_id VARCHAR,
  PRIMARY KEY(channel_id, connection_key, chat_id, message_id)
);

CREATE TABLE IF NOT EXISTS gateway_dots_tasks (
  task_id VARCHAR PRIMARY KEY,
  binding_id VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS work_closure_review_corrections (
  binding_id VARCHAR PRIMARY KEY,
  action VARCHAR NOT NULL,
  detail_json VARCHAR NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_report_contexts (
  binding_id VARCHAR PRIMARY KEY,
  context_json VARCHAR NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS durable_bot_bindings (
  task_id VARCHAR PRIMARY KEY,
  backend VARCHAR NOT NULL CHECK(backend = 'pi-durable'),
  directory VARCHAR NOT NULL UNIQUE,
  cwd VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS durable_bot_memory_projection (
  task_id VARCHAR PRIMARY KEY,
  entry_id BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS durable_bot_workspace_moves (
  task_id VARCHAR PRIMARY KEY,
  from_cwd VARCHAR NOT NULL,
  to_cwd VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS durable_bot_message_workspaces (
  task_id VARCHAR NOT NULL,
  message_id VARCHAR NOT NULL,
  cwd VARCHAR NOT NULL,
  PRIMARY KEY(task_id, message_id)
);

CREATE TABLE IF NOT EXISTS runtime_diagnostic_writers (
  writer_id VARCHAR PRIMARY KEY,
  sequence BIGINT NOT NULL
);


-- Canonical domain indexes (209)

CREATE INDEX IF NOT EXISTS idx_cron_runs_job_order ON cron_runs(job_id, started_at, id);
CREATE INDEX IF NOT EXISTS idx_cron_runs_order ON cron_runs(started_at, id);
CREATE INDEX IF NOT EXISTS idx_gateway_messages_chat
        ON gateway_messages(channel_id, chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_project_posts_project
        ON project_posts(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_project_todos_project
        ON project_todos(project_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_task_runtime_snapshots_task
        ON task_runtime_context_snapshots(task_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_name
        ON projects(name);
CREATE INDEX IF NOT EXISTS idx_project_resources_project
        ON project_resources(project_id, sort_order, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_runtime_snapshots_execution
        ON task_runtime_context_snapshots(execution_id);
CREATE INDEX IF NOT EXISTS idx_runtime_snapshots_instructions_hash
        ON task_runtime_context_snapshots(instructions_hash);
CREATE INDEX IF NOT EXISTS idx_runtime_snapshots_capabilities_hash
        ON task_runtime_context_snapshots(capabilities_hash);
CREATE INDEX IF NOT EXISTS idx_runtime_snapshots_inline_payloads
        ON task_runtime_context_snapshots(id);
CREATE INDEX IF NOT EXISTS uq_spaces_root_name ON spaces(name);
CREATE INDEX IF NOT EXISTS uq_spaces_child_name ON spaces(parent_id, name);
CREATE INDEX IF NOT EXISTS idx_spaces_parent ON spaces(parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_task_execution_workspace_state_state
        ON task_execution_workspace_state(state);
CREATE INDEX IF NOT EXISTS idx_cad_models_task ON cad_models(task_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_cad_models_graph ON cad_models(graph_id);
CREATE INDEX IF NOT EXISTS idx_task_code_review_status ON task_code_review(task_id, status);
CREATE INDEX IF NOT EXISTS idx_project_events_project
        ON project_events(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_project_events_ref
        ON project_events(project_id, source, ref);
CREATE INDEX IF NOT EXISTS idx_pep_event
        ON project_event_promotions(project_id, event_id);
CREATE INDEX IF NOT EXISTS idx_pep_target
        ON project_event_promotions(project_id, target_kind, target_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pep_event_kind
        ON project_event_promotions(project_id, event_id, target_kind);
CREATE INDEX IF NOT EXISTS uq_library_spaces_workspace
      ON library_spaces(workspace_id);
CREATE INDEX IF NOT EXISTS idx_library_collections_space
        ON library_collections(space_id, parent_id, name);
CREATE INDEX IF NOT EXISTS idx_library_items_space
        ON library_items(space_id, collection_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_library_items_visited
        ON library_items(last_visited_at);
CREATE INDEX IF NOT EXISTS idx_library_versions_item
        ON library_versions(item_id, version);
CREATE INDEX IF NOT EXISTS idx_library_text_saves_pending
        ON library_text_saves(root);
CREATE INDEX IF NOT EXISTS idx_task_library_refs_task
        ON task_library_references(task_id, added_at);
CREATE INDEX IF NOT EXISTS idx_task_library_refs_item
        ON task_library_references(item_id);
CREATE INDEX IF NOT EXISTS idx_project_context_pins_project
        ON project_context_pins(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_project_context_pins_item
        ON project_context_pins(item_id);
CREATE INDEX IF NOT EXISTS idx_project_reviews_project
        ON project_reviews(project_id, reviewed_at);
CREATE INDEX IF NOT EXISTS idx_project_actions_project
        ON project_action_proposals(project_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_ts ON usage_events(ts);
CREATE INDEX IF NOT EXISTS idx_usage_events_session ON usage_events(session_file, ts);
CREATE INDEX IF NOT EXISTS idx_usage_events_provider ON usage_events(provider);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(read_at, dismissed_at, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_source ON notifications(source_type, source_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe ON notifications(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_workspace_library_links_workspace
        ON workspace_library_links(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_library_links_library
        ON workspace_library_links(library_space_id);
CREATE INDEX IF NOT EXISTS idx_workspace_library_collection_links_workspace
        ON workspace_library_collection_links(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_library_collection_links_library
        ON workspace_library_collection_links(library_space_id);
CREATE INDEX IF NOT EXISTS idx_workspace_library_collection_links_collection
        ON workspace_library_collection_links(collection_id);
CREATE INDEX IF NOT EXISTS idx_python_project_bindings_bound_at
        ON python_project_bindings(bound_at);
CREATE INDEX IF NOT EXISTS idx_library_chunks_item
        ON library_chunks(item_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_library_chunks_hash
        ON library_chunks(hash);
CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_hash
        ON library_chunk_embeddings(chunk_hash);
CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_model
        ON library_chunk_embeddings(model_id, model_version);
CREATE INDEX IF NOT EXISTS idx_wge_from ON work_graph_edges(from_type, from_id);
CREATE INDEX IF NOT EXISTS idx_wge_to   ON work_graph_edges(to_type, to_id);
CREATE INDEX IF NOT EXISTS idx_wge_rel  ON work_graph_edges(relation);
CREATE INDEX IF NOT EXISTS idx_gadgets_scope ON gadgets(scope_type, scope_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_gadgets_created_by_task ON gadgets(created_by_task_id);
CREATE INDEX IF NOT EXISTS idx_gadgets_blueprint ON gadgets(blueprint_id);
CREATE INDEX IF NOT EXISTS idx_blueprints_kind_updated ON blueprints(kind, updated_at);
CREATE INDEX IF NOT EXISTS idx_memory_records_status_updated ON memory_records(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_memory_records_kind_updated ON memory_records(kind, updated_at);
CREATE INDEX IF NOT EXISTS idx_memory_records_hash ON memory_records(content_hash);
CREATE INDEX IF NOT EXISTS idx_memory_records_source_task ON memory_records(source_task_id);
CREATE INDEX IF NOT EXISTS idx_memory_records_dots_projection
        ON memory_records(kind, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_memory_records_dots_projection_due
        ON memory_records(valid_from);
CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_scope_binding ON memory_scopes(memory_id, scope_type, binding);
CREATE INDEX IF NOT EXISTS idx_memory_scopes_lookup ON memory_scopes(scope_type, scope_id, memory_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_evidence_ref ON memory_evidence(memory_id, evidence_kind, ref_id);
CREATE INDEX IF NOT EXISTS idx_memory_evidence_ref ON memory_evidence(evidence_kind, ref_id);
CREATE INDEX IF NOT EXISTS idx_memory_revisions_memory ON memory_revisions(memory_id, revision);
CREATE INDEX IF NOT EXISTS idx_memory_relations_from ON memory_relations(from_memory_id, relation);
CREATE INDEX IF NOT EXISTS idx_memory_relations_to ON memory_relations(to_memory_id, relation);
CREATE INDEX IF NOT EXISTS idx_memory_embeddings_hash ON memory_embeddings(content_hash);
CREATE INDEX IF NOT EXISTS idx_memory_candidates_status ON memory_candidates(status, created_at);
CREATE INDEX IF NOT EXISTS idx_memory_candidates_task ON memory_candidates(task_id, created_at);
CREATE INDEX IF NOT EXISTS uq_memory_turn_assistant_message ON memory_turns(assistant_message_id);
CREATE INDEX IF NOT EXISTS idx_memory_turns_task_time ON memory_turns(task_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_memory_turns_state ON memory_turns(extraction_state, captured_at);
CREATE INDEX IF NOT EXISTS idx_memory_turns_task_hash ON memory_turns(task_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_memory_projection_proposals_status ON memory_projection_proposals(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_memory_skill_effectiveness_skill ON memory_skill_effectiveness(skill_id, invoked_at, exposed_at);
CREATE INDEX IF NOT EXISTS idx_memory_skill_effectiveness_task ON memory_skill_effectiveness(task_id, exposed_at);
CREATE INDEX IF NOT EXISTS idx_memory_skill_effectiveness_feedback ON memory_skill_effectiveness(feedback_kind, feedback_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_skill_revision_identity ON memory_skill_revision_candidates(skill_id, base_content_hash, feedback_signature);
CREATE INDEX IF NOT EXISTS idx_memory_skill_revision_status ON memory_skill_revision_candidates(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_memory_skill_revision_skill ON memory_skill_revision_candidates(skill_id, base_candidate_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_memory_skill_candidates_status ON memory_skill_candidates(status, score, updated_at);
CREATE INDEX IF NOT EXISTS idx_memory_skill_candidates_scope ON memory_skill_candidates(scope_type, scope_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_memory_scenarios_scope ON memory_scenarios(scope_type, scope_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_memory_core_profiles_scope ON memory_core_profiles(scope_type, scope_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_agent_loadout_task_created
        ON agent_loadout_observations(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conversation_branches_parent
        ON conversation_branches(parent_task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conversation_branches_root
        ON conversation_branches(root_task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_execution_attempt_scope
    ON execution_attempts(task_id, execution_id, assistant_message_id, target);
CREATE INDEX IF NOT EXISTS idx_conversation_interactions_task_message
        ON conversation_interactions(task_id, assistant_message_id, created_at);
CREATE INDEX IF NOT EXISTS uq_conversation_interactions_pending_execution
        ON conversation_interactions(execution_id);
CREATE INDEX IF NOT EXISTS idx_bots_user_status ON bots(user_id, status);
CREATE INDEX IF NOT EXISTS uq_bot_expert_pending
      ON bot_expert_versions(bot_id);
CREATE INDEX IF NOT EXISTS idx_works_owner_lifecycle ON works(owner_bot_id, lifecycle);
CREATE INDEX IF NOT EXISTS idx_works_user_lifecycle ON works(user_id, lifecycle, updated_at);
CREATE INDEX IF NOT EXISTS idx_works_legacy_task ON works(legacy_task_id, lifecycle);
CREATE INDEX IF NOT EXISTS idx_works_user_summary_page ON works(user_id, updated_at, work_id);
CREATE INDEX IF NOT EXISTS idx_work_summary_subitems ON work_subitem_results(work_id, binding_id);
CREATE INDEX IF NOT EXISTS idx_work_summary_continuations ON work_continuation_plans(work_id, source_binding_id);
CREATE INDEX IF NOT EXISTS idx_work_conversations_conv
      ON work_conversations(conversation_id, last_referenced_at);
CREATE INDEX IF NOT EXISTS idx_work_bindings_work
      ON work_execution_bindings(work_id, status, admitted_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_work_binding_namespace
      ON work_execution_bindings(task_id, durable_store_key, conversation_id, operation_id);
CREATE INDEX IF NOT EXISTS idx_work_admissions_open
      ON work_action_admissions(work_id, state);
CREATE INDEX IF NOT EXISTS idx_work_deliverables_work
      ON work_deliverables(work_id, status, intent_revision);
CREATE INDEX IF NOT EXISTS idx_work_evidence_work ON work_evidence(work_id, criterion_ids_json);
CREATE INDEX IF NOT EXISTS idx_work_evidence_snapshot ON work_evidence(work_id, input_snapshot_id);
CREATE INDEX IF NOT EXISTS idx_work_blockers_work_status ON work_blockers(work_id, status);
CREATE INDEX IF NOT EXISTS idx_work_receipts_work ON work_operation_receipts(work_id, created_at);
CREATE INDEX IF NOT EXISTS idx_work_inbox_pending
      ON work_events_inbox(work_id, status, received_at);
CREATE INDEX IF NOT EXISTS idx_work_inbox_subscription
      ON work_events_inbox(subscription_id, status, received_at);
CREATE INDEX IF NOT EXISTS idx_work_outbox_pending ON work_events_outbox(delivery_status, created_at);
CREATE INDEX IF NOT EXISTS idx_work_outbox_created ON work_events_outbox(work_id);
CREATE INDEX IF NOT EXISTS idx_work_subscriptions_work ON work_subscriptions(work_id, stopped_at);
CREATE INDEX IF NOT EXISTS idx_work_subscriptions_source_active ON work_subscriptions(source, stopped_at, created_at);
CREATE INDEX IF NOT EXISTS idx_work_subscriptions_wake ON work_subscriptions(next_wake_at);
CREATE INDEX IF NOT EXISTS idx_work_notifications_work ON work_notifications(work_id, created_at);
CREATE INDEX IF NOT EXISTS uq_work_pending_dispatch ON work_dispatch_requests(work_id, intent_revision, input_snapshot_id);
CREATE INDEX IF NOT EXISTS uq_bot_personal_live ON bot_conversations(user_id, bot_id);
CREATE INDEX IF NOT EXISTS uq_bot_team_live ON bot_conversations(user_id, team_id);
CREATE INDEX IF NOT EXISTS idx_work_collaboration_order ON work_collaboration_messages(work_id, created_at, message_id);
CREATE INDEX IF NOT EXISTS idx_work_ingress_routes_subscription
      ON work_ingress_routes(subscription_id, state, accepted_at);
CREATE INDEX IF NOT EXISTS idx_work_ingress_routes_inbox
      ON work_ingress_routes(inbox_event_id);
CREATE INDEX IF NOT EXISTS idx_work_schedule_ticks_work
      ON work_schedule_ticks(work_id, status, effective_at);
CREATE INDEX IF NOT EXISTS idx_work_offline_gaps_work
      ON work_offline_gaps(work_id, state, offline_gap_from);
CREATE INDEX IF NOT EXISTS idx_work_causal_chains_state
      ON work_causal_chains(target_work_id, target_state_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_work_causal_chains_root
      ON work_causal_chains(root_event_id);
CREATE INDEX IF NOT EXISTS idx_work_deadline_instances_pending
      ON work_deadline_instances(state, deadline_at);
CREATE INDEX IF NOT EXISTS uq_work_blocker_reason
      ON work_blockers(work_id, reason_code);
CREATE INDEX IF NOT EXISTS idx_work_inbox_batch
      ON work_events_inbox(batch_id, status, merge_deadline_at);
CREATE INDEX IF NOT EXISTS idx_work_inbox_target
      ON work_events_inbox(subscription_id, target_key, status, received_at);
CREATE INDEX IF NOT EXISTS idx_work_result_cards_work
      ON work_result_cards(work_id, created_at);
CREATE INDEX IF NOT EXISTS idx_work_result_cards_outcome
      ON work_result_cards(work_id, intent_revision, input_snapshot_id, canonical_outcome_hash);
CREATE INDEX IF NOT EXISTS idx_work_result_cards_unread
      ON work_result_cards(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_work_notification_effects_notification
      ON work_notification_effects(notification_id, created_at);
CREATE INDEX IF NOT EXISTS uq_work_notification_effect_initial
      ON work_notification_effects(notification_id);
CREATE INDEX IF NOT EXISTS idx_gateway_work_targets_conversation
      ON gateway_work_targets(user_id, conversation_id, source_message_id);
CREATE INDEX IF NOT EXISTS gateway_inbox_resume ON gateway_inbox(channel_id, account_key, status, created_at, delivery_id);
CREATE INDEX IF NOT EXISTS gateway_inbox_retention ON gateway_inbox(status, updated_at, delivery_id);
CREATE INDEX IF NOT EXISTS gateway_outbox_retry ON gateway_outbox(status, next_attempt_at, delivery_id);
CREATE INDEX IF NOT EXISTS idx_gateway_conversation_current ON gateway_conversation_routes(scope_id, kind, seq);
CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_space ON artifacts(space_id);
CREATE INDEX IF NOT EXISTS idx_artifact_message_refs_task
    ON artifact_message_refs(task_id, message_id);
CREATE INDEX IF NOT EXISTS idx_artifact_message_refs_artifact
    ON artifact_message_refs(task_id, artifact_id);
CREATE INDEX IF NOT EXISTS idx_artifact_file_deps_artifact
    ON artifact_file_dependencies(artifact_id);
CREATE INDEX IF NOT EXISTS answer_rules_scope ON answer_rules(enabled, project_id);
CREATE INDEX IF NOT EXISTS answer_rule_uses_recent ON answer_rule_uses("at");
CREATE INDEX IF NOT EXISTS answer_rule_turns_recent ON answer_rule_turns("at");
CREATE INDEX IF NOT EXISTS answer_rule_turns_source_history ON answer_rule_turns(task_id, rule_id, "at");
CREATE INDEX IF NOT EXISTS answer_rule_versions_recent ON answer_rule_versions(rule_id, revision);
CREATE INDEX IF NOT EXISTS idx_execution_failures_task ON execution_failures(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_goal_generations_work ON conversation_goal_generations(work_id);
CREATE INDEX IF NOT EXISTS idx_external_agent_runs_task_started
        ON external_agent_runs(task_id, started_at);
CREATE INDEX IF NOT EXISTS idx_task_request_diagnostics ON task_request_diagnostics(task_id, started_at);
CREATE INDEX IF NOT EXISTS idx_task_tool_diagnostics ON task_tool_diagnostics(task_id, started_at);
CREATE INDEX IF NOT EXISTS idx_scope_tool_diagnostics ON scope_tool_diagnostics(task_id, started_at);
CREATE INDEX IF NOT EXISTS idx_task_request_scope ON task_request_diagnostics(started_at);
CREATE INDEX IF NOT EXISTS idx_task_diagnostic_waits ON conversation_interactions(task_id, execution_id);
CREATE INDEX IF NOT EXISTS idx_bot_turn_origins_conversation ON bot_turn_origins(conversation_id);
CREATE INDEX IF NOT EXISTS idx_work_team_ownership_team ON work_team_ownership(team_id);
CREATE INDEX IF NOT EXISTS idx_work_team_template_name ON work_team_templates(user_id, name);
CREATE INDEX IF NOT EXISTS idx_work_team_recovery_state
      ON work_team_recovery_attempts(work_id, state, created_at);
CREATE INDEX IF NOT EXISTS idx_bot_collaboration_source
        ON bot_collaborations(user_id, source_bot_id, created_at, collaboration_id);
CREATE INDEX IF NOT EXISTS idx_bot_collaboration_target
        ON bot_collaborations(user_id, target_bot_id, created_at, collaboration_id);
CREATE INDEX IF NOT EXISTS idx_bot_collaboration_conversation
        ON bot_collaborations(user_id, source_conversation_id, created_at, collaboration_id);
CREATE INDEX IF NOT EXISTS idx_bot_collaboration_request_user_message ON bot_collaboration_requests(user_message_id);
CREATE INDEX IF NOT EXISTS idx_bot_collaboration_request_assistant ON bot_collaboration_requests(assistant_message_id);
CREATE INDEX IF NOT EXISTS idx_bot_collaboration_message_page ON bot_collaboration_messages(collaboration_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_bot_collaboration_event_page ON bot_collaboration_events(collaboration_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_bot_peer_calls_parent ON bot_peer_calls(parent_message_id);
CREATE INDEX IF NOT EXISTS idx_bot_peer_pending ON bot_peer_deliveries(user_id);
CREATE INDEX IF NOT EXISTS idx_bot_peer_journal ON bot_peer_deliveries(journal_message_id);
CREATE INDEX IF NOT EXISTS idx_bot_peer_collaboration ON bot_peer_deliveries(user_id);
CREATE INDEX IF NOT EXISTS idx_bot_peer_assistant ON bot_peer_deliveries(accepted_message_id);
CREATE INDEX IF NOT EXISTS idx_bot_messages_conversation_ordinal ON bot_messages(conversation_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_bot_messages_conversation_request ON bot_messages(conversation_id, request_id);
CREATE INDEX IF NOT EXISTS idx_bot_peer_inputs_assistant ON bot_peer_inputs(assistant_message_id);
CREATE INDEX IF NOT EXISTS idx_bot_collaboration_requests_assistant ON bot_collaboration_requests(assistant_message_id);
CREATE INDEX IF NOT EXISTS idx_goal_continuations_task
    ON conversation_goal_continuations(task_id, state);
CREATE INDEX IF NOT EXISTS idx_goal_usage_task ON conversation_goal_usage_events(task_id);
CREATE INDEX IF NOT EXISTS work_source_associations_latest ON work_source_associations(user_id, source_key, observed_at);
CREATE INDEX IF NOT EXISTS idx_board_days_time ON task_board_days(kind, "at", id);
CREATE INDEX IF NOT EXISTS idx_board_task_date ON tasks(due_at, id);
CREATE INDEX IF NOT EXISTS idx_board_task_update ON tasks(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_board_task_status ON tasks(status, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_board_task_pin ON tasks(is_favorited, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_board_receipt_assistant ON bot_send_receipts(assistant_message_id);
CREATE INDEX IF NOT EXISTS idx_board_pending_question ON conversation_interactions(status, task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_board_terminal_notice ON notifications(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_board_cron_task ON cron_runs(task_id, started_at);
CREATE INDEX IF NOT EXISTS idx_board_cron_job ON cron_runs(job_id, started_at, id);
CREATE INDEX IF NOT EXISTS idx_board_cron_started ON cron_runs(started_at, id);
CREATE INDEX IF NOT EXISTS dots_observation_due ON dots_tool_observations(next_at);
CREATE INDEX IF NOT EXISTS dots_verified_progress_latest ON dots_verified_progress(operation_id, "at");
CREATE INDEX IF NOT EXISTS dots_dependency_prerequisite ON dots_dependency_waits(prerequisite_id);
CREATE INDEX IF NOT EXISTS dots_delegations_task_sequence ON dots_delegations(task_id, seq);
CREATE INDEX IF NOT EXISTS dots_delegations_pending ON dots_delegations(task_id, seq);
CREATE INDEX IF NOT EXISTS dots_delegations_source ON dots_delegations(source_message_id);
CREATE INDEX IF NOT EXISTS dots_reply_pending ON dots_reply_events(task_id);
CREATE INDEX IF NOT EXISTS dots_reply_operation ON dots_reply_events(operation_id);
CREATE INDEX IF NOT EXISTS dots_report_operation ON dots_report_text(operation_id);
CREATE INDEX IF NOT EXISTS gateway_dots_active_binding ON gateway_dots_bindings(channel_id);


-- Runtime core tables (22)

CREATE TABLE IF NOT EXISTS core_command_receipts (
  command_id VARCHAR PRIMARY KEY,
  command_name VARCHAR NOT NULL,
  result_json VARCHAR NOT NULL,
  created_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS core_cron_occurrences (
  occurrence_key VARCHAR PRIMARY KEY,
  job_id VARCHAR NOT NULL,
  occurrence_at_ms BIGINT NOT NULL,
  run_id VARCHAR,
  status VARCHAR NOT NULL,
  recorded_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS core_cron_runtime_config (
  key VARCHAR PRIMARY KEY,
  value_json VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS core_cron_schedule_state (
  job_id VARCHAR PRIMARY KEY,
  next_due_at_ms BIGINT,
  occurrence_at_ms BIGINT,
  last_evaluated_at_ms BIGINT NOT NULL,
  schedule_sig VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS core_domain_events (
  seq BIGINT PRIMARY KEY,
  event_id VARCHAR UNIQUE NOT NULL,
  core_generation VARCHAR NOT NULL,
  owner_generation VARCHAR NOT NULL,
  domain VARCHAR NOT NULL,
  kind VARCHAR NOT NULL,
  entity_id VARCHAR NOT NULL,
  revision BIGINT NOT NULL,
  command_id VARCHAR,
  payload_json VARCHAR NOT NULL,
  created_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS core_domain_notes (
  entity_id VARCHAR PRIMARY KEY,
  owner_generation VARCHAR NOT NULL,
  revision BIGINT NOT NULL,
  title VARCHAR NOT NULL,
  body_json VARCHAR NOT NULL,
  deleted BIGINT NOT NULL DEFAULT 0,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS core_dots_causal_dedup (
  dedup_key VARCHAR PRIMARY KEY,
  kind VARCHAR NOT NULL,
  source_id VARCHAR NOT NULL,
  detail_json VARCHAR,
  recorded_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS core_dots_control_config (
  key VARCHAR PRIMARY KEY,
  value_json VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS core_dots_control_cycles (
  cycle_key VARCHAR PRIMARY KEY,
  kind VARCHAR NOT NULL,
  next_due_at_ms BIGINT,
  last_dispatched_at_ms BIGINT,
  last_completed_at_ms BIGINT,
  in_flight BIGINT NOT NULL DEFAULT 0,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS core_event_meta (
  id BIGINT PRIMARY KEY CHECK (id = 1),
  core_generation VARCHAR NOT NULL,
  min_available_seq BIGINT NOT NULL,
  retention_limit BIGINT NOT NULL DEFAULT 4096
);

CREATE TABLE IF NOT EXISTS core_execution_runs (
  execution_id VARCHAR PRIMARY KEY,
  idempotency_key VARCHAR UNIQUE NOT NULL,
  owner_generation VARCHAR NOT NULL,
  source_role VARCHAR NOT NULL,
  source_client_id VARCHAR NOT NULL,
  source_epoch BIGINT NOT NULL,
  task_id VARCHAR NOT NULL,
  kind VARCHAR NOT NULL,
  payload_json VARCHAR NOT NULL,
  status VARCHAR NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  executor_client_id VARCHAR,
  executor_epoch BIGINT,
  attempt BIGINT NOT NULL DEFAULT 0,
  result_json VARCHAR,
  error_message VARCHAR,
  wait_reason VARCHAR,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS core_gateway_channels (
  channel_id VARCHAR PRIMARY KEY,
  channel_type VARCHAR NOT NULL,
  account_key VARCHAR,
  enabled BIGINT NOT NULL DEFAULT 1,
  paused BIGINT NOT NULL DEFAULT 0,
  status VARCHAR NOT NULL,
  generation BIGINT NOT NULL DEFAULT 1,
  offline_attempts BIGINT NOT NULL DEFAULT 0,
  next_reconnect_at_ms BIGINT,
  next_recover_at_ms BIGINT,
  last_connected_at_ms BIGINT,
  error_message VARCHAR,
  in_flight BIGINT NOT NULL DEFAULT 0,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS core_gateway_config (
  key VARCHAR PRIMARY KEY,
  value_json VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS core_gateway_outbound_reconcile (
  delivery_id VARCHAR PRIMARY KEY,
  channel_id VARCHAR NOT NULL,
  channel_type VARCHAR NOT NULL,
  account_key VARCHAR,
  provider_message_id VARCHAR,
  queryable BIGINT NOT NULL DEFAULT 0,
  state VARCHAR NOT NULL,
  last_checked_at_ms BIGINT,
  check_attempts BIGINT NOT NULL DEFAULT 0,
  detail VARCHAR,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS core_maintenance_config (
  key VARCHAR PRIMARY KEY,
  value_json VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS core_maintenance_cycles (
  cycle_key VARCHAR PRIMARY KEY,
  next_due_at_ms BIGINT,
  last_dispatched_at_ms BIGINT,
  last_completed_at_ms BIGINT,
  in_flight BIGINT NOT NULL DEFAULT 0,
  last_error VARCHAR,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS core_pi_host_fences (
  host_generation VARCHAR PRIMARY KEY,
  reason VARCHAR,
  fenced_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS core_pi_host_launch_specs (
  storage_root VARCHAR PRIMARY KEY,
  executable VARCHAR NOT NULL,
  script_path VARCHAR NOT NULL,
  args_json VARCHAR NOT NULL,
  data_directory VARCHAR NOT NULL,
  db_path VARCHAR NOT NULL,
  pi_version VARCHAR NOT NULL,
  expected_pi_version VARCHAR NOT NULL,
  runtime_audit_executable VARCHAR,
  extra_env_json VARCHAR NOT NULL,
  auto_restart BIGINT NOT NULL DEFAULT 1,
  consecutive_failures BIGINT NOT NULL DEFAULT 0,
  next_restart_at_ms BIGINT NOT NULL DEFAULT 0,
  last_error VARCHAR,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS core_pi_hosts (
  host_id VARCHAR PRIMARY KEY,
  pid BIGINT NOT NULL,
  core_generation VARCHAR NOT NULL,
  host_generation VARCHAR NOT NULL,
  storage_root VARCHAR NOT NULL,
  db_path VARCHAR NOT NULL,
  pi_version VARCHAR NOT NULL,
  status VARCHAR NOT NULL,
  started_at_ms BIGINT NOT NULL,
  last_heartbeat_ms BIGINT NOT NULL,
  stopped_at_ms BIGINT,
  last_error VARCHAR
);

CREATE TABLE IF NOT EXISTS core_remote_commands (
  command_key VARCHAR PRIMARY KEY,
  operation_id VARCHAR NOT NULL,
  command_type VARCHAR NOT NULL,
  task_id VARCHAR,
  request_hash VARCHAR NOT NULL,
  status VARCHAR NOT NULL,
  response_json VARCHAR,
  error_message VARCHAR,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS core_remote_events (
  id BIGINT PRIMARY KEY,
  event_type VARCHAR NOT NULL,
  payload_json VARCHAR NOT NULL,
  created_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS core_remote_state (
  key VARCHAR PRIMARY KEY,
  value_json VARCHAR NOT NULL
);


-- Runtime explicit indexes (7)

CREATE INDEX IF NOT EXISTS idx_core_cron_occ_job
            ON core_cron_occurrences(job_id, occurrence_at_ms);
CREATE INDEX IF NOT EXISTS idx_core_domain_events_domain ON core_domain_events(domain, seq);
CREATE INDEX IF NOT EXISTS idx_core_dots_causal_time
            ON core_dots_causal_dedup(recorded_at_ms);
CREATE INDEX IF NOT EXISTS idx_core_execution_status ON core_execution_runs(status, created_at_ms);
CREATE INDEX IF NOT EXISTS idx_core_gw_reconcile_state
            ON core_gateway_outbound_reconcile(state, queryable, updated_at_ms);
CREATE INDEX IF NOT EXISTS idx_core_pi_hosts_status
            ON core_pi_hosts(status, storage_root, last_heartbeat_ms);
CREATE INDEX IF NOT EXISTS idx_core_remote_cmd_time
            ON core_remote_commands(created_at_ms);

-- ============================================================================
-- Native DuckDB Engine Metadata, Receipts, Outbox, Retention, Claims & Search
-- ============================================================================
CREATE TABLE IF NOT EXISTS database_meta (
  id BIGINT PRIMARY KEY,
  format VARCHAR NOT NULL,
  schema_version BIGINT NOT NULL,
  database_generation VARCHAR NOT NULL,
  initialized BOOLEAN NOT NULL,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS operation_receipts (
  caller_scope VARCHAR NOT NULL,
  operation_id VARCHAR NOT NULL,
  batch_index BIGINT NOT NULL,
  request_hash VARCHAR NOT NULL,
  status VARCHAR NOT NULL,
  result_json VARCHAR,
  result_ref VARCHAR,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (caller_scope, operation_id, batch_index)
);
CREATE INDEX IF NOT EXISTS idx_operation_receipts_op ON operation_receipts(operation_id);

CREATE TABLE IF NOT EXISTS domain_outbox_groups (
  group_id VARCHAR PRIMARY KEY,
  operation_id VARCHAR NOT NULL,
  batch_index BIGINT NOT NULL,
  entity_key VARCHAR NOT NULL,
  entity_revision BIGINT,
  previous_revision BIGINT,
  depends_on_group_id VARCHAR,
  work_projection_user_id VARCHAR,
  published BOOLEAN NOT NULL DEFAULT FALSE,
  published_seq_start BIGINT,
  published_seq_end BIGINT,
  created_at_ms BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_domain_outbox_pending ON domain_outbox_groups(published, created_at_ms);

CREATE TABLE IF NOT EXISTS domain_outbox_events (
  group_id VARCHAR NOT NULL,
  ordinal BIGINT NOT NULL,
  event_id VARCHAR NOT NULL UNIQUE,
  owner_generation VARCHAR NOT NULL,
  domain VARCHAR NOT NULL,
  kind VARCHAR NOT NULL,
  task_id VARCHAR,
  entity_id VARCHAR NOT NULL,
  revision BIGINT NOT NULL,
  command_id VARCHAR,
  payload_json VARCHAR NOT NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (group_id, ordinal)
);

CREATE TABLE IF NOT EXISTS core_event_publications (
  group_id VARCHAR PRIMARY KEY,
  core_generation VARCHAR NOT NULL,
  seq_start BIGINT NOT NULL,
  seq_end BIGINT NOT NULL,
  published_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS core_snapshot_retention_leases (
  lease_id VARCHAR PRIMARY KEY,
  core_generation VARCHAR NOT NULL,
  pinned_head_seq BIGINT NOT NULL,
  expires_at_ms BIGINT NOT NULL,
  created_at_ms BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshot_leases_exp ON core_snapshot_retention_leases(expires_at_ms);

CREATE TABLE IF NOT EXISTS unique_claims (
  claim_namespace VARCHAR NOT NULL,
  claim_key VARCHAR NOT NULL,
  owner_table VARCHAR NOT NULL,
  owner_id VARCHAR NOT NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (claim_namespace, claim_key)
);
CREATE INDEX IF NOT EXISTS idx_unique_claims_owner ON unique_claims(owner_table, owner_id);

-- ============================================================================
-- Memory Scope Versioning & Rust-Prepared Search Postings (IN-05, IN-06)
-- ============================================================================
CREATE TABLE IF NOT EXISTS memory_changes (
  change_id VARCHAR PRIMARY KEY,
  scope VARCHAR NOT NULL,
  domain VARCHAR NOT NULL,
  entity_id VARCHAR NOT NULL,
  operation_id VARCHAR NOT NULL,
  created_at_ms BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_changes_scope_domain ON memory_changes(scope, domain, created_at_ms);

CREATE TABLE IF NOT EXISTS memory_change_bases (
  scope VARCHAR NOT NULL,
  domain VARCHAR NOT NULL,
  epoch BIGINT NOT NULL,
  retired_count BIGINT NOT NULL DEFAULT 0,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (scope, domain)
);

CREATE TABLE IF NOT EXISTS search_documents (
  doc_key VARCHAR PRIMARY KEY,
  domain VARCHAR NOT NULL,
  scope VARCHAR NOT NULL,
  entity_id VARCHAR NOT NULL,
  title VARCHAR NOT NULL,
  body VARCHAR NOT NULL,
  content_revision BIGINT NOT NULL,
  content_hash VARCHAR NOT NULL,
  metadata_json VARCHAR,
  updated_at_ms BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_search_documents_scope ON search_documents(scope);
CREATE INDEX IF NOT EXISTS idx_search_documents_domain_entity ON search_documents(domain, entity_id);

CREATE TABLE IF NOT EXISTS search_postings (
  token_key VARCHAR NOT NULL,
  doc_key VARCHAR NOT NULL,
  field VARCHAR NOT NULL,
  tf BIGINT NOT NULL,
  positions_json VARCHAR NOT NULL,
  PRIMARY KEY (token_key, doc_key, field)
);
CREATE INDEX IF NOT EXISTS idx_search_postings_token_key ON search_postings(token_key);
CREATE INDEX IF NOT EXISTS idx_search_postings_doc_key ON search_postings(doc_key);

-- Library text staging chunks (replacing per-extract SQLite temporary staging file)
CREATE TABLE IF NOT EXISTS library_text_stage_chunks (
  stage_id VARCHAR NOT NULL,
  chunk_index BIGINT NOT NULL,
  content VARCHAR NOT NULL,
  char_offset BIGINT NOT NULL,
  hash VARCHAR NOT NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (stage_id, chunk_index)
);

-- ============================================================================
-- Pi 1.5.0 Multi-Store Durable Storage (partitioned by store_id)
-- ============================================================================
CREATE TABLE IF NOT EXISTS durable_stores (
  store_id VARCHAR PRIMARY KEY,
  format VARCHAR NOT NULL,
  next_id BIGINT NOT NULL DEFAULT 1,
  commit_seq BIGINT NOT NULL DEFAULT 0,
  writer_epoch BIGINT NOT NULL DEFAULT 1,
  host_generation VARCHAR,
  lease_holder VARCHAR,
  lease_expires_at_ms BIGINT,
  retired BOOLEAN NOT NULL DEFAULT FALSE,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS durable_ids (
  store_id VARCHAR NOT NULL,
  id BIGINT NOT NULL,
  record_kind VARCHAR NOT NULL,
  created_commit_seq BIGINT NOT NULL,
  PRIMARY KEY (store_id, id)
);

CREATE TABLE IF NOT EXISTS durable_request_keys (
  store_id VARCHAR NOT NULL,
  conversation_id BIGINT NOT NULL,
  request_id VARCHAR NOT NULL,
  submission_id BIGINT NOT NULL,
  PRIMARY KEY (store_id, conversation_id, request_id)
);

CREATE TABLE IF NOT EXISTS durable_conversations (
  store_id VARCHAR NOT NULL,
  id BIGINT NOT NULL,
  parent_conversation_id BIGINT,
  parent_at_entry_id BIGINT,
  owner_conversation_id BIGINT,
  owner_task_id BIGINT,
  record_json VARCHAR NOT NULL,
  PRIMARY KEY (store_id, id)
);
CREATE INDEX IF NOT EXISTS idx_durable_conv_owner ON durable_conversations(store_id, owner_conversation_id, owner_task_id, id);

CREATE TABLE IF NOT EXISTS durable_entries (
  store_id VARCHAR NOT NULL,
  id BIGINT NOT NULL,
  conversation_id BIGINT NOT NULL,
  kind VARCHAR NOT NULL,
  has_head BOOLEAN NOT NULL DEFAULT FALSE,
  head_entry_id BIGINT,
  by_task_id BIGINT,
  commit_seq BIGINT NOT NULL,
  record_json VARCHAR NOT NULL,
  PRIMARY KEY (store_id, id)
);
CREATE INDEX IF NOT EXISTS idx_durable_entries_conv ON durable_entries(store_id, conversation_id, id);

CREATE TABLE IF NOT EXISTS durable_tasks (
  store_id VARCHAR NOT NULL,
  id BIGINT NOT NULL,
  conversation_id BIGINT NOT NULL,
  kind VARCHAR NOT NULL,
  status VARCHAR NOT NULL,
  abort_requested BOOLEAN NOT NULL DEFAULT FALSE,
  background BOOLEAN NOT NULL DEFAULT FALSE,
  commit_seq BIGINT NOT NULL,
  record_json VARCHAR NOT NULL,
  PRIMARY KEY (store_id, id)
);
CREATE INDEX IF NOT EXISTS idx_durable_tasks_conv ON durable_tasks(store_id, conversation_id, status, id);

CREATE TABLE IF NOT EXISTS durable_submissions (
  store_id VARCHAR NOT NULL,
  id BIGINT NOT NULL,
  conversation_id BIGINT NOT NULL,
  request_id VARCHAR,
  status VARCHAR NOT NULL,
  commit_seq BIGINT NOT NULL,
  record_json VARCHAR NOT NULL,
  PRIMARY KEY (store_id, id)
);
CREATE INDEX IF NOT EXISTS idx_durable_subs_conv ON durable_submissions(store_id, conversation_id, status, id);

CREATE TABLE IF NOT EXISTS durable_documents (
  store_id VARCHAR NOT NULL,
  id BIGINT NOT NULL,
  kind VARCHAR NOT NULL,
  scope_kind VARCHAR NOT NULL,
  scope_conversation_id BIGINT,
  scope_task_id BIGINT,
  doc_key VARCHAR NOT NULL,
  history VARCHAR,
  fork_mode VARCHAR,
  created_at_seq BIGINT NOT NULL,
  retired_at_seq BIGINT,
  source_id BIGINT,
  source_at_seq BIGINT,
  record_json VARCHAR NOT NULL,
  PRIMARY KEY (store_id, id)
);
CREATE INDEX IF NOT EXISTS idx_durable_docs_addr ON durable_documents(store_id, scope_kind, scope_conversation_id, scope_task_id, kind, doc_key);

CREATE TABLE IF NOT EXISTS durable_document_revisions (
  store_id VARCHAR NOT NULL,
  document_id BIGINT NOT NULL,
  seq BIGINT NOT NULL,
  version BIGINT NOT NULL,
  content_kind VARCHAR NOT NULL,
  payload_json VARCHAR NOT NULL,
  PRIMARY KEY (store_id, document_id, seq)
);

-- ============================================================================
-- NativeHooks & NativeImprovement Tables (unified inside app.duckdb)
-- ============================================================================
CREATE SEQUENCE IF NOT EXISTS native_hook_order;

CREATE TABLE IF NOT EXISTS native_hooks (
  id VARCHAR PRIMARY KEY,
  revision BIGINT NOT NULL,
  generation BIGINT NOT NULL,
  enabled BIGINT NOT NULL,
  ord BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS native_hook_versions (
  id VARCHAR NOT NULL,
  revision BIGINT NOT NULL,
  event VARCHAR NOT NULL,
  tool VARCHAR NOT NULL,
  draft VARCHAR NOT NULL,
  hash VARCHAR NOT NULL,
  PRIMARY KEY (id, revision)
);
CREATE INDEX IF NOT EXISTS idx_native_hook_versions_event ON native_hook_versions(event, tool);

CREATE TABLE IF NOT EXISTS native_hook_receipts (
  id VARCHAR NOT NULL,
  revision BIGINT NOT NULL,
  taskId VARCHAR NOT NULL,
  conversationId VARCHAR NOT NULL,
  nativeTaskId BIGINT NOT NULL,
  event VARCHAR NOT NULL,
  tool VARCHAR NOT NULL,
  callId VARCHAR NOT NULL,
  actor VARCHAR NOT NULL,
  runKey VARCHAR NOT NULL,
  "at" BIGINT NOT NULL,
  outcome VARCHAR NOT NULL,
  message VARCHAR NOT NULL,
  parentTaskId BIGINT,
  seq_ord BIGINT NOT NULL,
  PRIMARY KEY (id, revision, taskId, conversationId, nativeTaskId, event, callId)
);
CREATE INDEX IF NOT EXISTS idx_native_hook_receipts_recent ON native_hook_receipts(id, "at");
CREATE INDEX IF NOT EXISTS idx_native_hook_receipts_finish ON native_hook_receipts(taskId, conversationId, runKey, event, outcome);

CREATE TABLE IF NOT EXISTS native_hook_readback_evidence (
  id VARCHAR NOT NULL,
  revision BIGINT NOT NULL,
  taskId VARCHAR NOT NULL,
  conversationId VARCHAR NOT NULL,
  runKey VARCHAR NOT NULL,
  inputEntry BIGINT NOT NULL,
  observed VARCHAR NOT NULL,
  seq_ord BIGINT NOT NULL,
  PRIMARY KEY (id, revision, taskId, conversationId, runKey, inputEntry, observed)
);

CREATE TABLE IF NOT EXISTS improvement_checkpoints (
  task VARCHAR NOT NULL,
  conversation VARCHAR NOT NULL,
  state VARCHAR NOT NULL,
  PRIMARY KEY (task, conversation)
);

CREATE TABLE IF NOT EXISTS improvement_child_evidence (
  task VARCHAR NOT NULL,
  directory VARCHAR NOT NULL,
  conversation BIGINT NOT NULL,
  childId VARCHAR NOT NULL,
  immutable BIGINT NOT NULL,
  summary VARCHAR NOT NULL,
  PRIMARY KEY (task, conversation)
);

CREATE TABLE IF NOT EXISTS child_review_weeks (week VARCHAR PRIMARY KEY);
CREATE TABLE IF NOT EXISTS release_review_weeks (week VARCHAR PRIMARY KEY);
CREATE TABLE IF NOT EXISTS improvement_unverified (key VARCHAR PRIMARY KEY, source VARCHAR, reason VARCHAR);
CREATE TABLE IF NOT EXISTS weekly_cost (week VARCHAR PRIMARY KEY, duration BIGINT DEFAULT 0, requests BIGINT DEFAULT 0);

CREATE TABLE IF NOT EXISTS improvement_inputs (
  task VARCHAR NOT NULL,
  conversation VARCHAR NOT NULL,
  entry BIGINT NOT NULL,
  "at" BIGINT,
  eligible BIGINT,
  actor VARCHAR,
  PRIMARY KEY (task, conversation, entry)
);
CREATE INDEX IF NOT EXISTS idx_improvement_inputs_week ON improvement_inputs("at", eligible);

CREATE TABLE IF NOT EXISTS improvement_input_scopes (
  task VARCHAR NOT NULL,
  conversation VARCHAR NOT NULL,
  entry BIGINT NOT NULL,
  project VARCHAR,
  workspace VARCHAR,
  PRIMARY KEY (task, conversation, entry)
);

CREATE TABLE IF NOT EXISTS improvement_observations (
  key VARCHAR,
  kind VARCHAR NOT NULL,
  scope VARCHAR,
  task VARCHAR NOT NULL,
  conversation VARCHAR NOT NULL,
  entry BIGINT NOT NULL,
  source VARCHAR,
  replay VARCHAR,
  generation BIGINT,
  seq_ord BIGINT NOT NULL,
  PRIMARY KEY (task, conversation, entry, kind)
);
CREATE INDEX IF NOT EXISTS idx_improvement_obs_key ON improvement_observations(key);

CREATE TABLE IF NOT EXISTS improvement_managed (key VARCHAR PRIMARY KEY, hook VARCHAR, revision BIGINT, installed BIGINT, week VARCHAR);
CREATE TABLE IF NOT EXISTS improvement_slots (key VARCHAR PRIMARY KEY, week VARCHAR NOT NULL);
CREATE TABLE IF NOT EXISTS improvement_assessments (key VARCHAR NOT NULL, week VARCHAR NOT NULL, source VARCHAR, assessment VARCHAR, error VARCHAR, PRIMARY KEY (key, week));
CREATE TABLE IF NOT EXISTS improvement_followup (week VARCHAR NOT NULL, key VARCHAR NOT NULL, metrics VARCHAR, PRIMARY KEY (week, key));
CREATE TABLE IF NOT EXISTS improvement_cycles (week VARCHAR PRIMARY KEY, "at" BIGINT, scanned BIGINT DEFAULT 0, added BIGINT DEFAULT 0, issues VARCHAR DEFAULT '[]', finished BIGINT DEFAULT 0);
CREATE TABLE IF NOT EXISTS improvement_review_lease (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner VARCHAR NOT NULL,
  expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS path_hints (
  key VARCHAR PRIMARY KEY,
  task VARCHAR,
  cwd VARCHAR,
  missing VARCHAR,
  found VARCHAR,
  enabled BIGINT,
  week VARCHAR
);
CREATE INDEX IF NOT EXISTS idx_path_hints_lookup ON path_hints(task, cwd, missing, enabled);

CREATE TABLE IF NOT EXISTS path_hint_uses (
  key VARCHAR NOT NULL,
  conversation VARCHAR NOT NULL,
  run VARCHAR NOT NULL,
  call VARCHAR NOT NULL,
  repaired BIGINT DEFAULT 0,
  PRIMARY KEY (key, conversation, run, call)
);

CREATE SEQUENCE IF NOT EXISTS improvement_event_order;
CREATE TABLE IF NOT EXISTS improvement_staged (hash VARCHAR PRIMARY KEY, draft VARCHAR NOT NULL, replays VARCHAR NOT NULL, validated_seq BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS improvement_versions (id VARCHAR NOT NULL, revision BIGINT NOT NULL, hash VARCHAR NOT NULL, previous BIGINT, "at" BIGINT, retired BIGINT DEFAULT 0, PRIMARY KEY (id, revision), UNIQUE (id, hash));
CREATE TABLE IF NOT EXISTS improvement_heads (id VARCHAR PRIMARY KEY, revision BIGINT, generation BIGINT, enabled BIGINT, scopeKind VARCHAR, scopeId VARCHAR);
CREATE INDEX IF NOT EXISTS idx_improvement_scope ON improvement_heads(scopeKind, scopeId, enabled);
CREATE TABLE IF NOT EXISTS improvement_switches (id VARCHAR NOT NULL, generation BIGINT NOT NULL, revision BIGINT, "at" BIGINT, enabled BIGINT, PRIMARY KEY (id, generation));
CREATE TABLE IF NOT EXISTS improvement_uses (
  id VARCHAR NOT NULL,
  revision BIGINT NOT NULL,
  task VARCHAR NOT NULL,
  conversation VARCHAR NOT NULL,
  actor VARCHAR,
  run VARCHAR NOT NULL,
  kind VARCHAR NOT NULL,
  event VARCHAR NOT NULL,
  generation VARCHAR NOT NULL,
  detail VARCHAR,
  "at" BIGINT,
  seq_ord BIGINT NOT NULL,
  PRIMARY KEY (id, revision, task, conversation, run, kind, event, generation)
);
CREATE INDEX IF NOT EXISTS idx_improvement_use_run ON improvement_uses(task, conversation, run);
CREATE TABLE IF NOT EXISTS improvement_dirty_weeks (week VARCHAR NOT NULL, token BIGINT NOT NULL, PRIMARY KEY (week, token));
CREATE TABLE IF NOT EXISTS improvement_regressions (id VARCHAR NOT NULL, hash VARCHAR NOT NULL, input VARCHAR, revision BIGINT, seq_ord BIGINT NOT NULL, PRIMARY KEY (id, hash));
CREATE TABLE IF NOT EXISTS improvement_results (week VARCHAR NOT NULL, id VARCHAR NOT NULL, revision BIGINT NOT NULL, result VARCHAR, PRIMARY KEY (week, id, revision));

-- Scalar SQL macro replacing task_board SQLite custom function
CREATE OR REPLACE MACRO board_space(bot, team) AS
  CASE WHEN team IS NOT NULL AND team <> ''
       THEN 'bot-team-space-' || substr(sha256(team), 1, 24)
       ELSE 'bot-space-' || substr(sha256(bot), 1, 24)
  END;
