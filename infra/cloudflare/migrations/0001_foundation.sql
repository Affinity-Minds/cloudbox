-- Phase 0 foundation migration.
-- The first product table arrives in Slice 0.3 with append-only audit infrastructure.
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', '1');
