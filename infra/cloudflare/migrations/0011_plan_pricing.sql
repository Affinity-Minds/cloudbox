-- 0011 plan pricing (owner: WT-13). Plans carry a price and an add-on-user price; subscriptions
-- carry how many add-on users a tenant bought. `currency` is drizzle-kit generated (`ALTER TABLE
-- ADD COLUMN`, same generate → rename workflow as 0009); its enum is enforced with triggers below,
-- same idiom as 0009's `plans_status_check_*`/`plans_term_days_check_*` — D1/SQLite cannot pair an
-- ALTER-added column with an inline CHECK. Price amounts, `max_addon_users` and `addon_users` are
-- plain non-negative integers, bounds enforced by the API (Zod), not a DB CHECK — same as
-- `offline_grace_days`/`renewal_warning_days`.
ALTER TABLE `plans` ADD `price_amount` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `plans` ADD `currency` text DEFAULT 'INR' NOT NULL;--> statement-breakpoint
ALTER TABLE `plans` ADD `addon_user_price_amount` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `plans` ADD `max_addon_users` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `addon_users` integer DEFAULT 0 NOT NULL;--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS plans_currency_check_insert
BEFORE INSERT ON plans
WHEN NEW.currency NOT IN ('INR', 'USD', 'EUR', 'GBP', 'AED')
BEGIN
  SELECT RAISE(ABORT, 'plans.currency must be one of INR, USD, EUR, GBP, AED');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS plans_currency_check_update
BEFORE UPDATE ON plans
WHEN NEW.currency NOT IN ('INR', 'USD', 'EUR', 'GBP', 'AED')
BEGIN
  SELECT RAISE(ABORT, 'plans.currency must be one of INR, USD, EUR, GBP, AED');
END;