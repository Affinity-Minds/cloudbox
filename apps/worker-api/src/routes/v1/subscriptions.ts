// Owner: WT-5. Module `subscriptions`: three routers because its paths span three prefixes.
// GET /plans, GET|POST /tenants/:tenantId/subscriptions, PATCH /subscriptions/:id.
// Screens live in routes/v1/screens/subscriptions.ts. Prefixes nest: middleware per route only.
import {
  CreateSubscriptionRequest,
  type Feature,
  type Plan,
  type Subscription,
  UpdateSubscriptionRequest,
} from "@cloudbox/contracts";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, ne } from "drizzle-orm";
import { Hono } from "hono";
import type { ZodType } from "zod";
import { audit } from "../../audit";
import { requirePermission } from "../../authz/permissions";
import { createDb } from "../../db/client";
import { plans as plansTable, subscriptions as subscriptionsTable, tenants } from "../../db/schema";
import type { AppEnv } from "../../env";
import { newId, nowIso } from "../../ids";

/** `@hono/zod-validator` with the shared error shape. */
export const validate = <T extends ZodType>(target: "json" | "query", schema: T) =>
  zValidator(target, schema, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: "invalid_request",
          detail: result.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
        },
        400,
      );
    }
  });

type PlanRow = typeof plansTable.$inferSelect;
type SubscriptionRow = typeof subscriptionsTable.$inferSelect;

export const toPlan = (row: PlanRow): Plan => ({
  code: row.code,
  name: row.name,
  maxDevices: row.maxDevices,
  maxManagedUsers: row.maxManagedUsers,
  features: JSON.parse(row.featuresJson) as Feature[],
  offlineGraceDays: row.offlineGraceDays,
  renewalWarningDays: row.renewalWarningDays,
});

export const toSubscription = (row: SubscriptionRow): Subscription => ({
  id: row.id,
  tenantId: row.tenantId,
  planCode: row.planCode,
  status: row.status,
  validFrom: row.validFrom,
  validUntil: row.validUntil,
  maxManagedUsers: row.maxManagedUsers,
  features: JSON.parse(row.featuresJson) as Feature[],
  offlineGraceDays: row.offlineGraceDays,
  renewalWarningDays: row.renewalWarningDays,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const isoOrder = (from: string, until: string) => Date.parse(from) < Date.parse(until);

// ─── /api/v1/plans ────────────────────────────────────────────────────────────────────────────

export const plans = new Hono<AppEnv>();

plans.get("/", requirePermission("subscription.view"), async (c) => {
  const rows = await createDb(c.env.DB).select().from(plansTable).orderBy(plansTable.code);
  return c.json({ items: rows.map(toPlan) });
});

// ─── /api/v1/tenants/:tenantId/subscriptions ─────────────────────────────────────────────────

export const tenantSubscriptions = new Hono<AppEnv>();

tenantSubscriptions.get("/", requirePermission("subscription.view"), async (c) => {
  const tenantId = c.req.param("tenantId") ?? "";
  const db = createDb(c.env.DB);
  const [tenantRows, rows] = await db.batch([
    db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)),
    db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.tenantId, tenantId))
      .orderBy(desc(subscriptionsTable.createdAt)),
  ]);
  if (!tenantRows[0]) return c.json({ error: "not_found" }, 404);
  return c.json({ items: rows.map(toSubscription) });
});

tenantSubscriptions.post(
  "/",
  requirePermission("subscription.manage"),
  validate("json", CreateSubscriptionRequest),
  async (c) => {
    const tenantId = c.req.param("tenantId") ?? "";
    const body = c.req.valid("json");
    const db = createDb(c.env.DB);

    const [tenantRows, planRows, openRows] = await db.batch([
      db
        .select({ id: tenants.id, status: tenants.status })
        .from(tenants)
        .where(eq(tenants.id, tenantId)),
      db.select().from(plansTable).where(eq(plansTable.code, body.planCode)),
      db
        .select({ id: subscriptionsTable.id })
        .from(subscriptionsTable)
        .where(
          and(eq(subscriptionsTable.tenantId, tenantId), ne(subscriptionsTable.status, "cancelled")),
        )
        .limit(1),
    ]);
    const tenant = tenantRows[0];
    if (!tenant) return c.json({ error: "not_found" }, 404);
    if (tenant.status === "archived") return c.json({ error: "tenant_archived" }, 409);
    const plan = planRows[0];
    if (!plan) return c.json({ error: "invalid_request", detail: "unknown_plan" }, 400);
    if (!isoOrder(body.validFrom, body.validUntil)) {
      return c.json({ error: "invalid_request", detail: "valid_until_not_after_valid_from" }, 400);
    }
    // One commercial subscription per tenant at a time: renew by PATCHing dates, change plan by
    // cancelling and creating. (Concurrent creates are staff-only and rare; see handoff.)
    if (openRows[0]) {
      return c.json({ error: "subscription_exists", detail: openRows[0].id }, 409);
    }

    const now = nowIso();
    const row: SubscriptionRow = {
      id: newId("subscription"),
      tenantId,
      planCode: plan.code,
      status: body.status,
      validFrom: new Date(body.validFrom).toISOString(),
      validUntil: new Date(body.validUntil).toISOString(),
      maxManagedUsers: body.maxManagedUsers ?? plan.maxManagedUsers,
      featuresJson: JSON.stringify(body.features ?? JSON.parse(plan.featuresJson)),
      offlineGraceDays: body.offlineGraceDays ?? plan.offlineGraceDays,
      renewalWarningDays: body.renewalWarningDays ?? plan.renewalWarningDays,
      createdAt: now,
      updatedAt: now,
    };
    const subscription = toSubscription(row);

    await db.batch([
      db.insert(subscriptionsTable).values(row),
      audit(db, {
        eventType: "SUBSCRIPTION_CHANGED",
        action: "created",
        entityType: "subscription",
        entityId: row.id,
        actor: { type: "user", id: c.var.user.id },
        before: null,
        after: subscription,
        correlationId: c.var.correlationId,
        source: "api",
      }),
    ]);
    return c.json({ subscription }, 201);
  },
);

// ─── /api/v1/subscriptions/:id ────────────────────────────────────────────────────────────────

const subscriptions = new Hono<AppEnv>();

subscriptions.patch(
  "/:id",
  requirePermission("subscription.manage"),
  validate("json", UpdateSubscriptionRequest),
  async (c) => {
    const id = c.req.param("id");
    const body = c.req.valid("json");
    const db = createDb(c.env.DB);

    const [current] = await db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.id, id));
    if (!current) return c.json({ error: "not_found" }, 404);
    // Cancelled is terminal: a new subscription is a new commercial agreement.
    if (current.status === "cancelled") return c.json({ error: "subscription_cancelled" }, 409);

    const next: SubscriptionRow = {
      ...current,
      status: body.status ?? current.status,
      validFrom: body.validFrom ? new Date(body.validFrom).toISOString() : current.validFrom,
      validUntil: body.validUntil ? new Date(body.validUntil).toISOString() : current.validUntil,
      maxManagedUsers: body.maxManagedUsers ?? current.maxManagedUsers,
      featuresJson: body.features ? JSON.stringify(body.features) : current.featuresJson,
      offlineGraceDays: body.offlineGraceDays ?? current.offlineGraceDays,
      renewalWarningDays: body.renewalWarningDays ?? current.renewalWarningDays,
    };
    if (!isoOrder(next.validFrom, next.validUntil)) {
      return c.json({ error: "invalid_request", detail: "valid_until_not_after_valid_from" }, 400);
    }

    const before = toSubscription(current);
    const unchanged = JSON.stringify(before) === JSON.stringify(toSubscription(next));
    if (unchanged) return c.json({ subscription: before });

    next.updatedAt = nowIso();
    const after = toSubscription(next);
    await db.batch([
      db
        .update(subscriptionsTable)
        .set({
          status: next.status,
          validFrom: next.validFrom,
          validUntil: next.validUntil,
          maxManagedUsers: next.maxManagedUsers,
          featuresJson: next.featuresJson,
          offlineGraceDays: next.offlineGraceDays,
          renewalWarningDays: next.renewalWarningDays,
          updatedAt: next.updatedAt,
        })
        .where(eq(subscriptionsTable.id, id)),
      audit(db, {
        eventType: "SUBSCRIPTION_CHANGED",
        action: next.status === "cancelled" ? "cancelled" : "updated",
        entityType: "subscription",
        entityId: id,
        actor: { type: "user", id: c.var.user.id },
        before,
        after,
        correlationId: c.var.correlationId,
        source: "api",
      }),
    ]);
    return c.json({ subscription: after });
  },
);

export default subscriptions;
