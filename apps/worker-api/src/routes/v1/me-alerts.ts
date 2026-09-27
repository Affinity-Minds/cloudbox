// Owner: WT-17. Module `meAlerts`, mounted at `/api/v1/me` in routes/v1/index.ts alongside WT-2's
// own `me` router (Hono's `.route()` just appends routes at a prefix — see hono-base.js — so a
// second small router at the same mount is fine and does not touch WT-2's file).
// Route: GET /me/alerts — the signed-in customer's own tenant(s)' currently active alerts
// (open/acknowledged; resolved history is a console-only concern for now).

import type { MeAlertsResponse } from "@cloudbox/contracts";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { Hono } from "hono";
import { toAlert } from "../../alerts/view";
import { requireUser } from "../../auth/middleware";
import { createDb } from "../../db/client";
import { alerts, devices, tenantMemberships, tenants } from "../../db/schema";
import type { AppEnv } from "../../env";

const meAlerts = new Hono<AppEnv>();

meAlerts.get("/alerts", requireUser(), async (c) => {
  const db = createDb(c.env.DB);
  const memberships = await db
    .select({ tenantId: tenantMemberships.tenantId })
    .from(tenantMemberships)
    .where(
      and(eq(tenantMemberships.userId, c.var.user.id), eq(tenantMemberships.status, "active")),
    );
  const tenantIds = memberships.map((m) => m.tenantId);
  if (tenantIds.length === 0) return c.json({ items: [] } satisfies MeAlertsResponse);

  const rows = await db
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
    .innerJoin(tenants, eq(tenants.id, alerts.tenantId))
    .leftJoin(devices, eq(devices.id, alerts.deviceId))
    .where(and(inArray(alerts.tenantId, tenantIds), ne(alerts.status, "resolved")))
    .orderBy(desc(alerts.openedAt))
    .limit(200);

  return c.json({ items: rows.map(toAlert) } satisfies MeAlertsResponse);
});

export default meAlerts;
