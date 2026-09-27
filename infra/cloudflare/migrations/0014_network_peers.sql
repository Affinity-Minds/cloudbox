CREATE TABLE `network_peers` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`tenant_id` text NOT NULL,
	`device_id` text,
	`user_id` text,
	`netbird_peer_id` text,
	`netbird_setup_key_id` text,
	`group_ids_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'not_configured' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `customer_users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "network_peers_kind_check" CHECK("network_peers"."kind" IN ('server', 'client', 'support')),
	CONSTRAINT "network_peers_status_check" CHECK("network_peers"."status" IN ('not_configured', 'pending', 'active', 'revoked'))
);
--> statement-breakpoint
CREATE INDEX `network_peers_tenant_kind_idx` ON `network_peers` (`tenant_id`,`kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `network_peers_device_uq` ON `network_peers` (`device_id`) WHERE "network_peers"."device_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `network_peers_client_uq` ON `network_peers` (`tenant_id`,`user_id`) WHERE "network_peers"."kind" = 'client';--> statement-breakpoint
CREATE UNIQUE INDEX `network_peers_support_uq` ON `network_peers` (`tenant_id`) WHERE "network_peers"."kind" = 'support';