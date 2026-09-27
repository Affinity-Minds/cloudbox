// Owner: WT-17. GET /api/v1/screens/alerts?status=&severity=&tenant= — the operational "what is
// broken now" table (spec §44). Staff only; gated `device.view` per the brief ("audit.view-level
// read: use device.view"). One D1 round trip (fast-data-hydration): the filtered list and the
// unfiltered facet counts are a single `db.batch`.

import type { AlertsScreen } from "@cloudbox/contracts";
import { count, desc, eq, and as sqlAnd } from "drizzle-orm";
import { Hono } from "hono";
import { toAlert } from "../../../alerts/view";
import { requirePermission } from "../../../authz/permissions";
import { createDb, type Db } from "../../../db/client";
import { alerts, devices, tenants } from "../../../db/schema";
import type { AppEnv } from "../../../env";

export type AlertsFilters = { status?: string; severity?: string; tenant?: string };

export async function loadAlerts(db: Db, filters: AlertsFilters): Promise<AlertsScreen> {
  const conditions = [
    filters.status ? eq(alerts.status, filters.status as never) : undefined,
    filters.severity ? eq(alerts.severity, filters.severity as never) : undefined,
    filters.tenant ? eq(alerts.tenantId, filters.tenant) : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);

  const [items, facetRows] = await db.batch([
    db
      .select({
        id: alerts.id,
        tenantId: alerts.tenantId,
        deviceId: alerts.deviceId,
        category: alerts.category,
        severity: alerts.severity,
        status: alerts.status,
        dedupeKey: alerts.dedupeKey,
        openedAt: alerts.openedAt,
        lastEvidenceJson: alerts.lastEvidenceJson,
        lastSeenAt: alerts.lastSeenAt,
        acknowledgedBy: alerts.acknowledgedBy,
        acknowledgedAt: alerts.acknowledgedAt,
        resolvedAt: alerts.resolvedAt,
        notifiedAt: alerts.notifiedAt,
        tenantCode: tenants.publicCode,
        tenantName: tenants.displayName,
        deviceName: devices.name,
      })
      .from(alerts)
      .leftJoin(tenants, eq(tenants.id, alerts.tenantId))
      .leftJoin(devices, eq(devices.id, alerts.deviceId))
      .where(conditions.length > 0 ? sqlAnd(...conditions) : undefined)
      .orderBy(desc(alerts.openedAt))
      .limit(500),
    db
      .select({ status: alerts.status, severity: alerts.severity, n: count() })
      .from(alerts)
      .groupBy(alerts.status, alerts.severity),
  ]);

  const facets = { open: 0, acknowledged: 0, critical: 0, warning: 0 };
  for (const row of facetRows) {
    if (row.status === "open") facets.open += row.n;
    if (row.status === "acknowledged") facets.acknowledged += row.n;
    if (row.status !== "resolved") {
      if (row.severity === "critical") facets.critical += row.n;
      if (row.severity === "warning") facets.warning += row.n;
    }
  }

  // Newest-open-first within the ordering above: sort in JS (cheap, ≤500 rows) since "open before
  // acknowledged before resolved" isn't the table's natural text ordering.
  const statusRank: Record<string, number> = { open: 0, acknowledged: 1, resolved: 2 };
  const severityRank: Record<string, number> = { critical: 0, warning: 1, info: 2 };
  const sorted = [...items].sort((a, b) => {
    const byStatus = (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9);
    if (byStatus !== 0) return byStatus;
    const bySeverity = (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9);
    if (bySeverity !== 0) return bySeverity;
    return b.openedAt.localeCompare(a.openedAt);
  });

  return { items: sorted.map(toAlert), facets };
}

const alertsScreen = new Hono<AppEnv>();

alertsScreen.get("/", requirePermission("device.view"), async (c) => {
  const result = await loadAlerts(createDb(c.env.DB), {
    status: c.req.query("status"),
    severity: c.req.query("severity"),
    tenant: c.req.query("tenant"),
  });
  return c.json(result);
});

export default alertsScreen;
