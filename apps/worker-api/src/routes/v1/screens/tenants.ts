// Owner: WT-2. GET /api/v1/screens/tenants (list + facets) and
// GET /api/v1/screens/tenants/:tenantId (detail). One `db.batch` each, so each loader is a
// single D1 round trip (fast-data-hydration "ceiling: three D1 round trips per request").
import {
  effectiveMaxManagedUsers,
  type SubscriptionWithPricing,
  type TenantDetailScreen,
  type TenantsScreen,
  TenantsScreenQuery,
  totalPriceAmount,
} from "@cloudbox/contracts";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { requirePermission } from "../../../authz/permissions";
import { createDb, type Db } from "../../../db/client";
import {
  auditLog,
  customerUsers,
  devices,
  plans,
  subscriptions,
  tenantMemberships,
  tenants,
} from "../../../db/schema";
import type { AppEnv } from "../../../env";

const PAGE_SIZE = 50;

/** Non-cancelled: the earliest of these still represents a live commercial obligation. */
const OPEN_SUBSCRIPTION_STATUSES = ["trial", "active", "past_due", "suspended"] as const;

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export async function loadTenantsScreen(db: Db, query: TenantsScreenQuery): Promise<TenantsScreen> {
  const page = query.page;
  const offset = (page - 1) * PAGE_SIZE;

  const filters = [
    query.status ? eq(tenants.status, query.status) : undefined,
    query.plan ? eq(tenants.planCode, query.plan) : undefined,
    query.q
      ? sql`(${tenants.displayName} like ${`%${query.q}%`} or ${tenants.publicCode} like ${`%${query.q}%`})`
      : undefined,
  ].filter((f): f is NonNullable<typeof f> => f !== undefined);
  const where = filters.length > 0 ? and(...filters) : undefined;

  // Raw table.column names, not interpolated Column objects: inside a correlated subquery,
  // Drizzle's `sql` tag does not reliably qualify a column from the OUTER table (`tenants.id`
  // here) with its table name, so it collides with the subquery's own same-named column and
  // silently counts against the wrong table. Verified against a real D1 (see handoff).
  const deviceCount = sql<number>`(
    select count(*) from devices where devices.tenant_id = tenants.id and devices.status = 'enrolled'
  )`.mapWith(Number);
  const memberCount = sql<number>`(
    select count(*) from tenant_memberships
    where tenant_memberships.tenant_id = tenants.id and tenant_memberships.status = 'active'
  )`.mapWith(Number);
  const nextSubscriptionExpiry = sql<string | null>`(
    select min(valid_until) from subscriptions
    where subscriptions.tenant_id = tenants.id and subscriptions.status in ${OPEN_SUBSCRIPTION_STATUSES}
  )`;

  const [items, statusFacets, planFacets, totalRows] = await db.batch([
    db
      .select({
        id: tenants.id,
        publicCode: tenants.publicCode,
        displayName: tenants.displayName,
        status: tenants.status,
        planCode: tenants.planCode,
        primaryContactEmail: tenants.primaryContactEmail,
        createdAt: tenants.createdAt,
        deviceCount,
        memberCount,
        nextSubscriptionExpiry,
      })
      .from(tenants)
      .where(where)
      .orderBy(desc(tenants.createdAt))
      .limit(PAGE_SIZE)
      .offset(offset),
    db
      .select({ value: tenants.status, count: sql<number>`count(*)`.mapWith(Number) })
      .from(tenants)
      .groupBy(tenants.status),
    db
      .select({
        value: sql<string>`coalesce(${tenants.planCode}, '')`,
        count: sql<number>`count(*)`.mapWith(Number),
      })
      .from(tenants)
      .groupBy(tenants.planCode),
    db
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(tenants)
      .where(where),
  ]);

  return {
    items: items.map((row) => ({ ...row, health: "unknown" as const })),
    total: totalRows[0]?.n ?? 0,
    page,
    pageSize: PAGE_SIZE,
    facets: {
      status: statusFacets,
      plan: planFacets.filter((f) => f.value !== ""),
    },
  };
}

export async function loadTenantDetailScreen(
  db: Db,
  tenantId: string,
): Promise<TenantDetailScreen | null> {
  const [tenantRows, membershipRows, deviceRows, subscriptionRows, auditRows] = await db.batch([
    db.select().from(tenants).where(eq(tenants.id, tenantId)),
    db
      .select({
        id: tenantMemberships.id,
        tenantId: tenantMemberships.tenantId,
        userId: tenantMemberships.userId,
        email: customerUsers.email,
        name: customerUsers.name,
        standing: tenantMemberships.standing,
        status: tenantMemberships.status,
        invitedBy: tenantMemberships.invitedBy,
        createdAt: tenantMemberships.createdAt,
      })
      .from(tenantMemberships)
      .innerJoin(customerUsers, eq(tenantMemberships.userId, customerUsers.id))
      .where(eq(tenantMemberships.tenantId, tenantId))
      .orderBy(desc(tenantMemberships.createdAt)),
    db
      .select({
        id: devices.id,
        tenantId: devices.tenantId,
        name: devices.name,
        status: devices.status,
        deviceKeyThumbprint: devices.deviceKeyThumbprint,
        keyProtection: devices.keyProtection,
        hostname: devices.hostname,
        windowsBuild: devices.windowsBuild,
        agentVersion: devices.agentVersion,
        lastSeenAt: devices.lastSeenAt,
        lastHealthJson: devices.lastHealthJson,
        enrolledAt: devices.enrolledAt,
        revokedAt: devices.revokedAt,
      })
      .from(devices)
      .where(eq(devices.tenantId, tenantId))
      .orderBy(desc(devices.enrolledAt)),
    db
      .select({
        id: subscriptions.id,
        tenantId: subscriptions.tenantId,
        planCode: subscriptions.planCode,
        status: subscriptions.status,
        validFrom: subscriptions.validFrom,
        validUntil: subscriptions.validUntil,
        maxManagedUsers: subscriptions.maxManagedUsers,
        addonUsers: subscriptions.addonUsers,
        featuresJson: subscriptions.featuresJson,
        offlineGraceDays: subscriptions.offlineGraceDays,
        renewalWarningDays: subscriptions.renewalWarningDays,
        createdAt: subscriptions.createdAt,
        updatedAt: subscriptions.updatedAt,
        // Migration 0011 (owner addition): plan pricing, to derive effectiveMaxManagedUsers and
        // totalPriceAmount below — same D1 round trip (a join on the existing query).
        planPriceAmount: plans.priceAmount,
        planCurrency: plans.currency,
        planAddonUserPriceAmount: plans.addonUserPriceAmount,
      })
      .from(subscriptions)
      .leftJoin(plans, eq(plans.code, subscriptions.planCode))
      .where(eq(subscriptions.tenantId, tenantId))
      .orderBy(desc(subscriptions.createdAt)),
    db
      .select({
        id: auditLog.id,
        eventType: auditLog.eventType,
        entityType: auditLog.entityType,
        entityId: auditLog.entityId,
        actorType: auditLog.actorType,
        actorId: auditLog.actorId,
        actorTenantId: auditLog.actorTenantId,
        action: auditLog.action,
        beforeJson: auditLog.beforeJson,
        afterJson: auditLog.afterJson,
        correlationId: auditLog.correlationId,
        source: auditLog.source,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      // Direct tenant events (entityType='tenant') plus everything scoped to it by actor context
      // (memberships, and anything else audited with `actor.tenantId` set to this tenant).
      .where(
        or(
          and(eq(auditLog.entityType, "tenant"), eq(auditLog.entityId, tenantId)),
          eq(auditLog.actorTenantId, tenantId),
        ),
      )
      .orderBy(desc(sql`${auditLog}.rowid`))
      .limit(20),
  ]);

  const tenantRow = tenantRows[0];
  if (!tenantRow) return null;
  const { maintenanceWindowJson, backupPolicyJson, ...tenant } = tenantRow;

  return {
    tenant: {
      ...tenant,
      maintenanceWindow: parseJson(maintenanceWindowJson),
      backupPolicy: parseJson(backupPolicyJson),
    },
    memberships: membershipRows,
    devices: deviceRows.map(({ lastHealthJson, ...device }) => ({
      ...device,
      lastHealth: parseJson(lastHealthJson),
    })),
    subscriptions: subscriptionRows.map(
      ({
        featuresJson,
        planPriceAmount,
        planCurrency,
        planAddonUserPriceAmount,
        ...subscription
      }): SubscriptionWithPricing => ({
        ...subscription,
        features: (parseJson(featuresJson) ?? []) as SubscriptionWithPricing["features"],
        effectiveMaxManagedUsers: effectiveMaxManagedUsers(
          subscription.maxManagedUsers,
          subscription.addonUsers,
        ),
        totalPriceAmount: totalPriceAmount(
          planPriceAmount ?? 0,
          planAddonUserPriceAmount ?? 0,
          subscription.addonUsers,
        ),
        currency: (planCurrency ?? "INR") as SubscriptionWithPricing["currency"],
      }),
    ),
    auditEvents: auditRows.map(({ beforeJson, afterJson, ...row }) => ({
      ...row,
      before: parseJson(beforeJson),
      after: parseJson(afterJson),
    })),
  };
}

const router = new Hono<AppEnv>();

router.get(
  "/",
  requirePermission("tenant.view"),
  zValidator("query", TenantsScreenQuery, (result, c) => {
    if (!result.success) return c.json({ error: "invalid_request" }, 400);
  }),
  async (c) => c.json(await loadTenantsScreen(createDb(c.env.DB), c.req.valid("query"))),
);

router.get("/:tenantId", requirePermission("tenant.view"), async (c) => {
  const screen = await loadTenantDetailScreen(createDb(c.env.DB), c.req.param("tenantId"));
  if (!screen) return c.json({ error: "not_found" }, 404);
  return c.json(screen);
});

export default router;
