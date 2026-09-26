// Owner: WT-2. Module `tenants`, mounted at `/api/v1/tenants` in routes/v1/index.ts.
// Routes (docs/handoffs/foundation.md): POST /, PATCH /:tenantId, POST /:tenantId/archive.
// All three are staff-only (`tenant.manage`) and audited with full before/after rows.
import { CreateTenantRequest, UpdateTenantRequest } from "@cloudbox/contracts";
import { zValidator } from "@hono/zod-validator";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { audit } from "../../audit";
import { createDb, type Db } from "../../db/client";
import { devices, subscriptions, tenants } from "../../db/schema";
import type { AppEnv } from "../../env";
import { newId, nowIso } from "../../ids";
import { requirePermission } from "../../authz/permissions";

const router = new Hono<AppEnv>();

/**
 * Atomically allocates the next `CBX-00001`-style code from the `settings.tenants.next_code`
 * counter row (migration 0003 seeds it to the bare JSON scalar `'1'`) in one D1 round trip: a
 * single INSERT-or-UPDATE-RETURNING statement, so two concurrent creates can never be handed the
 * same number (agent-notes fast-data-hydration — "no read-modify-write through D1").
 */
async function allocateNextTenantCode(db: Db, now: string): Promise<string> {
  const row = await db.get<{ allocated: number }>(sql`
    insert into settings (key, value_json, updated_at)
    values ('tenants.next_code', '1', ${now})
    on conflict(key) do update set
      value_json = cast((cast(settings.value_json as integer) + 1) as text),
      updated_at = ${now}
    returning cast(value_json as integer) - 1 as allocated
  `);
  const allocated = row?.allocated ?? 1;
  return `CBX-${String(allocated).padStart(5, "0")}`;
}

/** Non-cancelled subscription statuses: still a live commercial obligation on the tenant. */
const OPEN_SUBSCRIPTION_STATUSES = ["trial", "active", "past_due", "suspended"] as const;

router.post(
  "/",
  requirePermission("tenant.manage"),
  zValidator("json", CreateTenantRequest, (result, c) => {
    if (!result.success) return c.json({ error: "invalid_request" }, 400);
  }),
  async (c) => {
    const input = c.req.valid("json");
    const db = createDb(c.env.DB);
    const now = nowIso();
    const id = newId("tenant");
    const publicCode = await allocateNextTenantCode(db, now);

    const [[created]] = await db.batch([
      db
        .insert(tenants)
        .values({
          id,
          publicCode,
          displayName: input.displayName,
          legalName: input.legalName ?? null,
          primaryContactEmail: input.primaryContactEmail ?? null,
          supportContactEmail: input.supportContactEmail ?? null,
          billingContactEmail: input.billingContactEmail ?? null,
          timezone: input.timezone ?? "UTC",
          renewalWarningDays: input.renewalWarningDays ?? 30,
          planCode: input.planCode ?? null,
          notes: input.notes ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning(),
      audit(db, {
        eventType: "TENANT_CREATED",
        entityType: "tenant",
        entityId: id,
        actor: { type: "user", id: c.var.user.id },
        before: null,
        after: { id, publicCode, ...input },
        correlationId: c.var.correlationId,
        source: "api",
      }),
    ]);

    return c.json(created, 201);
  },
);

router.patch(
  "/:tenantId",
  requirePermission("tenant.manage"),
  zValidator("json", UpdateTenantRequest, (result, c) => {
    if (!result.success) return c.json({ error: "invalid_request" }, 400);
  }),
  async (c) => {
    const tenantId = c.req.param("tenantId");
    const input = c.req.valid("json");
    const db = createDb(c.env.DB);

    const before = await db.select().from(tenants).where(eq(tenants.id, tenantId)).get();
    if (!before) return c.json({ error: "not_found" }, 404);

    const now = nowIso();
    const patch: Partial<typeof tenants.$inferInsert> = { updatedAt: now };
    if (input.displayName !== undefined) patch.displayName = input.displayName;
    if (input.legalName !== undefined) patch.legalName = input.legalName;
    if (input.primaryContactEmail !== undefined) patch.primaryContactEmail = input.primaryContactEmail;
    if (input.supportContactEmail !== undefined) patch.supportContactEmail = input.supportContactEmail;
    if (input.billingContactEmail !== undefined) patch.billingContactEmail = input.billingContactEmail;
    if (input.timezone !== undefined) patch.timezone = input.timezone;
    if (input.renewalWarningDays !== undefined) patch.renewalWarningDays = input.renewalWarningDays;
    if (input.planCode !== undefined) patch.planCode = input.planCode;
    if (input.notes !== undefined) patch.notes = input.notes;
    if (input.status !== undefined) patch.status = input.status;

    const [[updated]] = await db.batch([
      db.update(tenants).set(patch).where(eq(tenants.id, tenantId)).returning(),
      audit(db, {
        eventType: "TENANT_UPDATED",
        entityType: "tenant",
        entityId: tenantId,
        actor: { type: "user", id: c.var.user.id },
        before,
        after: { ...before, ...patch },
        correlationId: c.var.correlationId,
        source: "api",
      }),
    ]);

    return c.json(updated);
  },
);

router.post("/:tenantId/archive", requirePermission("tenant.manage"), async (c) => {
  const tenantId = c.req.param("tenantId");
  const db = createDb(c.env.DB);

  const [tenantRows, deviceRows, subscriptionRows] = await db.batch([
    db.select().from(tenants).where(eq(tenants.id, tenantId)),
    db
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(devices)
      .where(sql`${devices.tenantId} = ${tenantId} and ${devices.status} = 'enrolled'`),
    db
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(subscriptions)
      .where(
        sql`${subscriptions.tenantId} = ${tenantId} and ${subscriptions.status} in ${OPEN_SUBSCRIPTION_STATUSES}`,
      ),
  ]);

  const before = tenantRows[0];
  if (!before) return c.json({ error: "not_found" }, 404);
  if (before.status === "archived") {
    return c.json({ error: "conflict", detail: "Tenant is already archived." }, 409);
  }

  const enrolledDevices = deviceRows[0]?.n ?? 0;
  const openSubscriptions = subscriptionRows[0]?.n ?? 0;
  if (enrolledDevices > 0) {
    return c.json(
      {
        error: "conflict",
        detail: `Cannot archive: ${enrolledDevices} device${enrolledDevices === 1 ? "" : "s"} still enrolled. Revoke every device first.`,
      },
      409,
    );
  }
  if (openSubscriptions > 0) {
    return c.json(
      {
        error: "conflict",
        detail: `Cannot archive: an active subscription exists. Cancel the subscription first.`,
      },
      409,
    );
  }

  const now = nowIso();
  const [[archived]] = await db.batch([
    db
      .update(tenants)
      .set({ status: "archived", archivedAt: now, updatedAt: now })
      .where(eq(tenants.id, tenantId))
      .returning(),
    audit(db, {
      eventType: "TENANT_ARCHIVED",
      entityType: "tenant",
      entityId: tenantId,
      actor: { type: "user", id: c.var.user.id },
      before,
      after: { ...before, status: "archived", archivedAt: now, updatedAt: now },
      correlationId: c.var.correlationId,
      source: "api",
    }),
  ]);

  return c.json(archived);
});

export default router;
