// Owner: WT-5. GET /api/v1/screens/subscriptions and /:id. Each is one D1 round trip (db.batch).
// Days remaining and expiry are derived here at read time from "now"; nothing derived is stored.
import {
  type EntitlementHistoryItem,
  effectiveMaxManagedUsers,
  type SubscriptionDetailScreen,
  type SubscriptionDevice,
  type SubscriptionListItem,
  type SubscriptionsScreen,
  totalPriceAmount,
} from "@cloudbox/contracts";
import { asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { requirePermission } from "../../../authz/permissions";
import { createDb, type Db } from "../../../db/client";
import { devices, entitlements, plans, subscriptions, tenants } from "../../../db/schema";
import { signingKeyConfigured } from "../../../entitlement/signing-key";
import { subscriptionLifecycle } from "../../../entitlement/status";
import type { AppEnv } from "../../../env";
import { toPlan, toSubscription } from "../subscriptions";

const subscriptionColumns = {
  sub: subscriptions,
  tenantCode: tenants.publicCode,
  tenantName: tenants.displayName,
  planName: plans.name,
  // Migration 0011 (owner addition): needed to derive effectiveMaxManagedUsers/totalPriceAmount.
  planPriceAmount: plans.priceAmount,
  planCurrency: plans.currency,
  planAddonUserPriceAmount: plans.addonUserPriceAmount,
};

/** Devices of the given tenants with their highest generation (one grouped query, no N+1). */
function devicesWithGeneration(db: Db, tenantFilter: ReturnType<typeof sql>) {
  const latest = db
    .select({
      deviceId: entitlements.deviceId,
      maxGeneration: sql<number>`max(${entitlements.generation})`.as("max_generation"),
    })
    .from(entitlements)
    .groupBy(entitlements.deviceId)
    .as("latest");
  return db
    .select({
      id: devices.id,
      tenantId: devices.tenantId,
      name: devices.name,
      hostname: devices.hostname,
      status: devices.status,
      keyProtection: devices.keyProtection,
      lastSeenAt: devices.lastSeenAt,
      currentGeneration: latest.maxGeneration,
      currentValidUntil: entitlements.validUntil,
      currentRevokedAt: entitlements.revokedAt,
    })
    .from(devices)
    .leftJoin(latest, eq(latest.deviceId, devices.id))
    .leftJoin(
      entitlements,
      sql`${entitlements.deviceId} = ${devices.id} and ${entitlements.generation} = ${latest.maxGeneration}`,
    )
    .where(tenantFilter)
    .orderBy(asc(devices.enrolledAt));
}

type DeviceRow = Awaited<ReturnType<typeof devicesWithGeneration>>[number];

const toDevice = (row: DeviceRow): SubscriptionDevice => ({
  id: row.id,
  name: row.name,
  hostname: row.hostname,
  status: row.status,
  keyProtection: row.keyProtection,
  lastSeenAt: row.lastSeenAt,
  currentGeneration: row.currentGeneration ?? null,
  currentValidUntil: row.currentValidUntil ?? null,
  currentRevoked: row.currentRevokedAt !== null && row.currentRevokedAt !== undefined,
});

function toListItem(
  row: {
    sub: typeof subscriptions.$inferSelect;
    tenantCode: string | null;
    tenantName: string | null;
    planName: string | null;
    planPriceAmount: number | null;
    planCurrency: string | null;
    planAddonUserPriceAmount: number | null;
  },
  deviceRows: DeviceRow[],
  now: Date,
): SubscriptionListItem {
  const subscription = toSubscription(row.sub);
  return {
    ...subscription,
    tenantCode: row.tenantCode ?? "",
    tenantName: row.tenantName ?? "",
    planName: row.planName ?? subscription.planCode,
    ...subscriptionLifecycle(subscription, now),
    devices: deviceRows.filter((d) => d.tenantId === subscription.tenantId).map(toDevice),
    effectiveMaxManagedUsers: effectiveMaxManagedUsers(
      subscription.maxManagedUsers,
      subscription.addonUsers,
    ),
    totalPriceAmount: totalPriceAmount(
      row.planPriceAmount ?? 0,
      row.planAddonUserPriceAmount ?? 0,
      subscription.addonUsers,
    ),
    currency: (row.planCurrency ?? "INR") as SubscriptionListItem["currency"],
  };
}

export async function loadSubscriptions(db: Db, now = new Date()): Promise<SubscriptionsScreen> {
  const [subRows, deviceRows, planRows, tenantRows] = await db.batch([
    db
      .select(subscriptionColumns)
      .from(subscriptions)
      .leftJoin(tenants, eq(tenants.id, subscriptions.tenantId))
      .leftJoin(plans, eq(plans.code, subscriptions.planCode))
      .orderBy(asc(subscriptions.validUntil)),
    devicesWithGeneration(
      db,
      sql`${devices.tenantId} in (select ${subscriptions.tenantId} from ${subscriptions})`,
    ),
    // The "New subscription" picker: retired plans (WT-13) cannot be chosen for a new one.
    db.select().from(plans).where(eq(plans.status, "active")).orderBy(plans.code),
    db
      .select({ id: tenants.id, publicCode: tenants.publicCode, displayName: tenants.displayName })
      .from(tenants)
      .where(isNull(tenants.archivedAt))
      .orderBy(asc(tenants.publicCode)),
  ]);

  return {
    serverTime: now.toISOString(),
    items: subRows.map((row) => toListItem(row, deviceRows, now)),
    plans: planRows.map(toPlan),
    tenants: tenantRows,
  };
}

export async function loadSubscriptionDetail(
  db: Db,
  id: string,
  now = new Date(),
): Promise<Omit<SubscriptionDetailScreen, "signingKeyConfigured"> | null> {
  const tenantOf = sql`(select ${subscriptions.tenantId} from ${subscriptions} where ${subscriptions.id} = ${id})`;
  const [subRows, planRows, deviceRows, historyRows] = await db.batch([
    db
      .select(subscriptionColumns)
      .from(subscriptions)
      .leftJoin(tenants, eq(tenants.id, subscriptions.tenantId))
      .leftJoin(plans, eq(plans.code, subscriptions.planCode))
      .where(eq(subscriptions.id, id)),
    db
      .select()
      .from(plans)
      .where(
        eq(
          plans.code,
          sql`(select ${subscriptions.planCode} from ${subscriptions} where ${subscriptions.id} = ${id})`,
        ),
      ),
    devicesWithGeneration(db, sql`${devices.tenantId} = ${tenantOf}`),
    // Every generation for the tenant's devices, across subscriptions: the device's license history.
    db
      .select({
        id: entitlements.id,
        subscriptionId: entitlements.subscriptionId,
        deviceId: entitlements.deviceId,
        deviceName: devices.name,
        generation: entitlements.generation,
        issuedBy: entitlements.issuedBy,
        issuedAt: entitlements.issuedAt,
        validFrom: sql<string>`json_extract(${entitlements.claimsJson}, '$.valid_from')`,
        validUntil: entitlements.validUntil,
        revokedAt: entitlements.revokedAt,
      })
      .from(entitlements)
      .innerJoin(devices, eq(devices.id, entitlements.deviceId))
      .where(
        inArray(
          entitlements.deviceId,
          db.select({ id: devices.id }).from(devices).where(sql`${devices.tenantId} = ${tenantOf}`),
        ),
      )
      .orderBy(desc(entitlements.issuedAt), desc(entitlements.generation)),
  ]);

  const row = subRows[0];
  const plan = planRows[0];
  if (!row || !plan) return null;
  const history: EntitlementHistoryItem[] = historyRows;
  return {
    serverTime: now.toISOString(),
    subscription: toListItem(row, deviceRows, now),
    plan: toPlan(plan),
    entitlements: history,
  };
}

const screen = new Hono<AppEnv>();

screen.get("/", requirePermission("subscription.view"), async (c) =>
  c.json(await loadSubscriptions(createDb(c.env.DB))),
);

screen.get("/:id", requirePermission("subscription.view"), async (c) => {
  const detail = await loadSubscriptionDetail(createDb(c.env.DB), c.req.param("id"));
  if (!detail) return c.json({ error: "not_found" }, 404);
  const body: SubscriptionDetailScreen = {
    ...detail,
    signingKeyConfigured: signingKeyConfigured(c.env),
  };
  return c.json(body);
});

export default screen;
