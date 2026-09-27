// Owner: WT-15. The customer portal's own screens (`/api/v1/tenants/:tenantId/portal/*`):
// tenant-scoped for any active member, never for staff, never across tenants.
import { env } from "cloudflare:test";
import type {
  FleetScreen,
  Membership,
  PortalHome,
  PortalMembersScreen,
  PortalSubscriptionScreen,
} from "@cloudbox/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import {
  type SignedIn,
  seedDevice,
  seedMembership,
  seedSubscription,
  seedTenant,
  signInAs,
} from "./fixtures";

let tenantA: Awaited<ReturnType<typeof seedTenant>>;
let tenantB: Awaited<ReturnType<typeof seedTenant>>;
let ownerA: SignedIn;
let userA: SignedIn;
let ownerB: SignedIn;
let staff: SignedIn;

beforeAll(async () => {
  tenantA = await seedTenant(env.DB, { displayName: "Portal Tenant A" });
  tenantB = await seedTenant(env.DB, { displayName: "Portal Tenant B" });
  ownerA = await signInAs(env, { email: "portal-owner-a@example.test" });
  userA = await signInAs(env, { email: "portal-user-a@example.test" });
  ownerB = await signInAs(env, { email: "portal-owner-b@example.test" });
  staff = await signInAs(env, { email: "portal-staff@example.test", staffRole: "super_admin" });
  await seedMembership(env.DB, {
    tenantId: tenantA.tenantId,
    userId: ownerA.userId,
    standing: "owner",
  });
  await seedMembership(env.DB, {
    tenantId: tenantA.tenantId,
    userId: userA.userId,
    standing: "user",
  });
  await seedMembership(env.DB, {
    tenantId: tenantB.tenantId,
    userId: ownerB.userId,
    standing: "owner",
  });
  await seedDevice(env.DB, { tenantId: tenantA.tenantId, status: "enrolled" });
  await seedSubscription(env.DB, { tenantId: tenantA.tenantId });
});

const call = (path: string, who: SignedIn | null, init: RequestInit = {}) =>
  app.request(
    path,
    {
      ...init,
      headers: {
        ...(who?.headers ?? {}),
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    },
    env,
  );

describe("GET /api/v1/tenants/:tenantId/portal (Home)", () => {
  it("returns the tenant, the caller's own standing, plan state and counts", async () => {
    const res = await call(`/api/v1/tenants/${tenantA.tenantId}/portal`, ownerA);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PortalHome;
    expect(body.tenant.id).toBe(tenantA.tenantId);
    expect(body.tenant.publicCode).toBe(tenantA.publicCode);
    expect(body.standing).toBe("owner");
    expect(body.counts).toEqual({ members: 2, devices: 1 });
  });

  it("is tenant-scoped: a member of A is refused on B", async () => {
    const res = await call(`/api/v1/tenants/${tenantB.tenantId}/portal`, ownerA);
    expect(res.status).toBe(403);
  });

  it("401s anonymous, and 401s a staff session (customer session only)", async () => {
    expect((await call(`/api/v1/tenants/${tenantA.tenantId}/portal`, null)).status).toBe(401);
    expect((await call(`/api/v1/tenants/${tenantA.tenantId}/portal`, staff)).status).toBe(401);
  });
});

describe("GET /api/v1/tenants/:tenantId/portal/members", () => {
  it("lists every active member with the caller's own standing", async () => {
    const res = await call(`/api/v1/tenants/${tenantA.tenantId}/portal/members`, userA);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PortalMembersScreen;
    expect(body.standing).toBe("user");
    expect(body.items.map((m) => m.email).sort()).toEqual([
      "portal-owner-a@example.test",
      "portal-user-a@example.test",
    ]);
  });

  it("is tenant-scoped: a member of A never sees B's members", async () => {
    const res = await call(`/api/v1/tenants/${tenantB.tenantId}/portal/members`, userA);
    expect(res.status).toBe(403);
    const responseForB = await call(`/api/v1/tenants/${tenantB.tenantId}/portal/members`, ownerB);
    const okForB = (await responseForB.json()) as PortalMembersScreen;
    expect(okForB.items.map((m) => m.email)).toEqual(["portal-owner-b@example.test"]);
  });

  it("a plain 'user' standing member cannot add a member (Owner/Admin only)", async () => {
    const res = await call(`/api/v1/tenants/${tenantA.tenantId}/memberships`, userA, {
      method: "POST",
      body: JSON.stringify({ email: "should-not-be-invited@example.test", standing: "user" }),
    });
    expect(res.status).toBe(403);
  });

  it("Owner can add a member, then revoke it with a reason kept in the audit row", async () => {
    const invited = await call(`/api/v1/tenants/${tenantA.tenantId}/memberships`, ownerA, {
      method: "POST",
      body: JSON.stringify({ email: "portal-revoke-me@example.test", standing: "user" }),
    });
    expect(invited.status).toBe(201);
    const membership = (await invited.json()) as Membership;

    const revoked = await call(
      `/api/v1/tenants/${tenantA.tenantId}/memberships/${membership.id}`,
      ownerA,
      { method: "DELETE", body: JSON.stringify({ reason: "wrong organisation" }) },
    );
    expect(revoked.status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT after_json FROM audit_log WHERE entity_type = 'membership' AND entity_id = ? AND event_type = 'USER_REMOVED'",
    )
      .bind(membership.id)
      .first<{ after_json: string }>();
    expect(JSON.parse(row?.after_json ?? "null")).toMatchObject({ reason: "wrong organisation" });
  });
});

describe("GET /api/v1/tenants/:tenantId/portal/devices", () => {
  it("reuses the fleet loader, scoped to exactly this tenant", async () => {
    const res = await call(`/api/v1/tenants/${tenantA.tenantId}/portal/devices`, ownerA);
    expect(res.status).toBe(200);
    const body = (await res.json()) as FleetScreen;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.tenantId).toBe(tenantA.tenantId);
  });

  it("is tenant-scoped: a member of A never sees B's devices", async () => {
    const res = await call(`/api/v1/tenants/${tenantB.tenantId}/portal/devices`, ownerA);
    expect(res.status).toBe(403);
    const responseForB = await call(`/api/v1/tenants/${tenantB.tenantId}/portal/devices`, ownerB);
    const forB = (await responseForB.json()) as FleetScreen;
    expect(forB.items).toHaveLength(0);
  });
});

describe("GET /api/v1/tenants/:tenantId/portal/subscription", () => {
  it("returns the plan-derived fields (validity, effective users, price)", async () => {
    const res = await call(`/api/v1/tenants/${tenantA.tenantId}/portal/subscription`, ownerA);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PortalSubscriptionScreen;
    expect(body.subscription).toMatchObject({ planCode: "cloudbox-6", status: "active" });
    expect(body.subscription?.effectiveMaxManagedUsers).toBeGreaterThan(0);
    expect(typeof body.subscription?.totalPriceAmount).toBe("number");
  });

  it("is null (not a 404) for a tenant that never had a plan assigned", async () => {
    const res = await call(`/api/v1/tenants/${tenantB.tenantId}/portal/subscription`, ownerB);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PortalSubscriptionScreen;
    expect(body.subscription).toBeNull();
  });

  it("is tenant-scoped", async () => {
    const res = await call(`/api/v1/tenants/${tenantB.tenantId}/portal/subscription`, ownerA);
    expect(res.status).toBe(403);
  });
});
