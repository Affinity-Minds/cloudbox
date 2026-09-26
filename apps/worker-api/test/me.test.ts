import { env } from "cloudflare:test";
import type { MyTenant, SessionResponse, Tenant } from "@cloudbox/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { type SignedIn, signInAs } from "./auth-fixtures";

let staffAdmin: SignedIn;

beforeAll(async () => {
  staffAdmin = await signInAs(env, { email: "me-staff-admin@example.test", staffRole: "admin" });
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

async function seedTenant(displayName: string): Promise<Tenant> {
  const response = await call("/api/v1/tenants", staffAdmin, {
    method: "POST",
    body: JSON.stringify({ displayName }),
  });
  return (await response.json()) as Tenant;
}

async function seedMembership(tenantId: string, userId: string, standing: string) {
  await env.DB.prepare(
    "INSERT INTO tenant_memberships (id, tenant_id, user_id, standing) VALUES (?, ?, ?, ?)",
  )
    .bind(`mem_${crypto.randomUUID()}`, tenantId, userId, standing)
    .run();
}

describe("GET /api/v1/me/tenants", () => {
  it("lists only the caller's active memberships", async () => {
    const tenantA = await seedTenant("Me Tenant A");
    const tenantB = await seedTenant("Me Tenant B");
    const tenantC = await seedTenant("Me Tenant C (not a member)");
    const person = await signInAs(env, { email: "multi-tenant-person@example.test" });
    await seedMembership(tenantA.id, person.userId, "owner");
    await seedMembership(tenantB.id, person.userId, "user");

    const response = await call("/api/v1/me/tenants", person);
    expect(response.status).toBe(200);
    const rows = (await response.json()) as MyTenant[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.tenantId).sort()).toEqual([tenantA.id, tenantB.id].sort());
    expect(rows.map((r) => r.tenantId)).not.toContain(tenantC.id);
  });

  it("401s anonymous", async () => {
    expect((await call("/api/v1/me/tenants", null)).status).toBe(401);
  });
});

describe("POST /api/v1/me/active-tenant", () => {
  it("sets the active tenant when the caller is an active member, and it round-trips via the session", async () => {
    const tenant = await seedTenant("Active Tenant Org");
    const person = await signInAs(env, { email: "active-tenant-person@example.test" });
    await seedMembership(tenant.id, person.userId, "user");

    const set = await call("/api/v1/me/active-tenant", person, {
      method: "POST",
      body: JSON.stringify({ tenantId: tenant.id }),
    });
    expect(set.status).toBe(200);
    expect(((await set.json()) as { standing: string }).standing).toBe("user");

    const session = await call("/api/v1/auth/session", person);
    const body = (await session.json()) as SessionResponse;
    expect(body.activeTenantId).toBe(tenant.id);
  });

  it("never trusts a tenant id the caller does not belong to (403, and the session stays unset)", async () => {
    const tenant = await seedTenant("Not My Tenant");
    const person = await signInAs(env, { email: "outsider-person@example.test" });

    const set = await call("/api/v1/me/active-tenant", person, {
      method: "POST",
      body: JSON.stringify({ tenantId: tenant.id }),
    });
    expect(set.status).toBe(403);

    const session = await call("/api/v1/auth/session", person);
    const body = (await session.json()) as SessionResponse;
    expect(body.activeTenantId).toBeNull();
  });

  it("re-resolves membership on every read: a later revoke clears the active tenant", async () => {
    const tenant = await seedTenant("Revoked Active Org");
    const person = await signInAs(env, { email: "revoked-active-person@example.test" });
    await seedMembership(tenant.id, person.userId, "user");

    await call("/api/v1/me/active-tenant", person, {
      method: "POST",
      body: JSON.stringify({ tenantId: tenant.id }),
    });
    expect(
      ((await (await call("/api/v1/auth/session", person)).json()) as SessionResponse).activeTenantId,
    ).toBe(tenant.id);

    await env.DB.prepare(
      "UPDATE tenant_memberships SET status = 'revoked' WHERE tenant_id = ? AND user_id = ?",
    )
      .bind(tenant.id, person.userId)
      .run();

    const body = (await (await call("/api/v1/auth/session", person)).json()) as SessionResponse;
    expect(body.activeTenantId).toBeNull();
  });
});
