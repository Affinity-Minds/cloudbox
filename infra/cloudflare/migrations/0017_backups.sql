-- 0017 backups (owner: WT-19). Master spec §23 (all subsections), §46; Slices 9.3-9.5 cloud
-- halves (offsite upload/verify, retention policy data, dashboard). Hand-written to match
-- db/schema.ts's declarative CHECKs (new tables, so unlike 0009/0011's ALTER-added columns, D1
-- can pair a CHECK with these at CREATE time).
CREATE TABLE `backup_policies` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`frequent_hours` integer DEFAULT 4 NOT NULL,
	`daily_keep` integer DEFAULT 30 NOT NULL,
	`weekly_keep` integer DEFAULT 12 NOT NULL,
	`monthly_keep` integer DEFAULT 12 NOT NULL,
	`yearly_keep` integer DEFAULT 0 NOT NULL,
	`offsite_enabled` integer DEFAULT 1 NOT NULL,
	`updated_by` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `backup_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`device_id` text NOT NULL,
	`kind` text NOT NULL,
	`state` text DEFAULT 'created' NOT NULL,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`finished_at` text,
	`source_dataset` text NOT NULL,
	`app_version` text,
	`size_bytes` integer,
	`sha256` text,
	`local_path_hint` text,
	`error_json` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "backup_jobs_kind_check" CHECK("backup_jobs"."kind" IN ('frequent', 'nightly', 'manual', 'pre_upgrade')),
	CONSTRAINT "backup_jobs_state_check" CHECK("backup_jobs"."state" IN ('created', 'verified_local', 'upload_started', 'upload_completed', 'cloud_verified', 'retention_applied', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `backup_jobs_tenant_device_idx` ON `backup_jobs` (`tenant_id`,`device_id`,`started_at`);
--> statement-breakpoint
CREATE INDEX `backup_jobs_device_state_idx` ON `backup_jobs` (`device_id`,`state`);
--> statement-breakpoint
CREATE TABLE `backup_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`size_bytes` integer,
	`sha256` text,
	`encryption_json` text,
	`uploaded_at` text,
	`verified_at` text,
	`retention_class` text,
	`expires_at` text,
	`deleted_at` text,
	`multipart_upload_id` text,
	FOREIGN KEY (`job_id`) REFERENCES `backup_jobs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "backup_artifacts_retention_class_check" CHECK("backup_artifacts"."retention_class" IS NULL OR "backup_artifacts"."retention_class" IN ('recent', 'daily', 'weekly', 'monthly', 'yearly'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `backup_artifacts_job_id_unique` ON `backup_artifacts` (`job_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `backup_artifacts_r2_key_unique` ON `backup_artifacts` (`r2_key`);
--> statement-breakpoint
CREATE INDEX `backup_artifacts_job_idx` ON `backup_artifacts` (`job_id`);
--> statement-breakpoint
CREATE TABLE `restore_tests` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`device_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`performed_by` text NOT NULL,
	`performed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`outcome` text NOT NULL,
	`notes` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`artifact_id`) REFERENCES `backup_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "restore_tests_outcome_check" CHECK("restore_tests"."outcome" IN ('success', 'failure', 'partial'))
);
--> statement-breakpoint
CREATE INDEX `restore_tests_device_idx` ON `restore_tests` (`device_id`,`performed_at`);
--> statement-breakpoint
CREATE INDEX `restore_tests_tenant_idx` ON `restore_tests` (`tenant_id`,`performed_at`);
--> statement-breakpoint
-- Global default retention policy (§23.7 template), read when a tenant has no `backup_policies`
-- row of its own. `INSERT OR IGNORE` so re-running this migration file is harmless.
INSERT OR IGNORE INTO `settings` (`key`, `value_json`, `updated_at`) VALUES (
	'backups.default_policy',
	'{"frequentHours":4,"dailyKeep":30,"weeklyKeep":12,"monthlyKeep":12,"yearlyKeep":0,"offsiteEnabled":true}',
	(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
