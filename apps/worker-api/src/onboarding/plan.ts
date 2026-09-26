// Owner: WT-14. A tenant's plan as its members, Connect and Fleet see it (ADR 0011), derived at read
// time from the tenant's newest non-cancelled subscription. "Active" means status `active` and
// inside its dates: there is no trial on the self-service path.
import { NO_ACTIVE_PLAN_MESSAGE, type TenantPlan } from "@cloudbox/contracts";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import { plans, subscriptions } from "../db/schema";

export type PlanRow = {
  tenantId: string;
  subscriptionId: string;
  status: string;
  validFrom: string | null;
  validUntil: string | null;
  planCode: string;
  planName: string | null;
  maxDevices: number | null;
};

/** Newest non-cancelled subscription (and its plan) of each tenant: one indexed query. */
export function tenantPlanQuery(db: Db, tenantIds: string[]) {
  return db
    .select({
      tenantId: subscriptions.tenantId,
      subscriptionId: subscriptions.id,
      status: subscriptions.status,
      validFrom: subscriptions.validFrom,
      validUntil: subscriptions.validUntil,
      planCode: subscriptions.planCode,
      planName: plans.name,
      maxDevices: plans.maxDevices,
    })
    .from(subscriptions)
    .leftJoin(plans, eq(plans.code, subscriptions.planCode))
    .where(
      and(
        inArray(subscriptions.tenantId, tenantIds.length > 0 ? tenantIds : [""]),
        ne(subscriptions.status, "cancelled"),
      ),
    )
    .orderBy(desc(subscriptions.createdAt));
}

/** First (newest) row per tenant. */
export function newestPerTenant(rows: PlanRow[]): Map<string, PlanRow> {
  const out = new Map<string, PlanRow>();
  for (const row of rows) if (!out.has(row.tenantId)) out.set(row.tenantId, row);
  return out;
}

/** `active` and inside its dates at `now`. */
export function isRunning(row: Pick<PlanRow, "status" | "validFrom" | "validUntil">, now: Date) {
  if (row.status !== "active" || !row.validFrom || !row.validUntil) return false;
  const at = now.getTime();
  return Date.parse(row.validFrom) <= at && at < Date.parse(row.validUntil);
}

export function toTenantPlan(row: PlanRow | undefined, now = new Date()): TenantPlan {
  const base = {
    planCode: row?.planCode ?? null,
    planName: row?.planName ?? null,
    maxDevices: row?.maxDevices ?? null,
    validFrom: row?.validFrom ?? null,
    validUntil: row?.validUntil ?? null,
  };
  if (row?.status === "pending") return { state: "pending_activation", ...base, message: null };
  if (row && isRunning(row, now)) return { state: "active", ...base, message: null };
  return { state: "no_active_plan", ...base, message: NO_ACTIVE_PLAN_MESSAGE };
}
