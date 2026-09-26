import { env } from "cloudflare:test";
import type { MyTenant, SessionResponse } from "@cloudbox/contracts";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import { type SignedIn, seedMembership, seedTenant, signInAs } from "./fixtures";

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

describe("GET /api/v1/me/tenants", () => {
  it("lists only the caller's active memberships", async () => {
    const tenantA = await seedTenant(env.DB, { displayName: "Me Tenant A" });
    const tenantB = await seedTenant(env.DB, { displayName: "Me Tenant B" });
    const tenantC = await seedTenant(env.DB, { displayName: "Me Tenant C (not a member)" });
    const person = await signInAs(env, { email: "multi-tenant-person@example.test" });
    await seedMembership(env.DB, {
      tenantId: tenantA.tenantId,
      userId: person.userId,
      standing: "owner",
    });
    await seedMembership(env.DB, {
      tenantId: tenantB.tenantId,
      userId: person.userId,
      standing: "user",
    });

    const response = await call("/api/v1/me/tenants", person);
    expect(response.status).toBe(200);
    const rows = (await response.json()) as MyTenant[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.tenantId).sort()).toEqual([tenantA.tenantId, tenantB.tenantId].sort());
    expect(rows.map((r) => r.tenantId)).not.toContain(tenantC.tenantId);
  });

  it("401s anonymous", async () => {
    expect((await call("/api/v1/me/tenants", null)).status).toBe(401);
  });
});

describe("POST /api/v1/me/active-tenant", () => {
  it("sets the active tenant when the caller is an active member, and it round-trips via the session", async () => {
    const tenant = await seedTenant(env.DB, { displayName: "Active Tenant Org" });
    const person = await signInAs(env, { email: "active-tenant-person@example.test" });
    await seedMembership(env.DB, {
      tenantId: tenant.tenantId,
      userId: person.userId,
      standing: "user",
    });

    const set = await call("/api/v1/me/active-tenant", person, {
      method: "POST",
      body: JSON.stringify({ tenantId: tenant.tenantId }),
    });
    expect(set.status).toBe(200);
    expect(((await set.json()) as { standing: string }).standing).toBe("user");

    const session = await call("/api/v1/auth/session", person);
    const body = (await session.json()) as SessionResponse;
    expect(body.activeTenantId).toBe(tenant.tenantId);
  });

  it("never trusts a tenant id the caller does not belong to (403, and the session stays unset)", async () => {
    const tenant = await seedTenant(env.DB, { displayName: "Not My Tenant" });
    const person = await signInAs(env, { email: "outsider-person@example.test" });

    const set = await call("/api/v1/me/active-tenant", person, {
      method: "POST",
      body: JSON.stringify({ tenantId: tenant.tenantId }),
    });
    expect(set.status).toBe(403);

    const session = await call("/api/v1/auth/session", person);
    const body = (await session.json()) as SessionResponse;
    expect(body.activeTenantId).toBeNull();
  });

  it("re-resolves membership on every read: a later revoke clears the active tenant", async () => {
    const tenant = await seedTenant(env.DB, { displayName: "Revoked Active Org" });
    const person = await signInAs(env, { email: "revoked-active-person@example.test" });
    await seedMembership(env.DB, {
      tenantId: tenant.tenantId,
      userId: person.userId,
      standing: "user",
    });

    await call("/api/v1/me/active-tenant", person, {
      method: "POST",
      body: JSON.stringify({ tenantId: tenant.tenantId }),
    });
    expect(
      ((await (await call("/api/v1/auth/session", person)).json()) as SessionResponse)
        .activeTenantId,
    ).toBe(tenant.tenantId);

    await env.DB.prepare(
      "UPDATE tenant_memberships SET status = 'revoked' WHERE tenant_id = ? AND user_id = ?",
    )
      .bind(tenant.tenantId, person.userId)
      .run();

    const body = (await (await call("/api/v1/auth/session", person)).json()) as SessionResponse;
    expect(body.activeTenantId).toBeNull();
  });
});
