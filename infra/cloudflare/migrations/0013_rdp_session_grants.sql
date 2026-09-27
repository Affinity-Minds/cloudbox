-- 0013 RDP session credential grants (owner: WT-11; ADR 0013).
--
-- CloudBox Connect's RDP credential broker: `POST /api/v1/connect/devices/:deviceId/session` mints
-- a short-lived managed-user (`cloudNN`) password for the caller. The plaintext is returned to the
-- caller once and never stored. `password_hash` (SHA-256) identifies/audits the grant without the
-- plaintext; `password_ciphertext` is the compact JWE encrypted to the device's own RSA public key
-- at grant time (safe to store — only that device's private key can open it) and is what the
-- Agent receives as a `SET_MANAGED_USER_PASSWORD` heartbeat command.
--
-- "Lowest free managed slot" is resolved by scanning this table for the device: a slot (1..
-- effective max_managed_users) is free if it has no row here with `revoked_at IS NULL AND
-- expires_at > now`.
CREATE TABLE `rdp_session_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`managed_user` text NOT NULL,
	`slot` integer NOT NULL,
	`password_hash` text NOT NULL,
	`password_ciphertext` text NOT NULL,
	`granted_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`expires_at` text NOT NULL,
	`delivered_at` text,
	`revoked_at` text,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `rdp_session_grants_device_idx` ON `rdp_session_grants` (`device_id`,`expires_at`);
--> statement-breakpoint
CREATE INDEX `rdp_session_grants_pending_idx` ON `rdp_session_grants` (`device_id`,`delivered_at`);
