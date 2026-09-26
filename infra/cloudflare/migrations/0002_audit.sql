CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY NOT NULL,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS audit_log_created_at_idx
  ON audit_log(created_at DESC);

CREATE INDEX IF NOT EXISTS audit_log_entity_idx
  ON audit_log(entity_type, entity_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

INSERT OR IGNORE INTO settings (key, value_json)
VALUES ('foundation.release', '{"status":"bootstrapped","sha":"uninitialized"}');

INSERT OR IGNORE INTO audit_log (
  id, event_type, entity_type, entity_id, actor_type, actor_id, action, before_json, after_json
)
VALUES (
  'phase0-initial-schema',
  'foundation.initialized',
  'setting',
  'foundation.release',
  'system',
  'migration',
  'initialize',
  NULL,
  '{"status":"bootstrapped","sha":"uninitialized"}'
);
