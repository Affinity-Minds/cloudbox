// Fixtures contract (docs/handoffs/foundation.md "Tests"). WT-6 implements; everyone consumes.
// Until WT-6 lands, tests that need a missing fixture are written against these names as test.todo.
import type { MembershipStanding, StaffRole, TenantStatus } from "@cloudbox/contracts";

export { type CountingD1, countingD1 } from "./counting-d1";

const pending = (name: string): never => {
  throw new Error(`WT-6 implements ${name}`);
};

export async function seedStaff(
  _db: D1Database,
  _input: { email: string; role: StaffRole },
): Promise<{ userId: string }> {
  return pending("seedStaff");
}

export async function seedTenant(
  _db: D1Database,
  _input: { displayName?: string; status?: TenantStatus; planCode?: string } = {},
): Promise<{ tenantId: string; publicCode: string }> {
  return pending("seedTenant");
}

export async function seedMembership(
  _db: D1Database,
  _input: { tenantId: string; userId: string; standing: MembershipStanding },
): Promise<{ membershipId: string }> {
  return pending("seedMembership");
}

export async function seedDevice(
  _db: D1Database,
  _input: { tenantId: string },
): Promise<{ deviceId: string }> {
  return pending("seedDevice");
}

/** Creates a Better Auth session through the library and returns the request header. */
export async function signInAs(_userId: string): Promise<{ Cookie: string }> {
  return pending("signInAs");
}
