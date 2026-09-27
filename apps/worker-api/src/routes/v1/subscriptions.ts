// Owner: WT-5 (plans/subscriptions/entitlement screens), plan lifecycle owner: WT-13.
// Module `subscriptions`: three routers because its paths span three prefixes.
// GET|POST /plans, PATCH|POST retire|reactivate /plans/:code, GET|POST /tenants/:tenantId/subscriptions,
// PATCH /subscriptions/:id. Screens live in routes/v1/screens/{subscriptions,plans}.ts.
// Prefixes nest: middleware per route only.
import {
  CreatePlanRequest,
  CreateSubscriptionRequest,
  type Feature,
  type Plan,
  type Subscription,
  UpdatePlanRequest,
  UpdateSubscriptionRequest,
} from "@cloudbox/contracts";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { type ZodType, z } from "zod";
import { audit } from "../../audit";
import { forbidden, getStaffPrincipal } from "../../auth/middleware";
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
          detail: result.error.issues.map((issue) => ({
            path: issue.path,
            message: issue.message,
          })),
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
  description: row.description ?? null,
  maxDevices: row.maxDevices,
  maxManagedUsers: row.maxManagedUsers,
  features: JSON.parse(row.featuresJson) as Feature[],
  offlineGraceDays: row.offlineGraceDays,
  renewalWarningDays: row.renewalWarningDays,
  status: row.status as Plan["status"],
  termDays: row.termDays,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
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

/** A PATCH result is valid when dated in order, or `pending` with no dates (WT-14). */
const datesValid = (row: {
  status: string;
  validFrom: string | null;
  validUntil: string | null;
}) =>
  row.validFrom !== null && row.validUntil !== null
    ? isoOrder(row.validFrom, row.validUntil)
    : row.status === "pending" && row.validFrom === null && row.validUntil === null;

// ─── /api/v1/plans ────────────────────────────────────────────────────────────────────────────

export const plans = new Hono<AppEnv>();

const PlansQuery = z.object({ include: z.enum(["retired"]).optional() });

// GET /: active plans only, subscription.view (unchanged). ?include=retired additionally lists
// retired plans, and needs subscription.manage — a plan designer decision, not just a viewer one.
plans.get("/", requirePermission("subscription.view"), validate("query", PlansQuery), async (c) => {
  const { include } = c.req.valid("query");
  const db = createDb(c.env.DB);
  if (include === "retired") {
    const principal = await getStaffPrincipal(c);
    if (!principal?.permissions.has("subscription.manage")) return forbidden(c);
    const rows = await db.select().from(plansTable).orderBy(plansTable.code);
    return c.json({ items: rows.map(toPlan) });
  }
  const rows = await db
    .select()
    .from(plansTable)
    .where(eq(plansTable.status, "active"))
    .orderBy(plansTable.code);
  return c.json({ items: rows.map(toPlan) });
});

plans.post(
  "/",
  requirePermission("subscription.manage"),
  validate("json", CreatePlanRequest),
  async (c) => {
    const input = c.req.valid("json");
    const db = createDb(c.env.DB);

    const [existing] = await db
      .select({ code: plansTable.code })
      .from(plansTable)
      .where(eq(plansTable.code, input.code));
    if (existing) return c.json({ error: "conflict", detail: "code already in use" }, 409);

    const now = nowIso();
    const row: PlanRow = {
      code: input.code,
      name: input.name,
      description: input.description ?? null,
      maxDevices: input.maxDevices,
      maxManagedUsers: input.maxManagedUsers,
      featuresJson: JSON.stringify(input.features),
      offlineGraceDays: input.offlineGraceDays,
      renewalWarningDays: input.renewalWarningDays,
      status: "active",
      termDays: input.termDays,
      createdAt: now,
      updatedAt: now,
    };
    const created = toPlan(row);

    await db.batch([
      db.insert(plansTable).values(row),
      audit(db, {
        eventType: "PLAN_CREATED",
        entityType: "plan",
        entityId: row.code,
        actor: { type: "user", id: c.var.user.id },
        before: null,
        after: created,
        correlationId: c.var.correlationId,
        source: "api",
      }),
    ]);
    return c.json({ plan: created }, 201);
  },
);

plans.patch(
  "/:code",
  requirePermission("subscription.manage"),
  validate("json", UpdatePlanRequest),
  async (c) => {
    const code = c.req.param("code");
    const input = c.req.valid("json");
    const db = createDb(c.env.DB);

    const [current] = await db.select().from(plansTable).where(eq(plansTable.code, code));
    if (!current) return c.json({ error: "not_found" }, 404);

    const now = nowIso();
    const next: PlanRow = {
      ...current,
      name: input.name ?? current.name,
      description: input.description !== undefined ? input.description : current.description,
      maxDevices: input.maxDevices ?? current.maxDevices,
      maxManagedUsers: input.maxManagedUsers ?? current.maxManagedUsers,
      featuresJson: input.features ? JSON.stringify(input.features) : current.featuresJson,
      offlineGraceDays: input.offlineGraceDays ?? current.offlineGraceDays,
      renewalWarningDays: input.renewalWarningDays ?? current.renewalWarningDays,
      termDays: input.termDays ?? current.termDays,
      updatedAt: now,
    };

    const before = toPlan(current);
    const after = toPlan(next);
    await db.batch([
      db
        .update(plansTable)
        .set({
          name: next.name,
          description: next.description,
          maxDevices: next.maxDevices,
          maxManagedUsers: next.maxManagedUsers,
          featuresJson: next.featuresJson,
          offlineGraceDays: next.offlineGraceDays,
          renewalWarningDays: next.renewalWarningDays,
          termDays: next.termDays,
          updatedAt: next.updatedAt,
        })
        .where(eq(plansTable.code, code)),
      audit(db, {
        eventType: "PLAN_UPDATED",
        entityType: "plan",
        entityId: code,
        actor: { type: "user", id: c.var.user.id },
        before,
        after,
        correlationId: c.var.correlationId,
        source: "api",
      }),
    ]);
    return c.json({ plan: after });
  },
);

async function setPlanStatus(
  c: Context<AppEnv>,
  code: string,
  target: "active" | "retired",
  eventType: "PLAN_RETIRED" | "PLAN_REACTIVATED",
) {
  const db = createDb(c.env.DB);
  const [current] = await db.select().from(plansTable).where(eq(plansTable.code, code));
  if (!current) return c.json({ error: "not_found" }, 404);
  if (current.status === target) {
    return c.json({ error: target === "retired" ? "already_retired" : "already_active" }, 409);
  }

  const [countRow] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.planCode, code));
  const subscriptionCount = countRow?.n ?? 0;

  const now = nowIso();
  const next: PlanRow = { ...current, status: target, updatedAt: now };
  const before = toPlan(current);
  const after = toPlan(next);

  await db.batch([
    db.update(plansTable).set({ status: target, updatedAt: now }).where(eq(plansTable.code, code)),
    audit(db, {
      eventType,
      entityType: "plan",
      entityId: code,
      actor: { type: "user", id: c.var.user.id },
      before,
      after,
      correlationId: c.var.correlationId,
      source: "api",
    }),
  ]);
  return c.json({ plan: after, subscriptionCount });
}

plans.post("/:code/retire", requirePermission("subscription.manage"), (c) =>
  setPlanStatus(c, c.req.param("code"), "retired", "PLAN_RETIRED"),
);

plans.post("/:code/reactivate", requirePermission("subscription.manage"), (c) =>
  setPlanStatus(c, c.req.param("code"), "active", "PLAN_REACTIVATED"),
);

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
          and(
            eq(subscriptionsTable.tenantId, tenantId),
            ne(subscriptionsTable.status, "cancelled"),
          ),
        )
        .limit(1),
    ]);
    const tenant = tenantRows[0];
    if (!tenant) return c.json({ error: "not_found" }, 404);
    if (tenant.status === "archived") return c.json({ error: "tenant_archived" }, 409);
    const plan = planRows[0];
    if (!plan) return c.json({ error: "invalid_request", detail: "unknown_plan" }, 400);
    // A retired plan cannot be chosen for a new subscription; an existing subscription on a plan
    // that gets retired later keeps working (nothing here touches existing subscriptions).
    if (plan.status === "retired") return c.json({ error: "plan_retired" }, 409);
    // No dates: a plan assignment, `pending` until the tenant's first server activates (WT-14,
    // ADR 0011). Both dates: the staff override, which starts immediately (the original behaviour).
    const dated = body.validFrom !== undefined && body.validUntil !== undefined;
    if (dated && !isoOrder(body.validFrom as string, body.validUntil as string)) {
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
      status: dated ? (body.status ?? "active") : "pending",
      validFrom: dated ? new Date(body.validFrom as string).toISOString() : null,
      validUntil: dated ? new Date(body.validUntil as string).toISOString() : null,
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
    if (!datesValid(next)) {
      return c.json(
        {
          error: "invalid_request",
          detail:
            next.validFrom === null || next.validUntil === null
              ? "dates_required"
              : "valid_until_not_after_valid_from",
        },
        400,
      );
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
