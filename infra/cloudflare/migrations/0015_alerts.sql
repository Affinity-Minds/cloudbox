CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`device_id` text,
	`category` text NOT NULL,
	`severity` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`dedupe_key` text NOT NULL,
	`opened_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`last_evidence_json` text,
	`last_seen_at` text,
	`acknowledged_by` text,
	`acknowledged_at` text,
	`resolved_at` text,
	`notified_at` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "alerts_category_check" CHECK("alerts"."category" IN ('device_offline', 'license_expiring', 'license_expired', 'no_active_plan', 'clock_tamper', 'device_binding_failure', 'backup_failed', 'backup_overdue', 'disk_low', 'agent_outdated', 'update_failed', 'reboot_required', 'private_network_failed', 'rdp_unhealthy', 'break_glass_active')),
	CONSTRAINT "alerts_severity_check" CHECK("alerts"."severity" IN ('info', 'warning', 'critical')),
	CONSTRAINT "alerts_status_check" CHECK("alerts"."status" IN ('open', 'acknowledged', 'resolved'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alerts_dedupe_key_unique` ON `alerts` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `alerts_status_severity_idx` ON `alerts` (`status`,`severity`);--> statement-breakpoint
CREATE INDEX `alerts_tenant_status_idx` ON `alerts` (`tenant_id`,`status`);--> statement-breakpoint
CREATE INDEX `alerts_device_status_idx` ON `alerts` (`device_id`,`status`);