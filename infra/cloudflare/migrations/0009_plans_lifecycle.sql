-- 0009 plan designer (owner: WT-13). Plans grow a lifecycle: description, status (active/retired,
-- default active — a plan is never deleted, only retired), created_at/updated_at, and a term
-- (term_days: how many days a redeemed subscription runs — owner addition, mid-slice; the
-- redemption semantics — pending subscription -> valid_from/valid_until set at tenant server
-- activation -> device licence issued — belong to WT-14 in a sibling worktree, not this one; this
-- migration only adds the column). `code` stays the PK and is immutable. The seeded `cloudbox-6`
-- row (migration 0003) predates these columns and gets them backfilled here so it reads like any
-- other plan. Hand-written (no drizzle-kit diff was run for the ALTER statements), matching
-- 0002's/0003's tail style: no statement-breakpoint markers.

-- D1/SQLite's ALTER TABLE ADD COLUMN only accepts a constant default, not a function call — so
-- created_at/updated_at get a fixed placeholder here and are backfilled to a real timestamp for
-- the seeded row below. Every row the API inserts from here on sets both explicitly (`nowIso()`),
-- same as every other table in this schema; the column default is only for this migration's sake.
ALTER TABLE `plans` ADD COLUMN `description` text;
ALTER TABLE `plans` ADD COLUMN `status` text DEFAULT 'active' NOT NULL;
ALTER TABLE `plans` ADD COLUMN `term_days` integer DEFAULT 365 NOT NULL;
ALTER TABLE `plans` ADD COLUMN `created_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL;
ALTER TABLE `plans` ADD COLUMN `updated_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL;

-- D1/SQLite cannot add a CHECK constraint via ALTER TABLE; enforce it with triggers instead
-- (same idiom as 0002's audit_log_no_update/_no_delete), checked on every insert/update.
CREATE TRIGGER IF NOT EXISTS plans_status_check_insert
BEFORE INSERT ON plans
WHEN NEW.status NOT IN ('active', 'retired')
BEGIN
  SELECT RAISE(ABORT, 'plans.status must be active or retired');
END;

CREATE TRIGGER IF NOT EXISTS plans_status_check_update
BEFORE UPDATE ON plans
WHEN NEW.status NOT IN ('active', 'retired')
BEGIN
  SELECT RAISE(ABORT, 'plans.status must be active or retired');
END;

CREATE TRIGGER IF NOT EXISTS plans_term_days_check_insert
BEFORE INSERT ON plans
WHEN NEW.term_days < 1 OR NEW.term_days > 3650
BEGIN
  SELECT RAISE(ABORT, 'plans.term_days must be between 1 and 3650');
END;

CREATE TRIGGER IF NOT EXISTS plans_term_days_check_update
BEFORE UPDATE ON plans
WHEN NEW.term_days < 1 OR NEW.term_days > 3650
BEGIN
  SELECT RAISE(ABORT, 'plans.term_days must be between 1 and 3650');
END;

UPDATE `plans`
SET
  `description` = 'The single bundled plan: 1 device, 6 managed users, remote access, managed backup, fleet.',
  `status` = 'active',
  `term_days` = 365,
  `created_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `code` = 'cloudbox-6';
