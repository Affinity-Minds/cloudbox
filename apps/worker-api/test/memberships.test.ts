import { env } from "cloudflare:test";
import type { Membership, Tenant } from "@cloudbox/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { type SignedIn, signInAs } from "./auth-fixtures";

let staffAdmin: SignedIn;
let staffReadOnly: SignedIn;

beforeAll(async () => {
  staffAdmin = await signInAs(env, { email: "mem-staff-admin@example.test", staffRole: "admin" });
  staffReadOnly = await signInAs(env, {
    email: "mem-staff-reader@example.test",
    staffRole: "read_only",
  });
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

async function auditFor(entityType: string, entityId: string) {
  const { results } = await env.DB.prepare(
    "SELECT event_type, before_json, after_json FROM audit_log WHERE entity_type = ? AND entity_id = ? ORDER BY rowid",
  )
    .bind(entityType, entityId)
    .all<{ event_type: string; before_json: string | null; after_json: string | null }>();
  return results.map((row) => ({
    eventType: row.event_type,
    before: row.before_json ? JSON.parse(row.before_json) : null,
    after: row.after_json ? JSON.parse(row.after_json) : null,
  }));
}

describe("POST /api/v1/tenants/:tenantId/memberships", () => {
  it("creates the Better Auth user, the membership, and audits USER_INVITED", async () => {
    const tenant = await seedTenant("Invite Org");
    const response = await call(`/api/v1/tenants/${tenant.id}/memberships`, staffAdmin, {
      method: "POST",
      body: JSON.stringify({ email: "New.Invitee@example.test", standing: "owner" }),
    });
    expect(response.status).toBe(201);
    const membership = (await response.json()) as Membership;
    expect(membership).toMatchObject({
      tenantId: tenant.id,
      standing: "owner",
      status: "active",
      email: "new.invitee@example.test",
    });

    const row = await env.DB.prepare("SELECT id, email FROM user WHERE email = ?")
      .bind("new.invitee@example.test")
      .first<{ id: string; email: string }>();
    expect(row?.id).toBe(membership.userId);

    const events = await auditFor("membership", membership.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "USER_INVITED",
      before: null,
      after: { standing: "owner", userId: membership.userId },
    });
  });

  it("reuses an existing Better Auth user by email instead of creating a duplicate", async () => {
    const tenant = await seedTenant("Reuse Org");
    const existing = await signInAs(env, { email: "reused-person@example.test" });

    const response = await call(`/api/v1/tenants/${tenant.id}/memberships`, staffAdmin, {
      method: "POST",
      body: JSON.stringify({ email: "reused-person@example.test", standing: "user" }),
    });
    expect(response.status).toBe(201);
    const membership = (await response.json()) as Membership;
    expect(membership.userId).toBe(existing.userId);
  });

  it("409s inviting the same active member twice", async () => {
    const tenant = await seedTenant("Duplicate Org");
    const body = JSON.stringify({ email: "dup@example.test", standing: "user" });
    const first = await call(`/api/v1/tenants/${tenant.id}/memberships`, staffAdmin, {
      method: "POST",
      body,
    });
    expect(first.status).toBe(201);
    const second = await call(`/api/v1/tenants/${tenant.id}/memberships`, staffAdmin, {
      method: "POST",
      body,
    });
    expect(second.status).toBe(409);
  });

  it("401s anonymous and 403s a staff member without tenant.manage or tenant standing", async () => {
    const tenant = await seedTenant("Guarded Org");
    const path = `/api/v1/tenants/${tenant.id}/memberships`;
    expect(
      (
        await call(path, null, {
          method: "POST",
          body: JSON.stringify({ email: "a@b.test", standing: "user" }),
        })
      ).status,
    ).toBe(401);
    const denied = await call(path, staffReadOnly, {
      method: "POST",
      body: JSON.stringify({ email: "a@b.test", standing: "user" }),
    });
    expect(denied.status).toBe(403);
  });

  it("tenant boundary: a tenant admin may invite into their own tenant but not another's", async () => {
    const tenantA = await seedTenant("Tenant A");
    const tenantB = await seedTenant("Tenant B");
    const tenantAdmin = await signInAs(env, { email: "tenant-admin-person@example.test" });
    await seedMembership(tenantA.id, tenantAdmin.userId, "admin");

    const ownTenant = await call(`/api/v1/tenants/${tenantA.id}/memberships`, tenantAdmin, {
      method: "POST",
      body: JSON.stringify({ email: "invited-by-tenant-admin@example.test", standing: "user" }),
    });
    expect(ownTenant.status).toBe(201);

    const otherTenant = await call(`/api/v1/tenants/${tenantB.id}/memberships`, tenantAdmin, {
      method: "POST",
      body: JSON.stringify({ email: "should-not-be-invited@example.test", standing: "user" }),
    });
    expect(otherTenant.status).toBe(403);
    await expect(otherTenant.json()).resolves.toEqual({ error: "forbidden" });
  });

  it("a plain tenant member (standing 'user') cannot invite anyone", async () => {
    const tenant = await seedTenant("Member Only Org");
    const member = await signInAs(env, { email: "plain-member@example.test" });
    await seedMembership(tenant.id, member.userId, "user");

    const response = await call(`/api/v1/tenants/${tenant.id}/memberships`, member, {
      method: "POST",
      body: JSON.stringify({ email: "x@example.test", standing: "user" }),
    });
    expect(response.status).toBe(403);
  });
});

describe("PATCH /api/v1/tenants/:tenantId/memberships/:id", () => {
  it("changes standing and audits USER_STANDING_CHANGED with before/after", async () => {
    const tenant = await seedTenant("Standing Org");
    const invited = (await (
      await call(`/api/v1/tenants/${tenant.id}/memberships`, staffAdmin, {
        method: "POST",
        body: JSON.stringify({ email: "promote-me@example.test", standing: "user" }),
      })
    ).json()) as Membership;

    const response = await call(
      `/api/v1/tenants/${tenant.id}/memberships/${invited.id}`,
      staffAdmin,
      {
        method: "PATCH",
        body: JSON.stringify({ standing: "admin" }),
      },
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as Membership).standing).toBe("admin");

    const events = await auditFor("membership", invited.id);
    const changed = events.find((e) => e.eventType === "USER_STANDING_CHANGED");
    expect(changed?.before).toMatchObject({ standing: "user" });
    expect(changed?.after).toMatchObject({ standing: "admin" });
  });

  it("404s a membership from a different tenant", async () => {
    const tenantA = await seedTenant("PATCH Tenant A");
    const tenantB = await seedTenant("PATCH Tenant B");
    const invited = (await (
      await call(`/api/v1/tenants/${tenantA.id}/memberships`, staffAdmin, {
        method: "POST",
        body: JSON.stringify({ email: "cross-tenant@example.test", standing: "user" }),
      })
    ).json()) as Membership;

    const response = await call(
      `/api/v1/tenants/${tenantB.id}/memberships/${invited.id}`,
      staffAdmin,
      {
        method: "PATCH",
        body: JSON.stringify({ standing: "admin" }),
      },
    );
    expect(response.status).toBe(404);
  });
});

describe("DELETE /api/v1/tenants/:tenantId/memberships/:id", () => {
  it("revokes, keeps the row, and audits USER_REMOVED", async () => {
    const tenant = await seedTenant("Revoke Org");
    const invited = (await (
      await call(`/api/v1/tenants/${tenant.id}/memberships`, staffAdmin, {
        method: "POST",
        body: JSON.stringify({ email: "revoke-me@example.test", standing: "user" }),
      })
    ).json()) as Membership;

    const response = await call(
      `/api/v1/tenants/${tenant.id}/memberships/${invited.id}`,
      staffAdmin,
      {
        method: "DELETE",
      },
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as Membership).status).toBe("revoked");

    const row = await env.DB.prepare("SELECT status FROM tenant_memberships WHERE id = ?")
      .bind(invited.id)
      .first<{ status: string }>();
    expect(row?.status).toBe("revoked");

    const events = await auditFor("membership", invited.id);
    expect(events.filter((e) => e.eventType === "USER_REMOVED")).toHaveLength(1);

    // Revoking again is a no-op, not a second audit event.
    const again = await call(`/api/v1/tenants/${tenant.id}/memberships/${invited.id}`, staffAdmin, {
      method: "DELETE",
    });
    expect(again.status).toBe(200);
    const eventsAfter = await auditFor("membership", invited.id);
    expect(eventsAfter.filter((e) => e.eventType === "USER_REMOVED")).toHaveLength(1);
  });
});
