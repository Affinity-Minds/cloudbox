-- 0004 auth (owner: WT-1): Better Auth rate-limit storage, staff password + authenticator
-- (ADR 0009: twoFactor plugin tables, staff_members.must_change_password). Not yet deployed when
-- the staff-password part was added in place.
-- `rateLimit.storage = "database"` keeps per-IP auth limits in D1 so every isolate shares them.
-- Shape matches `auth@1.7.6 generate` for the `rateLimit` model; Drizzle table in
-- apps/worker-api/src/auth/rate-limit-table.ts (WT-0 may move it into db/schema.ts verbatim).
CREATE TABLE `rate_limit` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`count` integer NOT NULL,
	`last_request` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rate_limit_key_unique` ON `rate_limit` (`key`);
--> statement-breakpoint
ALTER TABLE `user` ADD `two_factor_enabled` integer DEFAULT false;
--> statement-breakpoint
CREATE TABLE `two_factor` (
	`id` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL,
	`backup_codes` text NOT NULL,
	`user_id` text NOT NULL,
	`verified` integer DEFAULT true,
	`failed_verification_count` integer DEFAULT 0,
	`locked_until` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `twoFactor_secret_idx` ON `two_factor` (`secret`);
--> statement-breakpoint
CREATE INDEX `twoFactor_userId_idx` ON `two_factor` (`user_id`);
--> statement-breakpoint
-- Every staff account starts on an admin-set password that must be replaced at first sign-in.
ALTER TABLE `staff_members` ADD `must_change_password` integer DEFAULT 1 NOT NULL;
