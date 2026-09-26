-- 0008 email provider registry (owner: WT-12).
-- Drizzle table lives in apps/worker-api/src/email/providers/schema.ts, not db/schema.ts (WT-0's
-- file) — see that file's header comment and docs/handoffs/wt-p1-email-providers.md "Requests to
-- WT-0". Secrets (SMTP password) are AES-256-GCM ciphertext, never plaintext; `config_json` holds
-- only non-secret fields (host, port, secure, username).

CREATE TABLE `email_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`priority` integer NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`from_address` text NOT NULL,
	`config_json` text DEFAULT '{}' NOT NULL,
	`secret_ciphertext` text,
	`secret_iv` text,
	`updated_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "email_providers_kind_check" CHECK("email_providers"."kind" IN ('cloudflare_binding', 'smtp', 'log'))
);
--> statement-breakpoint
CREATE INDEX `email_providers_enabled_priority_idx` ON `email_providers` (`enabled`, `priority`);
