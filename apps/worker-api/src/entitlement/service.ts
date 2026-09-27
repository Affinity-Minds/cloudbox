// Owner: WT-5. Entitlement issuance, renewal and revocation (Slices 3.1/3.2 cloud side).
// The compact JWE (`entitlements.token`) is the confidential artefact: it is stored, handed only to
// the device (WT-3 `GET /agent/entitlement`), and never logged, audited or returned to the admin UI.
import {
  type DeviceStatus,
  EntitlementClaims,
  type EntitlementRecord,
  effectiveMaxManagedUsers,
  type Feature,
  type IssueEntitlementResponse,
  type RevokeEntitlementResponse,
  type SubscriptionStatus,
} from "@cloudbox/contracts";
import { EntitlementError, issueEntitlement } from "@cloudbox/licensing-contracts";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { audit } from "../audit";
import type { Db } from "../db/client";
import { devices, entitlements, plans, subscriptions } from "../db/schema";
import type { Bindings } from "../env";
import { newId } from "../ids";
import { ensureSigningKey, SigningKeyError } from "./signing-key";
import { subscriptionLifecycle } from "./status";

/** A refusal with its HTTP status and error code (error shape in docs/handoffs/foundation.md). */
export class EntitlementRefusal extends Error {
  override readonly name = "EntitlementRefusal";
  constructor(
    readonly status: 400 | 404 | 409 | 422 | 503,
    readonly code: string,
    readonly detail?: string,
  ) {
    super(detail ?? code);
  }
}

export type Actor = {
  id: string;
  correlationId?: string | null;
  /** Default `user` (staff). WT-14's activation and heartbeat auto-issuance pass `system`. */
  type?: "user" | "system";
  /** Audit `source`; default `api`. WT-14: `activation` or `auto`. */
  source?: string;
};

const RECORD_COLUMNS = {
  id: entitlements.id,
  subscriptionId: entitlements.subscriptionId,
  deviceId: entitlements.deviceId,
  generation: entitlements.generation,
  issuedBy: entitlements.issuedBy,
  issuedAt: entitlements.issuedAt,
  validUntil: entitlements.validUntil,
  revokedAt: entitlements.revokedAt,
};

/** D1 hides the constraint text on a nested `cause` (agent-notes cloudflare-workers #7). */
function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth += 1) {
    if (String((e as { message?: unknown }).message ?? e).includes("UNIQUE constraint failed")) {
      return true;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Issue (or renew) the next generation for a device. Requires an enrolled device, a trial/active
 * subscription on the device's tenant that is inside its dates, and room under the plan's
 * `max_devices`. Renew additionally requires a current (unrevoked, latest) entitlement.
 */
export async function issueForDevice(
  env: Bindings,
  db: Db,
  input: { deviceId: string; kind: "issue" | "renew"; validUntil?: string; actor: Actor },
  now = new Date(),
): Promise<IssueEntitlementResponse> {
  const { deviceId, kind, actor } = input;

  // One round trip: the device with its tenant's non-cancelled subscription and plan, the latest
  // generation, and how many other devices hold a live entitlement on that subscription.
  // Columns that share a name across the join are aliased: drizzle's D1 batch maps rows by
  // position after keying them by column name, so duplicate names silently shift every field.
  const [contextRows, latestRows, licensedRows] = await db.batch([
    db
      .select({
        deviceId: sql<string>`${devices.id}`.as("device_id"),
        tenantId: devices.tenantId,
        deviceStatus: sql<DeviceStatus>`${devices.status}`.as("device_status"),
        devicePublicKeyJwk: devices.devicePublicKeyJwk,
        deviceKeyThumbprint: devices.deviceKeyThumbprint,
        licenseHoldReason: devices.licenseHoldReason,
        licenseHoldAt: devices.licenseHoldAt,
        subscriptionId: sql<string | null>`${subscriptions.id}`.as("subscription_id"),
        subscriptionStatus: sql<SubscriptionStatus | null>`${subscriptions.status}`.as(
          "subscription_status",
        ),
        validFrom: subscriptions.validFrom,
        validUntil: subscriptions.validUntil,
        maxManagedUsers: subscriptions.maxManagedUsers,
        // Add-on users (migration 0011, owner addition): the entitlement claim's max_managed_users
        // must be the effective limit, base + add-ons — see effectiveMaxManagedUsers below.
        addonUsers: subscriptions.addonUsers,
        featuresJson: subscriptions.featuresJson,
        offlineGraceDays: subscriptions.offlineGraceDays,
        renewalWarningDays: subscriptions.renewalWarningDays,
        maxDevices: plans.maxDevices,
      })
      .from(devices)
      .leftJoin(
        subscriptions,
        and(
          eq(subscriptions.tenantId, devices.tenantId),
          sql`${subscriptions.status} <> 'cancelled'`,
        ),
      )
      .leftJoin(plans, eq(plans.code, subscriptions.planCode))
      .where(eq(devices.id, deviceId))
      .orderBy(desc(subscriptions.validUntil))
      .limit(1),
    db
      .select({ generation: entitlements.generation, revokedAt: entitlements.revokedAt })
      .from(entitlements)
      .where(eq(entitlements.deviceId, deviceId))
      .orderBy(desc(entitlements.generation))
      .limit(1),
    db
      .select({ devices: sql<number>`count(distinct ${entitlements.deviceId})`.mapWith(Number) })
      .from(entitlements)
      .innerJoin(devices, eq(devices.id, entitlements.deviceId))
      .innerJoin(subscriptions, eq(subscriptions.id, entitlements.subscriptionId))
      .where(
        and(
          isNull(entitlements.revokedAt),
          eq(devices.status, "enrolled"),
          sql`${subscriptions.status} <> 'cancelled'`,
          sql`${entitlements.deviceId} <> ${deviceId}`,
          sql`${devices.tenantId} = (select ${devices.tenantId} from ${devices} where ${devices.id} = ${deviceId})`,
        ),
      ),
  ]);

  const ctx = contextRows[0];
  if (!ctx) throw new EntitlementRefusal(404, "not_found", "device");
  // §32: a revoked (or transferred) device must not receive a fresh lease.
  if (ctx.deviceStatus !== "enrolled") throw new EntitlementRefusal(409, "device_not_enrolled");
  // Licence hold (migration 0019): after a staff revoke, only a staff Issue/Renew may issue again.
  // Automatic issuance (actor `system`: activation, heartbeat catch-up) never lifts it.
  const automatic = actor.type === "system";
  if (automatic && ctx.licenseHoldReason) throw new EntitlementRefusal(409, "license_hold");
  if (
    !ctx.subscriptionId ||
    !ctx.subscriptionStatus ||
    !ctx.validFrom ||
    !ctx.validUntil ||
    ctx.renewalWarningDays === null ||
    !subscriptionLifecycle(
      {
        status: ctx.subscriptionStatus,
        validFrom: ctx.validFrom,
        validUntil: ctx.validUntil,
        renewalWarningDays: ctx.renewalWarningDays,
      },
      now,
    ).issuable
  ) {
    throw new EntitlementRefusal(409, "no_active_subscription");
  }

  const latest = latestRows[0];
  if (kind === "renew" && (!latest || latest.revokedAt !== null)) {
    throw new EntitlementRefusal(409, "no_entitlement_to_renew");
  }
  if ((licensedRows[0]?.devices ?? 0) >= (ctx.maxDevices ?? 0)) {
    throw new EntitlementRefusal(409, "device_limit_reached", `plan allows ${ctx.maxDevices}`);
  }

  const subscriptionEnd = Date.parse(ctx.validUntil);
  const requested = input.validUntil ? Date.parse(input.validUntil) : subscriptionEnd;
  const validUntilMs = Math.min(requested, subscriptionEnd);
  if (validUntilMs <= now.getTime()) {
    throw new EntitlementRefusal(400, "invalid_request", "valid_until must be in the future");
  }

  let key: Awaited<ReturnType<typeof ensureSigningKey>>;
  try {
    key = await ensureSigningKey(env, db);
  } catch (error) {
    if (error instanceof SigningKeyError) throw new EntitlementRefusal(503, error.code);
    throw error;
  }

  const licenseId = newId("license");
  const issuedAt = now.toISOString();
  const generation = (latest?.generation ?? 0) + 1;
  const claims = EntitlementClaims.parse({
    iss: "cloudbox",
    kid: key.kid,
    jti: licenseId,
    iat: Math.floor(now.getTime() / 1000),
    license_id: licenseId,
    tenant_id: ctx.tenantId,
    device_id: ctx.deviceId,
    device_key_thumbprint: ctx.deviceKeyThumbprint,
    // Migration 0011 (owner addition): the claim carries the effective limit, base + add-ons.
    max_managed_users: effectiveMaxManagedUsers(ctx.maxManagedUsers ?? 0, ctx.addonUsers ?? 0),
    valid_from: issuedAt,
    valid_until: new Date(validUntilMs).toISOString(),
    renewal_warning_days: ctx.renewalWarningDays,
    offline_grace_days: ctx.offlineGraceDays,
    generation,
    features: JSON.parse(ctx.featuresJson ?? "[]") as Feature[],
  });

  let token: string;
  try {
    token = await issueEntitlement({
      claims,
      serverPrivateJwk: key.privateJwk,
      kid: key.kid,
      devicePublicJwk: JSON.parse(ctx.devicePublicKeyJwk),
    });
  } catch (error) {
    if (error instanceof EntitlementError || error instanceof SyntaxError) {
      throw new EntitlementRefusal(422, "device_key_unusable");
    }
    throw error;
  }

  const record: EntitlementRecord = {
    id: licenseId,
    subscriptionId: ctx.subscriptionId,
    deviceId: ctx.deviceId,
    generation,
    issuedBy: actor.id,
    issuedAt,
    validUntil: claims.valid_until,
    revokedAt: null,
  };

  // The plan's device limit is part of the write itself (review P2-1, WT-14 activation and
  // heartbeat auto-issuance run this concurrently): one INSERT … SELECT … WHERE, so the count and
  // the insert cannot interleave with another device's issuance. Same count as the pre-check above
  // (other enrolled devices of this tenant holding a live entitlement on a non-cancelled
  // subscription). UNIQUE(device_id, generation) stays the last defence for the same device.
  let inserted: boolean;
  try {
    const result = await db.run(sql`
      INSERT INTO entitlements (id, subscription_id, device_id, generation, claims_json, token,
                                issued_by, issued_at, valid_until, revoked_at)
      SELECT ${record.id}, ${record.subscriptionId}, ${record.deviceId}, ${record.generation},
             ${JSON.stringify(claims)}, ${token}, ${record.issuedBy}, ${record.issuedAt},
             ${record.validUntil}, NULL
      WHERE (
        SELECT count(DISTINCT e.device_id)
        FROM entitlements e
        JOIN devices d ON d.id = e.device_id
        JOIN subscriptions s ON s.id = e.subscription_id
        WHERE e.revoked_at IS NULL AND d.status = 'enrolled' AND s.status <> 'cancelled'
          AND e.device_id <> ${record.deviceId} AND d.tenant_id = ${ctx.tenantId}
      ) < ${ctx.maxDevices ?? 0}
      ${
        // A hold placed after the read above still stops an automatic issuance.
        automatic
          ? sql`AND NOT EXISTS (SELECT 1 FROM devices h
                                WHERE h.id = ${record.deviceId} AND h.license_hold_reason IS NOT NULL)`
          : sql``
      }`);
    inserted = (result.meta?.changes ?? 0) === 1;
  } catch (error) {
    // UNIQUE(device_id, generation): a concurrent issue took this generation. Nothing was written.
    if (isUniqueViolation(error)) throw new EntitlementRefusal(409, "generation_conflict");
    throw error;
  }
  if (!inserted) {
    if (automatic) {
      const [held] = await db
        .select({ reason: devices.licenseHoldReason })
        .from(devices)
        .where(eq(devices.id, deviceId));
      if (held?.reason) throw new EntitlementRefusal(409, "license_hold");
    }
    throw new EntitlementRefusal(409, "device_limit_reached", `plan allows ${ctx.maxDevices}`);
  }

  // Only after a successful insert. Claims are not secret; the token is. Audit the claims only.
  await audit(db, {
    eventType: kind === "issue" ? "LICENSE_ISSUED" : "LICENSE_RENEWED",
    entityType: "entitlement",
    entityId: licenseId,
    actor: { type: actor.type ?? "user", id: actor.id },
    before:
      latest === undefined ? null : { generation: latest.generation, revokedAt: latest.revokedAt },
    after: { ...record, claims },
    correlationId: actor.correlationId,
    source: actor.source ?? "api",
  });

  // A staff Issue/Renew is the only thing that lifts a licence hold (the hold that was read above;
  // a newer one placed meanwhile stays).
  if (!automatic && ctx.licenseHoldReason) {
    await db.batch([
      db
        .update(devices)
        .set({ licenseHoldReason: null, licenseHoldAt: null, licenseHoldBy: null })
        .where(
          and(
            eq(devices.id, deviceId),
            ctx.licenseHoldAt === null
              ? isNull(devices.licenseHoldAt)
              : eq(devices.licenseHoldAt, ctx.licenseHoldAt),
          ),
        ),
      audit(db, {
        eventType: "LICENSE_HOLD_CLEARED",
        entityType: "device",
        entityId: deviceId,
        actor: { type: actor.type ?? "user", id: actor.id },
        before: { licenseHoldReason: ctx.licenseHoldReason, licenseHoldAt: ctx.licenseHoldAt },
        after: { licenseHoldReason: null, clearedBy: kind, licenseId, generation },
        correlationId: actor.correlationId,
        source: actor.source ?? "api",
      }),
    ]);
  }

  return { entitlement: record, claims };
}

/** Revokes every live entitlement of the device. The operator's typed reason is audited. */
export async function revokeForDevice(
  db: Db,
  input: { deviceId: string; reason: string; actor: Actor },
  now = new Date(),
): Promise<RevokeEntitlementResponse> {
  const { deviceId, reason, actor } = input;
  const [deviceRows, liveRows] = await db.batch([
    db
      .select({ id: devices.id, tenantId: devices.tenantId })
      .from(devices)
      .where(eq(devices.id, deviceId)),
    db
      .select({ id: entitlements.id, generation: entitlements.generation })
      .from(entitlements)
      .where(and(eq(entitlements.deviceId, deviceId), isNull(entitlements.revokedAt)))
      .orderBy(desc(entitlements.generation)),
  ]);
  const device = deviceRows[0];
  if (!device) throw new EntitlementRefusal(404, "not_found", "device");
  const newest = liveRows[0];
  if (!newest) throw new EntitlementRefusal(409, "no_active_entitlement");

  const revokedAt = now.toISOString();
  const generations = liveRows.map((row) => row.generation);
  await db.batch([
    db
      .update(entitlements)
      .set({ revokedAt })
      .where(and(eq(entitlements.deviceId, deviceId), isNull(entitlements.revokedAt))),
    // Licence hold (migration 0019): automatic issuance must not undo this revoke; only a staff
    // Issue/Renew lifts it.
    db
      .update(devices)
      .set({ licenseHoldReason: reason, licenseHoldAt: revokedAt, licenseHoldBy: actor.id })
      .where(eq(devices.id, deviceId)),
    audit(db, {
      eventType: "LICENSE_HOLD_PLACED",
      entityType: "device",
      entityId: deviceId,
      actor: { type: "user", id: actor.id },
      before: { licenseHoldReason: null },
      after: { licenseHoldReason: reason, licenseHoldAt: revokedAt, generations },
      correlationId: actor.correlationId,
      source: "api",
    }),
    audit(db, {
      eventType: "LICENSE_REVOKED",
      entityType: "entitlement",
      entityId: newest.id,
      actor: { type: "user", id: actor.id },
      before: { deviceId, tenantId: device.tenantId, generations, revokedAt: null },
      after: { deviceId, tenantId: device.tenantId, generations, revokedAt, reason },
      correlationId: actor.correlationId,
      source: "api",
    }),
  ]);
  return { deviceId, revokedGenerations: generations, revokedAt };
}

/**
 * What `GET /api/v1/agent/entitlement` (WT-3) serves: the highest generation for the device, or null
 * when there is none or the highest one is revoked. Never falls back to an older generation.
 */
export async function currentEntitlementForDevice(
  db: Db,
  deviceId: string,
): Promise<{ token: string; generation: number } | null> {
  const [row] = await db
    .select({
      token: entitlements.token,
      generation: entitlements.generation,
      revokedAt: entitlements.revokedAt,
    })
    .from(entitlements)
    .where(eq(entitlements.deviceId, deviceId))
    .orderBy(desc(entitlements.generation))
    .limit(1);
  if (!row || row.revokedAt !== null) return null;
  return { token: row.token, generation: row.generation };
}

export async function listEntitlementsForDevice(
  db: Db,
  deviceId: string,
): Promise<EntitlementRecord[]> {
  return db
    .select(RECORD_COLUMNS)
    .from(entitlements)
    .where(eq(entitlements.deviceId, deviceId))
    .orderBy(desc(entitlements.generation));
}
