-- 0004 Better Auth rate-limit storage (owner: WT-1).
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
