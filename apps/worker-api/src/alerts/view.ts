// Owner: WT-17. Shapes a raw `alerts` row (plus the tenant/device names joined alongside it) into
// the `@cloudbox/contracts` `Alert` the console, portal and acknowledge/resolve responses share.
import type { Alert, AlertCategory, AlertSeverity, AlertStatus } from "@cloudbox/contracts";

export type AlertRow = {
  id: string;
  tenantId: string | null;
  deviceId: string | null;
  category: string;
  severity: string;
  status: string;
  dedupeKey: string;
  openedAt: string;
  lastEvidenceJson: string | null;
  lastSeenAt: string | null;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  notifiedAt: string | null;
  tenantCode?: string | null;
  tenantName?: string | null;
  deviceName?: string | null;
};

export function toAlert(row: AlertRow): Alert {
  return {
    id: row.id,
    tenantId: row.tenantId,
    tenantCode: row.tenantCode ?? null,
    tenantName: row.tenantName ?? null,
    deviceId: row.deviceId,
    deviceName: row.deviceName ?? null,
    category: row.category as AlertCategory,
    severity: row.severity as AlertSeverity,
    status: row.status as AlertStatus,
    dedupeKey: row.dedupeKey,
    openedAt: row.openedAt,
    lastEvidence: row.lastEvidenceJson ? JSON.parse(row.lastEvidenceJson) : null,
    lastSeenAt: row.lastSeenAt,
    acknowledgedBy: row.acknowledgedBy,
    acknowledgedAt: row.acknowledgedAt,
    resolvedAt: row.resolvedAt,
    notifiedAt: row.notifiedAt,
  };
}
