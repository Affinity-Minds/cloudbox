// Owner: WT-14. Plan redemption and licence generation when a server activates (ADR 0011).
//
// Two events, deliberately separate:
//   1. Plan assignment (staff, or a redeemed licence key): a `pending` subscription with no dates.
//   2. Plan redemption, at the tenant's first successful server activation: `valid_from = now`,
//      `valid_until = now + plan term`, status `active`, audited `SUBSCRIPTION_REDEEMED`. One
//      conditional UPDATE, so only the first activation redeems.
// Then licence generation: the device entitlement is issued through WT-5's `issueForDevice`
// (audited `LICENSE_ISSUED`, actor `system`). `/agent/enroll` runs this with source `activation`;
// `/agent/heartbeat` runs it (source `auto`) whenever the device holds no live entitlement, which is
// the catch-up path for a plan assigned after the server was activated.
import {
  type AgentLicenseState,
  DEVICE_LIMIT_MESSAGE,
  LICENSE_REVOKED_MESSAGE,
  NO_ACTIVE_PLAN_MESSAGE,
} from "@cloudbox/contracts";
import { and, eq, sql } from "drizzle-orm";
import { audit } from "../audit";
import type { Db } from "../db/client";
import { devices, subscriptions } from "../db/schema";
import {
  currentEntitlementForDevice,
  EntitlementRefusal,
  issueForDevice,
} from "../entitlement/service";
import type { AppDevice, Bindings } from "../env";
import { isRunning, newestPerTenant, type PlanRow, tenantPlanQuery } from "./plan";

/** Plan term when `plans.term_days` (WT-13) is absent or empty. */
export const DEFAULT_TERM_DAYS = 365;
const DAY_MS = 86_400_000;

const held = {
  licenseState: "revoked",
  message: LICENSE_REVOKED_MESSAGE,
  generation: null,
} as const satisfies ActivationOutcome;

export type ActivationOutcome = {
  licenseState?: AgentLicenseState;
  message?: string;
  generation: number | null;
};

/**
 * `plans.term_days` when the column exists (WT-13 adds it), else 365. `SELECT *` so this reads
 * whether or not the column exists yet.
 */
export async function planTermDays(db: Db, planCode: string): Promise<number> {
  const row = await db.get<Record<string, unknown> | undefined>(
    sql`SELECT * FROM plans WHERE code = ${planCode}`,
  );
  const days = Number(row?.term_days);
  return Number.isInteger(days) && days > 0 ? days : DEFAULT_TERM_DAYS;
}

/** Redeems a `pending` subscription (first activation only). True when this call redeemed it. */
async function redeem(
  db: Db,
  plan: PlanRow,
  device: AppDevice,
  source: string,
  correlationId: string | null,
  now: Date,
): Promise<PlanRow> {
  const days = await planTermDays(db, plan.planCode);
  const validFrom = now.toISOString();
  const validUntil = new Date(now.getTime() + days * DAY_MS).toISOString();
  const [redeemed] = await db
    .update(subscriptions)
    .set({ status: "active", validFrom, validUntil, updatedAt: validFrom })
    .where(and(eq(subscriptions.id, plan.subscriptionId), eq(subscriptions.status, "pending")))
    .returning({ id: subscriptions.id });
  if (!redeemed) {
    // Another activation redeemed it first: read the dates it set.
    const [current] = await db
      .select({
        status: subscriptions.status,
        validFrom: subscriptions.validFrom,
        validUntil: subscriptions.validUntil,
      })
      .from(subscriptions)
      .where(eq(subscriptions.id, plan.subscriptionId));
    return { ...plan, ...(current ?? {}) };
  }
  await audit(db, {
    eventType: "SUBSCRIPTION_REDEEMED",
    entityType: "subscription",
    entityId: plan.subscriptionId,
    actor: { type: "system", id: "activation", tenantId: plan.tenantId },
    before: { status: "pending", validFrom: null, validUntil: null },
    after: {
      status: "active",
      validFrom,
      validUntil,
      termDays: days,
      planCode: plan.planCode,
      deviceId: device.id,
    },
    correlationId,
    source,
  });
  return { ...plan, status: "active", validFrom, validUntil };
}

/**
 * For a device that holds no live entitlement: redeem the tenant's pending plan if there is one,
 * then issue the entitlement when the plan is active and in date. Never throws for a licensing
 * reason: the caller (enroll, heartbeat) must still succeed.
 */
export async function activateLicense(
  env: Bindings,
  db: Db,
  device: AppDevice,
  options: { source: "activation" | "auto"; correlationId?: string | null },
  now = new Date(),
): Promise<ActivationOutcome> {
  const correlationId = options.correlationId ?? null;
  const [current, planRows, holdRows] = await Promise.all([
    currentEntitlementForDevice(db, device.id),
    tenantPlanQuery(db, [device.tenantId]),
    db.select({ reason: devices.licenseHoldReason }).from(devices).where(eq(devices.id, device.id)),
  ]);
  if (current) return { licenseState: "licensed", generation: current.generation };
  // Licence hold: a staff revoke stands until a staff Issue/Renew. Nothing is redeemed or issued.
  if (holdRows[0]?.reason) return held;

  let plan = newestPerTenant(planRows).get(device.tenantId);
  const none: ActivationOutcome = {
    licenseState: "no_active_plan",
    message: NO_ACTIVE_PLAN_MESSAGE,
    generation: null,
  };
  if (!plan) return none;
  if (plan.status === "pending") {
    plan = await redeem(db, plan, device, options.source, correlationId, now);
  }
  if (!isRunning(plan, now)) return none;

  try {
    const issued = await issueForDevice(
      env,
      db,
      {
        deviceId: device.id,
        kind: "issue",
        actor: { id: "system", type: "system", source: options.source, correlationId },
      },
      now,
    );
    return { licenseState: "licensed", generation: issued.entitlement.generation };
  } catch (error) {
    if (!(error instanceof EntitlementRefusal)) throw error;
    if (error.code === "device_limit_reached") {
      return {
        licenseState: "device_limit_reached",
        message: DEVICE_LIMIT_MESSAGE,
        generation: null,
      };
    }
    if (error.code === "no_active_subscription") return none;
    if (error.code === "license_hold") return held;
    if (error.code === "generation_conflict") {
      // A concurrent heartbeat issued it a moment ago.
      const again = await currentEntitlementForDevice(db, device.id);
      return again
        ? { licenseState: "licensed", generation: again.generation }
        : { generation: null };
    }
    // Signing key not provisioned, unusable device key, …: reported to operators, not the agent.
    console.error("activation: entitlement not issued", device.id, error.code);
    return { generation: null };
  }
}
