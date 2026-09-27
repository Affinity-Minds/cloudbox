// Owner: WT-17. Stateful alerts (spec §25/§44): evaluated on a cron
// (apps/worker-api/src/alerts/evaluate.ts), read by the Super Admin console
// (`GET /api/v1/screens/alerts`) and the tenant portal (`GET /api/v1/me/alerts`).
import { z } from "zod";

/** Matches `ALERT_CATEGORIES` in db/schema.ts exactly (migration 0015). */
export const ALERT_CATEGORIES = [
  "device_offline",
  "license_expiring",
  "license_expired",
  "no_active_plan",
  "clock_tamper",
  "device_binding_failure",
  "backup_failed",
  "backup_overdue",
  "disk_low",
  "agent_outdated",
  "update_failed",
  "reboot_required",
  "private_network_failed",
  "rdp_unhealthy",
  "break_glass_active",
] as const;
export const AlertCategory = z.enum(ALERT_CATEGORIES);
export type AlertCategory = z.infer<typeof AlertCategory>;

export const ALERT_SEVERITIES = ["info", "warning", "critical"] as const;
export const AlertSeverity = z.enum(ALERT_SEVERITIES);
export type AlertSeverity = z.infer<typeof AlertSeverity>;

export const ALERT_STATUSES = ["open", "acknowledged", "resolved"] as const;
export const AlertStatus = z.enum(ALERT_STATUSES);
export type AlertStatus = z.infer<typeof AlertStatus>;

/** One alert record, joined with the tenant/device names the UI renders (never re-fetched). */
export const Alert = z.object({
  id: z.string(),
  tenantId: z.string().nullable(),
  tenantCode: z.string().nullable(),
  tenantName: z.string().nullable(),
  deviceId: z.string().nullable(),
  deviceName: z.string().nullable(),
  category: AlertCategory,
  severity: AlertSeverity,
  status: AlertStatus,
  dedupeKey: z.string(),
  openedAt: z.string(),
  /** Free-form evidence captured at the last evaluation (e.g. `{state: "degraded"}`). */
  lastEvidence: z.unknown().nullable(),
  lastSeenAt: z.string().nullable(),
  acknowledgedBy: z.string().nullable(),
  acknowledgedAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  notifiedAt: z.string().nullable(),
});
export type Alert = z.infer<typeof Alert>;

/** `GET /api/v1/screens/alerts?status=&severity=&tenant=` (staff, `device.view`). */
export const AlertsScreen = z.object({
  items: z.array(Alert),
  facets: z.object({
    open: z.number().int(),
    acknowledged: z.number().int(),
    critical: z.number().int(),
    warning: z.number().int(),
  }),
});
export type AlertsScreen = z.infer<typeof AlertsScreen>;

/** `GET /api/v1/me/alerts` (customer session, membership-scoped). */
export const MeAlertsResponse = z.object({ items: z.array(Alert) });
export type MeAlertsResponse = z.infer<typeof MeAlertsResponse>;

/** `GET`/`PATCH /api/v1/settings/alerts` (`settings.manage`): the staff distribution list. */
export const AlertsSettings = z.object({ staffRecipients: z.array(z.string()) });
export type AlertsSettings = z.infer<typeof AlertsSettings>;

export const UpdateAlertsSettingsRequest = z.object({
  staffRecipients: z.array(z.email()).max(50),
});
export type UpdateAlertsSettingsRequest = z.infer<typeof UpdateAlertsSettingsRequest>;

/** Human label for a category, shared by the console table and alert emails. */
export const ALERT_CATEGORY_LABEL: Record<AlertCategory, string> = {
  device_offline: "Device offline",
  license_expiring: "License expiring",
  license_expired: "License expired",
  no_active_plan: "No active plan",
  clock_tamper: "Clock tamper",
  device_binding_failure: "Device binding failure",
  backup_failed: "Backup failed",
  backup_overdue: "Backup overdue",
  disk_low: "Disk low",
  agent_outdated: "Agent outdated",
  update_failed: "Update failed",
  reboot_required: "Reboot required",
  private_network_failed: "Private network failed",
  rdp_unhealthy: "RDP unhealthy",
  break_glass_active: "Break-glass active",
};
