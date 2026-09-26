// Fixtures contract (docs/handoffs/foundation.md "Tests"). WT-6 implements; everyone consumes.
// Each seed* helper takes the raw `D1Database` binding (usually `env.DB`, or a `countingD1(...)`
// wrapper), inserts through the Drizzle schema so columns can never drift from `db/schema.ts`,
// and returns the row it inserted (camelCase, matching the `@cloudbox/contracts` shape).
import type {
  MembershipStanding,
  StaffRole,
  SubscriptionStatus,
  TenantStatus,
} from "@cloudbox/contracts";
import { createDb } from "../src/db/client";
import {
  devices,
  staffMembers,
  subscriptions,
  tenantMemberships,
  tenants,
  user,
} from "../src/db/schema";
import { newId, nowIso } from "../src/ids";

// signInAs is owned by WT-1 (test/auth-fixtures.ts): it creates a real Better Auth session
// through the library's own test-utils plugin, not by hand-minting a session row.
export { type SignedIn, signInAs, TEST_ORIGIN } from "./auth-fixtures";
export { type CountingD1, countingD1 } from "./counting-d1";

// ─── id / value helpers ─────────────────────────────────────────────────────────────────────

let seq = 0;
/** Short unique suffix for values that only need to be distinct within a test run. */
const unique = (): string => `${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Better Auth generates its own user ids at runtime; it never prefixes them like ours. */
const newUserId = (): string => crypto.randomUUID();

// ─── seedStaff ──────────────────────────────────────────────────────────────────────────────

export type SeededStaff = {
  userId: string;
  email: string;
  name: string;
  role: StaffRole;
  createdAt: string;
};

/**
 * Inserts the Better Auth `user` row (only the columns the generated schema has: id, name,
 * email — `email_verified`/timestamps take their column defaults) plus the matching
 * `staff_members` row.
 */
export async function seedStaff(
  d1: D1Database,
  input: { email: string; role: StaffRole; name?: string; createdBy?: string | null },
): Promise<SeededStaff> {
  const db = createDb(d1);
  const userId = newUserId();
  const name = input.name ?? input.email.split("@")[0] ?? "Staff";
  const createdAt = nowIso();

  await db.insert(user).values({ id: userId, name, email: input.email });
  await db.insert(staffMembers).values({
    userId,
    role: input.role,
    createdBy: input.createdBy ?? null,
    createdAt,
  });

  return { userId, email: input.email, name, role: input.role, createdAt };
}

// ─── seedTenant ─────────────────────────────────────────────────────────────────────────────

export type SeededTenant = {
  tenantId: string;
  publicCode: string;
  displayName: string;
  status: TenantStatus;
  planCode: string | null;
  createdAt: string;
  updatedAt: string;
};

/** `publicCode` defaults to a unique `CBX-#####` value; it does not consume the real counter. */
export async function seedTenant(
  d1: D1Database,
  input: {
    displayName?: string;
    status?: TenantStatus;
    planCode?: string | null;
    publicCode?: string;
  } = {},
): Promise<SeededTenant> {
  const db = createDb(d1);
  const tenantId = newId("tenant");
  const displayName = input.displayName ?? `Test Tenant ${unique()}`;
  const status = input.status ?? "active";
  const planCode = input.planCode ?? null;
  // A unique 6-digit code, matching `TenantPublicCode` (`^CBX-\d{5,}$`) but independent of the
  // real `settings.tenants.next_code` counter, which the API owns.
  const publicCode = input.publicCode ?? `CBX-${100000 + seq++}`;
  const now = nowIso();

  await db.insert(tenants).values({
    id: tenantId,
    publicCode,
    displayName,
    status,
    planCode,
    createdAt: now,
    updatedAt: now,
  });

  return { tenantId, publicCode, displayName, status, planCode, createdAt: now, updatedAt: now };
}

// ─── seedMembership ─────────────────────────────────────────────────────────────────────────

export type SeededMembership = {
  membershipId: string;
  tenantId: string;
  userId: string;
  standing: MembershipStanding;
  createdAt: string;
};

export async function seedMembership(
  d1: D1Database,
  input: { tenantId: string; userId: string; standing: MembershipStanding; invitedBy?: string },
): Promise<SeededMembership> {
  const db = createDb(d1);
  const membershipId = newId("membership");
  const createdAt = nowIso();

  await db.insert(tenantMemberships).values({
    id: membershipId,
    tenantId: input.tenantId,
    userId: input.userId,
    standing: input.standing,
    invitedBy: input.invitedBy ?? null,
    createdAt,
  });

  return {
    membershipId,
    tenantId: input.tenantId,
    userId: input.userId,
    standing: input.standing,
    createdAt,
  };
}

// ─── seedDevice ─────────────────────────────────────────────────────────────────────────────

export type SeededDevice = {
  deviceId: string;
  tenantId: string;
  name: string;
  status: "enrolled" | "revoked" | "transferred";
  deviceKeyThumbprint: string;
  hostname: string;
  enrolledAt: string;
};

export async function seedDevice(
  d1: D1Database,
  input: {
    tenantId: string;
    name?: string;
    hostname?: string;
    status?: "enrolled" | "revoked" | "transferred";
    keyProtection?: "tpm" | "software";
  },
): Promise<SeededDevice> {
  const db = createDb(d1);
  const deviceId = newId("device");
  const suffix = unique();
  const name = input.name ?? `TEST-DEVICE-${suffix}`;
  const hostname = input.hostname ?? `test-host-${suffix}`;
  const status = input.status ?? "enrolled";
  const enrolledAt = nowIso();

  await db.insert(devices).values({
    id: deviceId,
    tenantId: input.tenantId,
    name,
    status,
    devicePublicKeyJwk: JSON.stringify({ kty: "RSA", n: `test-${suffix}`, e: "AQAB" }),
    deviceKeyThumbprint: `thumb-${suffix}`,
    keyProtection: input.keyProtection ?? "software",
    hostname,
    enrolledAt,
  });

  return {
    deviceId,
    tenantId: input.tenantId,
    name,
    status,
    deviceKeyThumbprint: `thumb-${suffix}`,
    hostname,
    enrolledAt,
  };
}

// ─── seedSubscription ───────────────────────────────────────────────────────────────────────

export type SeededSubscription = {
  subscriptionId: string;
  tenantId: string;
  planCode: string;
  status: SubscriptionStatus;
  validFrom: string;
  validUntil: string;
  createdAt: string;
  updatedAt: string;
};

/** Defaults mirror the seeded `cloudbox-6` plan (migration 0003) unless overridden. */
export async function seedSubscription(
  d1: D1Database,
  input: {
    tenantId: string;
    planCode?: string;
    status?: SubscriptionStatus;
    validFrom?: string;
    validUntil?: string;
    maxManagedUsers?: number;
    features?: string[];
    offlineGraceDays?: number;
    renewalWarningDays?: number;
  },
): Promise<SeededSubscription> {
  const db = createDb(d1);
  const subscriptionId = newId("subscription");
  const planCode = input.planCode ?? "cloudbox-6";
  const status = input.status ?? "active";
  const now = nowIso();
  const validFrom = input.validFrom ?? now;
  const validUntil = input.validUntil ?? new Date(Date.now() + 365 * 86400_000).toISOString();

  await db.insert(subscriptions).values({
    id: subscriptionId,
    tenantId: input.tenantId,
    planCode,
    status,
    validFrom,
    validUntil,
    maxManagedUsers: input.maxManagedUsers ?? 6,
    featuresJson: JSON.stringify(input.features ?? ["remote_access", "managed_backup", "fleet"]),
    offlineGraceDays: input.offlineGraceDays ?? 7,
    renewalWarningDays: input.renewalWarningDays ?? 30,
    createdAt: now,
    updatedAt: now,
  });

  return {
    subscriptionId,
    tenantId: input.tenantId,
    planCode,
    status,
    validFrom,
    validUntil,
    createdAt: now,
    updatedAt: now,
  };
}
