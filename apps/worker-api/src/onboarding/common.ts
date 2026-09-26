// Owner: WT-14. Pieces shared by the self-service routes: the client key, per-client/per-user
// limits (WT-1's counters, customer system), and the owned-tenant write used by tenant
// self-creation and licence-key redemption.
import { getIP } from "better-auth/api";
import { sql } from "drizzle-orm";
import type { Context } from "hono";
import { audit } from "../audit";
import { bumpCounter, counterKey } from "../auth/counters";
import type { Db } from "../db/client";
import { tenantMemberships, tenants } from "../db/schema";
import type { AppEnv } from "../env";
import { newId } from "../ids";

/**
 * The same client key Better Auth and WT-1's counters use: `cf-connecting-ip`, IPv4 or an IPv6 /48.
 */
export function clientOf(c: Context<AppEnv>): string {
  return (
    getIP(c.req.raw, {
      advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"], ipv6Subnet: 48 } },
    }) || "unknown"
  );
}

/**
 * Counts one attempt against `kind`/`parts` and says whether it is within `max` per `windowSeconds`
 * (≤ 1 h: WT-1's counter horizon). Every attempt counts, so a caller over the limit stays over it.
 */
export async function withinLimit(
  db: Db,
  limit: { kind: string; max: number; windowSeconds: number },
  ...parts: string[]
): Promise<boolean> {
  const count = await bumpCounter(db, await counterKey(limit.kind, ...parts), limit.windowSeconds);
  return count <= limit.max;
}

export const LIMITS = {
  /** Start path: codes per (email, client) and per client (all addresses). */
  startSendPerEmailClient: { kind: "start-send", max: 5, windowSeconds: 15 * 60 },
  startSendPerClient: { kind: "start-send-client", max: 20, windowSeconds: 60 * 60 },
  startVerifyPerClient: { kind: "start-verify-client", max: 30, windowSeconds: 60 * 60 },
  /** Connect send for a non-member: bounds the anonymous audit rows (closed-sign-in note). */
  connectUnknownAudit: { kind: "connect-unknown", max: 1, windowSeconds: 15 * 60 },
  /** Tenant self-creation per customer. */
  tenantsPerUser: { kind: "self-tenant", max: 10, windowSeconds: 60 * 60 },
  /** Activation grants per customer. */
  grantsPerUser: { kind: "activation-grant", max: 20, windowSeconds: 60 * 60 },
  /** Licence-key redemption attempts per client and per customer session. */
  redeemPerClient: { kind: "lic-redeem-client", max: 20, windowSeconds: 60 * 60 },
  redeemPerUser: { kind: "lic-redeem-user", max: 10, windowSeconds: 60 * 60 },
} as const;

/**
 * Next `CBX-00001` code from `settings.tenants.next_code` in one statement. Same statement as WT-2's
 * private `allocateNextTenantCode` in routes/v1/tenants.ts (duplicated, not shared: that file is
 * WT-2's and not exported; see the WT-14 handoff).
 */
export async function allocateTenantCode(db: Db, now: string): Promise<string> {
  const row = await db.get<{ allocated: number }>(sql`
    insert into settings (key, value_json, updated_at)
    values ('tenants.next_code', '1', ${now})
    on conflict(key) do update set
      value_json = cast((cast(settings.value_json as integer) + 1) as text),
      updated_at = ${now}
    returning cast(value_json as integer) - 1 as allocated
  `);
  return `CBX-${String(row?.allocated ?? 1).padStart(5, "0")}`;
}

/** Same settings row WT-2's `POST /me/active-tenant` writes (`active_tenant:<userId>`). */
export function setActiveTenant(db: Db, userId: string, tenantId: string, now: string) {
  return db.run(sql`
    insert into settings (key, value_json, updated_at)
    values (${`active_tenant:${userId}`}, json_object('tenantId', ${tenantId}), ${now})
    on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at
  `);
}

/**
 * The statements that create a tenant owned by a customer: the tenant (`provisioning`, primary
 * contact = the caller), the caller's `owner` membership, and their audit rows (`TENANT_CREATED`,
 * `USER_INVITED`), for one `db.batch` together with whatever else the caller writes. The rows have
 * the same shape as WT-2's staff `POST /tenants` (primary contact = first owner); only the actor
 * (the customer themself) and the audit `source` differ.
 */
export function ownedTenantStatements(
  db: Db,
  input: {
    tenantId: string;
    tenantCode: string;
    userId: string;
    email: string;
    displayName: string;
    timezone: string;
    source: "self_onboarding" | "license_redemption";
    correlationId: string | null;
    now: string;
  },
) {
  const membershipId = newId("membership");
  const tenant = {
    id: input.tenantId,
    publicCode: input.tenantCode,
    displayName: input.displayName,
    status: "provisioning" as const,
    primaryContactEmail: input.email,
    timezone: input.timezone,
    createdAt: input.now,
    updatedAt: input.now,
  };
  const membership = {
    id: membershipId,
    tenantId: input.tenantId,
    userId: input.userId,
    createdAt: input.now,
    standing: "owner" as const,
    status: "active" as const,
    invitedBy: input.userId,
  };
  const actor = { type: "user" as const, id: input.userId, tenantId: input.tenantId };
  return [
    db.insert(tenants).values(tenant),
    db.insert(tenantMemberships).values(membership),
    audit(db, {
      eventType: "TENANT_CREATED",
      entityType: "tenant",
      entityId: input.tenantId,
      actor,
      before: null,
      after: {
        id: input.tenantId,
        publicCode: input.tenantCode,
        displayName: input.displayName,
        primaryContactEmail: input.email,
        timezone: input.timezone,
      },
      correlationId: input.correlationId,
      source: input.source,
    }),
    audit(db, {
      eventType: "USER_INVITED",
      entityType: "membership",
      entityId: membershipId,
      actor,
      before: null,
      after: membership,
      correlationId: input.correlationId,
      source: input.source,
    }),
  ] as const;
}
