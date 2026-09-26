-- 0010 self-service onboarding (owner: WT-14; ADR 0011).
--
-- 1. subscriptions: a plan is assigned first (`pending`, no dates) and redeemed when the tenant's
--    first server activates (dates set, status `active`). SQLite cannot change a CHECK or drop a
--    NOT NULL in place, so the table is rebuilt (D1: `defer_foreign_keys`, because
--    `entitlements.subscription_id` references it; ids are copied unchanged).
-- 2. license_keys: server licence keys staff generate in batches for resellers; a buyer redeems one
--    at onboarding. Only the SHA-256 of a key is stored; `code_last4` is for support lookups.
PRAGMA defer_foreign_keys = true;
--> statement-breakpoint
CREATE TABLE `subscriptions_new` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`plan_code` text NOT NULL,
	`status` text NOT NULL,
	`valid_from` text,
	`valid_until` text,
	`max_managed_users` integer NOT NULL,
	`features_json` text NOT NULL,
	`offline_grace_days` integer NOT NULL,
	`renewal_warning_days` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`plan_code`) REFERENCES `plans`(`code`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "subscriptions_status_check" CHECK("status" IN ('pending', 'trial', 'active', 'past_due', 'suspended', 'cancelled')),
	CONSTRAINT "subscriptions_dates_check" CHECK("status" = 'pending' OR ("valid_from" IS NOT NULL AND "valid_until" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `subscriptions_new` (`id`, `tenant_id`, `plan_code`, `status`, `valid_from`, `valid_until`, `max_managed_users`, `features_json`, `offline_grace_days`, `renewal_warning_days`, `created_at`, `updated_at`)
SELECT `id`, `tenant_id`, `plan_code`, `status`, `valid_from`, `valid_until`, `max_managed_users`, `features_json`, `offline_grace_days`, `renewal_warning_days`, `created_at`, `updated_at` FROM `subscriptions`;
--> statement-breakpoint
DROP TABLE `subscriptions`;
--> statement-breakpoint
ALTER TABLE `subscriptions_new` RENAME TO `subscriptions`;
--> statement-breakpoint
CREATE INDEX `subscriptions_tenant_status_idx` ON `subscriptions` (`tenant_id`,`status`);
--> statement-breakpoint
PRAGMA defer_foreign_keys = false;
--> statement-breakpoint
CREATE TABLE `license_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`code_last4` text NOT NULL,
	`plan_code` text NOT NULL,
	`batch_label` text NOT NULL,
	`status` text DEFAULT 'unredeemed' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`expires_at` text,
	`redeemed_at` text,
	`redeemed_tenant_id` text,
	`redeemed_by_email` text,
	`revoked_at` text,
	`revoke_reason` text,
	FOREIGN KEY (`plan_code`) REFERENCES `plans`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`redeemed_tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "license_keys_status_check" CHECK("status" IN ('unredeemed', 'redeemed', 'revoked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `license_keys_code_hash_unique` ON `license_keys` (`code_hash`);
--> statement-breakpoint
CREATE INDEX `license_keys_batch_idx` ON `license_keys` (`batch_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `license_keys_status_idx` ON `license_keys` (`status`, `created_at`);
--> statement-breakpoint
CREATE INDEX `license_keys_last4_idx` ON `license_keys` (`code_last4`);
