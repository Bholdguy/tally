-- Tally backend of record (PRD §B.10). SQLite, WAL. Timestamps: INTEGER epoch ms; t_ms = ms since session start.
-- (+) = column added to the brief's §9 model.

CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS menu (
  item_id        TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  price_cents    INTEGER NOT NULL CHECK (price_cents > 0),
  aliases_json   TEXT NOT NULL,
  modifiers_json TEXT NOT NULL          -- [{id, price_delta_cents}]
);

CREATE TABLE IF NOT EXISTS configs (
  id                TEXT PRIMARY KEY,
  version           TEXT NOT NULL UNIQUE,
  prompt_hash       TEXT NOT NULL,
  tool_schema_hash  TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  promoted          INTEGER NOT NULL DEFAULT 0 CHECK (promoted IN (0,1)),
  prompt_text       TEXT NOT NULL,               -- (+)
  tool_schema_json  TEXT NOT NULL,               -- (+)
  turn_detection_json TEXT NOT NULL DEFAULT '{}',-- (+)
  gating_params_json  TEXT NOT NULL DEFAULT '{}',-- (+)
  parent_version    TEXT                         -- (+)
);

-- Step 9: promotion. `promoted=1` means ACTIVE (at most one row). Versions are immutable; only the flag ever changes, and only
-- through the committer after a passing, fresh, unconsumed suite run (enforced in committer-configs.ts).
CREATE UNIQUE INDEX IF NOT EXISTS one_active_config ON configs(promoted) WHERE promoted = 1;
CREATE TRIGGER IF NOT EXISTS configs_immutable BEFORE UPDATE OF id, version, prompt_hash, tool_schema_hash, created_at, prompt_text, tool_schema_json, turn_detection_json, gating_params_json, parent_version ON configs
BEGIN SELECT RAISE(ABORT, 'configs are immutable: create a new version instead (rule 4)'); END;
CREATE TRIGGER IF NOT EXISTS configs_no_delete BEFORE DELETE ON configs
BEGIN SELECT RAISE(ABORT, 'configs are never deleted (rule 4)'); END;

-- Append-only history of what happened to versions (create / baseline / promote / rollback / blocked).
CREATE TABLE IF NOT EXISTS config_events (
  id           TEXT PRIMARY KEY,
  version      TEXT NOT NULL REFERENCES configs(version),
  action       TEXT NOT NULL CHECK (action IN ('create','baseline','promote','rollback','blocked')),
  at           INTEGER NOT NULL,
  actor        TEXT NOT NULL,
  suite_run_id TEXT,
  detail_json  TEXT NOT NULL DEFAULT '{}'
);
CREATE TRIGGER IF NOT EXISTS config_events_no_update BEFORE UPDATE ON config_events BEGIN SELECT RAISE(ABORT, 'config_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS config_events_no_delete BEFORE DELETE ON config_events BEGIN SELECT RAISE(ABORT, 'config_events is append-only'); END;

-- One row per "run all cases" for a candidate. Only `consumed_at` may change (a passing run promotes at most once).
CREATE TABLE IF NOT EXISTS suite_runs (
  id               TEXT PRIMARY KEY,
  config_version   TEXT NOT NULL REFERENCES configs(version),
  started_at       INTEGER NOT NULL,
  finished_at      INTEGER NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('passed','blocked')),
  case_ids_json    TEXT NOT NULL,           -- the exact regression set that was run (staleness check at promotion)
  evidence_json    TEXT NOT NULL,           -- per-case evidence-tier results
  audio_requested  INTEGER NOT NULL DEFAULT 0,
  audio_json       TEXT,                    -- per-case audio-tier results (k/3), when requested
  blocking_json    TEXT NOT NULL DEFAULT '[]',
  consumed_at      INTEGER
);
CREATE TRIGGER IF NOT EXISTS suite_runs_immutable BEFORE UPDATE OF id, config_version, started_at, finished_at, status, case_ids_json, evidence_json, audio_requested, audio_json, blocking_json ON suite_runs
BEGIN SELECT RAISE(ABORT, 'suite_runs are immutable'); END;
CREATE TRIGGER IF NOT EXISTS suite_runs_no_delete BEFORE DELETE ON suite_runs BEGIN SELECT RAISE(ABORT, 'suite_runs are never deleted'); END;

CREATE TABLE IF NOT EXISTS sessions (
  id                    TEXT PRIMARY KEY,
  started_at            INTEGER NOT NULL,
  ended_at              INTEGER,
  agent_config_version  TEXT NOT NULL,
  aai_session_id        TEXT,                                            -- (+)
  mode                  TEXT NOT NULL CHECK (mode IN ('live','demo','replay')), -- (+)
  audio_pointer         TEXT,                                            -- (+)
  intent_json           TEXT                                             -- (+) the order the speaker INTENDED, declared before speaking (demo scenarios, real-speech runs): the accuracy metric's ground truth
);

-- Lossless evidence store; everything below is derivable from it (PRD §B.10).
CREATE TABLE IF NOT EXISTS events_raw (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id),
  direction    TEXT NOT NULL CHECK (direction IN ('in','out')),
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  t_ms         REAL NOT NULL,
  ts           INTEGER NOT NULL,
  audio_offset_ms REAL NOT NULL DEFAULT 0,
  server_ts_ms REAL                       -- the SERVER's own timestamp when the wire provides one (D-05); preferred for ordering
);
CREATE INDEX IF NOT EXISTS idx_events_raw_session ON events_raw(session_id, t_ms);

CREATE TABLE IF NOT EXISTS utterances (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id),
  speaker        TEXT NOT NULL CHECK (speaker IN ('user','agent')),
  text           TEXT NOT NULL,
  is_partial     INTEGER NOT NULL CHECK (is_partial IN (0,1)),
  confidence     REAL,                       -- NULLABLE: API provides none (D-03)
  timestamp      INTEGER NOT NULL,
  t_ms           REAL NOT NULL,              -- (+)
  audio_offset_ms REAL NOT NULL,             -- (+)
  item_id        TEXT,                       -- (+)
  reply_id       TEXT,                       -- (+)
  start_ms       REAL, end_ms REAL,          -- (+)
  interrupted    INTEGER,                    -- (+)
  revision_of    TEXT,                       -- (+)
  instability    REAL,                       -- (+) text-instability score (D-03)
  source         TEXT NOT NULL DEFAULT 'agent_stream' CHECK (source IN ('agent_stream','independent_stt')), -- (+) who heard it
  server_ts_ms   REAL,                       -- (+)
  words_json     TEXT                        -- (+) per-word confidence (independent stream only)
);
CREATE INDEX IF NOT EXISTS idx_utt_session ON utterances(session_id, t_ms);

CREATE TABLE IF NOT EXISTS vad_events (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  type       TEXT NOT NULL CHECK (type IN ('speech_start','speech_end','barge_in')),
  timestamp  INTEGER NOT NULL,
  t_ms       REAL NOT NULL,                  -- (+)
  derived    INTEGER NOT NULL DEFAULT 0 CHECK (derived IN (0,1)),  -- (+) barge_in is derived (D-02)
  source_event_ids TEXT NOT NULL DEFAULT '[]',                     -- (+)
  source     TEXT NOT NULL DEFAULT 'agent' CHECK (source IN ('agent','local','independent','derived')), -- (+)
  reaction_ms REAL,                                                                                     -- (+) barge-in: speech start -> reply.done(interrupted)
  CHECK (type <> 'barge_in' OR derived = 1)
);

CREATE TABLE IF NOT EXISTS entities (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL REFERENCES sessions(id),
  type                TEXT NOT NULL CHECK (type IN ('item','quantity','modifier','removal','substitution','total','pickup_time')),
  value               TEXT NOT NULL,
  extracted_at        INTEGER NOT NULL,
  source_utterance_id TEXT NOT NULL REFERENCES utterances(id),   -- provenance is mandatory (rule 2)
  item_ref            TEXT, span_start INTEGER, span_end INTEGER, cue TEXT, superseded_by TEXT  -- (+)
);

CREATE TABLE IF NOT EXISTS orders (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL UNIQUE REFERENCES sessions(id),
  items_json    TEXT NOT NULL DEFAULT '[]',
  total         INTEGER NOT NULL DEFAULT 0,                       -- cents
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','confirmed','cancelled')),
  updated_at    INTEGER NOT NULL,
  pickup_time   TEXT,                                             -- (+)
  last_validation_event_id TEXT NOT NULL                          -- (+) rule 8 pairing
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL REFERENCES sessions(id),
  tool_name          TEXT NOT NULL,
  args_json          TEXT NOT NULL,
  claimed_result_json TEXT,           -- {arguments, spoken_text} (D-06)
  actual_result_json TEXT,
  status             TEXT NOT NULL CHECK (status IN ('allowed','held','conflict')),
  timestamp          INTEGER NOT NULL,
  aai_call_id        TEXT NOT NULL,                       -- (+)
  conflict_type      TEXT,                                -- (+)
  evidence_json      TEXT,                                -- (+)
  state_diff_json    TEXT,                                -- (+)
  validation_event_id TEXT NOT NULL,                      -- (+)
  execution_mode     TEXT NOT NULL CHECK (execution_mode IN ('hold','interactive')), -- (+)
  t_received_ms REAL, t_verdict_ms REAL, t_commit_ms REAL, -- (+)
  UNIQUE (session_id, aai_call_id)
);

CREATE TABLE IF NOT EXISTS repair_events (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  tool_call_id  TEXT NOT NULL REFERENCES tool_calls(id),
  reason        TEXT NOT NULL,
  repair_prompt TEXT NOT NULL,
  resolved_at   INTEGER,
  outcome       TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('resolved','escalated','pending')),
  attempt       INTEGER NOT NULL DEFAULT 1,                 -- (+)
  resolving_tool_call_id TEXT,                              -- (+)
  scope         TEXT NOT NULL DEFAULT 'order',              -- (+) the disputed item_id, or 'order'
  alt_scope     TEXT                                        -- (+) the item the customer actually asked for (ITEM_MISMATCH)
);

CREATE TABLE IF NOT EXISTS cases (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL REFERENCES sessions(id),
  tool_call_id        TEXT NOT NULL UNIQUE REFERENCES tool_calls(id),
  audio_pointer       TEXT NOT NULL,
  transcript_snapshot TEXT NOT NULL,
  conflict_type       TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  tag                 TEXT NOT NULL DEFAULT 'none' CHECK (tag IN ('none','regression_candidate','regression')),
  pattern_key         TEXT NOT NULL,                        -- (+)
  event_snapshot_json TEXT NOT NULL,                        -- (+)
  expected_state_json TEXT,                                 -- (+)
  origin_mode         TEXT NOT NULL CHECK (origin_mode IN ('live','demo')), -- (+)
  resolution          TEXT NOT NULL DEFAULT 'open' CHECK (resolution IN ('open','resolved','escalated','unresolved_at_hangup','no_repair')), -- (+) what became of the dispute
  accepted_by         TEXT                                      -- (+) set when promoted to tag=regression (operator or auto)
);
CREATE INDEX IF NOT EXISTS idx_cases_pattern ON cases(pattern_key);

CREATE TABLE IF NOT EXISTS replay_runs (
  id                   TEXT PRIMARY KEY,
  case_id              TEXT NOT NULL REFERENCES cases(id),
  agent_config_version TEXT NOT NULL,
  result               TEXT NOT NULL CHECK (result IN ('pass','fail')),
  run_at               INTEGER NOT NULL,
  tier                 TEXT NOT NULL CHECK (tier IN ('evidence','audio')),  -- (+)
  attempt_k            INTEGER NOT NULL DEFAULT 1,                          -- (+)
  actual_state_json    TEXT, diff_json TEXT,                                -- (+)
  suite_run_id         TEXT,                                                -- (+)
  duration_ms          REAL                                                 -- (+) wall time of the run (audio tier includes the clip length; reported separately per tier)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  actor         TEXT NOT NULL CHECK (actor IN ('plane1','plane2','operator')),
  action        TEXT NOT NULL,
  before_state  TEXT,
  after_state   TEXT,
  timestamp     INTEGER NOT NULL,
  tool_call_id  TEXT,                                       -- (+)
  validation_event_id TEXT                                  -- (+)
);
CREATE INDEX IF NOT EXISTS idx_audit_validation ON audit_events(validation_event_id);

CREATE TABLE IF NOT EXISTS metrics_samples (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  stage      TEXT NOT NULL CHECK (stage IN ('stt','gate','repair','commit','first_audio','barge_in')),
  value_ms   REAL NOT NULL,
  ts         INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------------------------------
-- Integrity triggers (ARCHITECTURE §4.2, SECURITY §4): the database itself enforces rule 8 pairing and
-- append-only evidence, so a bug in application code cannot silently violate them.
-- ---------------------------------------------------------------------------------------------------

-- Every order change must point at an audit row carrying the validation event id (same transaction).
CREATE TRIGGER IF NOT EXISTS orders_require_validation_ins BEFORE INSERT ON orders
WHEN NOT EXISTS (SELECT 1 FROM audit_events WHERE validation_event_id = NEW.last_validation_event_id)
BEGIN SELECT RAISE(ABORT, 'orders: insert requires a paired audit_events row (validation_event_id)'); END;

CREATE TRIGGER IF NOT EXISTS orders_require_validation_upd BEFORE UPDATE ON orders
WHEN NEW.last_validation_event_id IS OLD.last_validation_event_id
  OR NOT EXISTS (SELECT 1 FROM audit_events WHERE validation_event_id = NEW.last_validation_event_id)
BEGIN SELECT RAISE(ABORT, 'orders: update requires a NEW validation_event_id with a paired audit_events row'); END;

CREATE TRIGGER IF NOT EXISTS orders_no_delete BEFORE DELETE ON orders
BEGIN SELECT RAISE(ABORT, 'orders: rows are never deleted'); END;

CREATE TRIGGER IF NOT EXISTS events_raw_no_update BEFORE UPDATE ON events_raw
BEGIN SELECT RAISE(ABORT, 'events_raw is append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_raw_no_delete BEFORE DELETE ON events_raw
BEGIN SELECT RAISE(ABORT, 'events_raw is append-only'); END;

CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;

CREATE TRIGGER IF NOT EXISTS cases_snapshot_immutable BEFORE UPDATE OF event_snapshot_json, transcript_snapshot, audio_pointer, tool_call_id ON cases
BEGIN SELECT RAISE(ABORT, 'cases: snapshot columns are immutable'); END;
CREATE TRIGGER IF NOT EXISTS cases_no_delete BEFORE DELETE ON cases
BEGIN SELECT RAISE(ABORT, 'cases are never deleted (rule 5)'); END;

-- Configs are versioned and never silently overwritten (rule 4); only `promoted` may change.
CREATE TRIGGER IF NOT EXISTS configs_immutable BEFORE UPDATE OF version, prompt_hash, tool_schema_hash, prompt_text, tool_schema_json, turn_detection_json, gating_params_json, parent_version, created_at ON configs
BEGIN SELECT RAISE(ABORT, 'configs are immutable; create a new version'); END;
CREATE TRIGGER IF NOT EXISTS configs_no_delete BEFORE DELETE ON configs
BEGIN SELECT RAISE(ABORT, 'configs are never deleted'); END;
