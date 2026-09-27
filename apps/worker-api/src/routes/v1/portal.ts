// Owner: WT-15. Module `portal`, mounted at `/api/v1/tenants/:tenantId/portal` in routes/v1/index.ts.
// The customer portal's read-only screens: Home, CloudBoxes (devices), Members, Subscription.
// Every route is gated by the real fixed gate `requireTenantStanding('user')` — any active member
// (owner, admin or user) of `:tenantId` may read these; mutations stay on their owners' existing
// routes (`memberships.ts` for invite/standing/revoke, `self-service.ts` for activation grants),
// which already enforce ranking and Owner/Admin checks themselves.
//
// Nothing here duplicates another worktree's query logic: devices reuse WT-3's `loadFleet` directly
// (scoped to exactly this one tenant, regardless of what the caller could otherwise see), and the
// plan line reuses WT-14's `tenantPlanQuery`/`toTenantPlan`.
import {
  type Currency,
  effectiveMaxManagedUsers,
  type PortalHome,
  type PortalMembersScreen,
  type PortalSubscriptionScreen,
  totalPriceAmount,
} from "@cloudbox/contracts";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import { requireTenantStanding } from "../../authz/permissions";
import { createDb } from "../../db/client";
import {
  customerUsers,
  devices,
  plans,
  subscriptions,
  tenantMemberships,
  tenants,
} from "../../db/schema";
import { subscriptionLifecycle } from "../../entitlement/status";
import type { AppEnv } from "../../env";
import { tenantPlanQuery, toTenantPlan } from "../../onboarding/plan";
import { loadFleet } from "./screens/fleet";
import { toSubscription } from "./subscriptions";

// biome-ignore lint/complexity/noBannedTypes: Hono's Schema generic default, not our shape.
const router = new Hono<AppEnv, {}, "/tenants/:tenantId/portal">();

router.get("/", requireTenantStanding("user"), async (c) => {
  const tenantId = c.req.param("tenantId");
  const db = createDb(c.env.DB);

  const [tenantRows, planRows, memberCountRows, deviceCountRows] = await db.batch([
    db
      .select({
        id: tenants.id,
        publicCode: tenants.publicCode,
        displayName: tenants.displayName,
        status: tenants.status,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId)),
    tenantPlanQuery(db, [tenantId]),
    db
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(tenantMemberships)
      .where(and(eq(tenantMemberships.tenantId, tenantId), eq(tenantMemberships.status, "active"))),
    db
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(devices)
      .where(and(eq(devices.tenantId, tenantId), eq(devices.status, "enrolled"))),
  ]);

  const tenant = tenantRows[0];
  if (!tenant) return c.json({ error: "not_found" }, 404);

  // requireTenantStanding already asserted the caller's standing is >= 'user'; read it back for the
  // response (the UI needs the exact value, not just "at least user").
  const [membership] = await db
    .select({ standing: tenantMemberships.standing })
    .from(tenantMemberships)
    .where(
      and(
        eq(tenantMemberships.tenantId, tenantId),
        eq(tenantMemberships.userId, c.var.user.id),
        eq(tenantMemberships.status, "active"),
      ),
    );

  const body: PortalHome = {
    tenant,
    standing: membership?.standing ?? "user",
    plan: toTenantPlan(planRows[0]),
    counts: {
      members: memberCountRows[0]?.n ?? 0,
      devices: deviceCountRows[0]?.n ?? 0,
    },
  };
  return c.json(body);
});

router.get("/members", requireTenantStanding("user"), async (c) => {
  const tenantId = c.req.param("tenantId");
  const db = createDb(c.env.DB);

  const [rows, [membership]] = await db.batch([
    db
      .select({
        id: tenantMemberships.id,
        userId: tenantMemberships.userId,
        email: customerUsers.email,
        name: customerUsers.name,
        standing: tenantMemberships.standing,
        status: tenantMemberships.status,
        createdAt: tenantMemberships.createdAt,
      })
      .from(tenantMemberships)
      .innerJoin(customerUsers, eq(customerUsers.id, tenantMemberships.userId))
      .where(and(eq(tenantMemberships.tenantId, tenantId), eq(tenantMemberships.status, "active")))
      .orderBy(desc(tenantMemberships.createdAt)),
    db
      .select({ standing: tenantMemberships.standing })
      .from(tenantMemberships)
      .where(
        and(
          eq(tenantMemberships.tenantId, tenantId),
          eq(tenantMemberships.userId, c.var.user.id),
          eq(tenantMemberships.status, "active"),
        ),
      ),
  ]);

  const body: PortalMembersScreen = { items: rows, standing: membership?.standing ?? "user" };
  return c.json(body);
});

router.get("/devices", requireTenantStanding("user"), async (c) => {
  const tenantId = c.req.param("tenantId");
  const db = createDb(c.env.DB);
  // Reuse WT-3's fleet loader directly, forced to exactly this tenant — never the query-string
  // `?tenant=` a staff caller could widen, since this route's only access check is the fixed
  // per-tenant gate above.
  const result = await loadFleet(db, { kind: "tenant", tenantIds: [tenantId] }, {});
  return c.json(result);
});

router.get("/subscription", requireTenantStanding("user"), async (c) => {
  const tenantId = c.req.param("tenantId");
  const db = createDb(c.env.DB);

  const [row] = await db
    .select({
      sub: subscriptions,
      planName: plans.name,
      planPriceAmount: plans.priceAmount,
      planCurrency: plans.currency,
      planAddonUserPriceAmount: plans.addonUserPriceAmount,
    })
    .from(subscriptions)
    .leftJoin(plans, eq(plans.code, subscriptions.planCode))
    .where(and(eq(subscriptions.tenantId, tenantId), ne(subscriptions.status, "cancelled")))
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);

  if (!row) {
    const body: PortalSubscriptionScreen = { subscription: null };
    return c.json(body);
  }

  const now = new Date();
  const subscription = toSubscription(row.sub);
  const body: PortalSubscriptionScreen = {
    subscription: {
      ...subscription,
      planName: row.planName ?? subscription.planCode,
      ...subscriptionLifecycle(subscription, now),
      effectiveMaxManagedUsers: effectiveMaxManagedUsers(
        subscription.maxManagedUsers,
        subscription.addonUsers,
      ),
      totalPriceAmount: totalPriceAmount(
        row.planPriceAmount ?? 0,
        row.planAddonUserPriceAmount ?? 0,
        subscription.addonUsers,
      ),
      currency: (row.planCurrency ?? "INR") as Currency,
    },
  };
  return c.json(body);
});

export default router;
