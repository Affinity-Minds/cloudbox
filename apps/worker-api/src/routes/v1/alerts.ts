// Owner: WT-17. Module `alerts`, mounted at `/api/v1/alerts` in routes/v1/index.ts, plus the
// `alertsSettings` router mounted at `/api/v1/settings/alerts` (Settings → "Alerts").
// Routes: POST /:id/acknowledge, POST /:id/resolve (both `device.manage`, matching the read gate
// `device.view` used by the screen loader — audit-view-level read, per the brief);
// GET/PATCH /settings/alerts (`settings.manage`).
import { type AlertsSettings, UpdateAlertsSettingsRequest } from "@cloudbox/contracts";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { getStaffRecipients, setStaffRecipients } from "../../alerts/settings";
import { toAlert } from "../../alerts/view";
import { audit } from "../../audit";
import { requirePermission } from "../../authz/permissions";
import { createDb } from "../../db/client";
import { alerts } from "../../db/schema";
import type { AppEnv } from "../../env";
import { nowIso } from "../../ids";

const alertsRoute = new Hono<AppEnv>();

async function findAlert(db: ReturnType<typeof createDb>, id: string) {
  const [row] = await db.select().from(alerts).where(eq(alerts.id, id)).limit(1);
  return row ?? null;
}

alertsRoute.post("/:id/acknowledge", requirePermission("device.manage"), async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param("id");
  const row = await findAlert(db, id);
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.status === "resolved") {
    return c.json({ error: "conflict", detail: "already_resolved" }, 409);
  }
  if (row.status === "acknowledged") return c.json(toAlert(row));

  const now = nowIso();
  await db
    .update(alerts)
    .set({ status: "acknowledged", acknowledgedBy: c.var.user.id, acknowledgedAt: now })
    .where(eq(alerts.id, id));
  await audit(db, {
    eventType: "ALERT_ACKNOWLEDGED",
    entityType: "alert",
    entityId: id,
    actor: { type: "user", id: c.var.user.id, tenantId: row.tenantId },
    before: { status: row.status },
    after: { status: "acknowledged" },
    correlationId: c.var.correlationId,
    source: "api",
  });
  return c.json(
    toAlert({ ...row, status: "acknowledged", acknowledgedBy: c.var.user.id, acknowledgedAt: now }),
  );
});

alertsRoute.post("/:id/resolve", requirePermission("device.manage"), async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param("id");
  const row = await findAlert(db, id);
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.status === "resolved") {
    return c.json({ error: "conflict", detail: "already_resolved" }, 409);
  }

  const now = nowIso();
  await db.update(alerts).set({ status: "resolved", resolvedAt: now }).where(eq(alerts.id, id));
  await audit(db, {
    eventType: "ALERT_RESOLVED",
    entityType: "alert",
    entityId: id,
    actor: { type: "user", id: c.var.user.id, tenantId: row.tenantId },
    before: { status: row.status },
    after: { status: "resolved" },
    correlationId: c.var.correlationId,
    source: "api",
  });
  return c.json(toAlert({ ...row, status: "resolved", resolvedAt: now }));
});

export default alertsRoute;

export const alertsSettings = new Hono<AppEnv>();

alertsSettings.get("/", requirePermission("settings.manage"), async (c) => {
  const db = createDb(c.env.DB);
  const staffRecipients = await getStaffRecipients(db);
  return c.json({ staffRecipients } satisfies AlertsSettings);
});

alertsSettings.patch(
  "/",
  requirePermission("settings.manage"),
  zValidator("json", UpdateAlertsSettingsRequest, (result, c) => {
    if (!result.success) return c.json({ error: "invalid_request" }, 400);
  }),
  async (c) => {
    const db = createDb(c.env.DB);
    const before = await getStaffRecipients(db);
    const { staffRecipients } = c.req.valid("json");
    await setStaffRecipients(db, staffRecipients);
    await audit(db, {
      eventType: "ALERTS_SETTINGS_UPDATED",
      entityType: "settings",
      entityId: "alerts.staff_recipients",
      actor: { type: "user", id: c.var.user.id },
      before,
      after: staffRecipients,
      correlationId: c.var.correlationId,
      source: "api",
    });
    return c.json({ staffRecipients } satisfies AlertsSettings);
  },
);
