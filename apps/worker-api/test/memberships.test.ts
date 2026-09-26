import { env } from "cloudflare:test";
import type { Membership } from "@cloudbox/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { type SignedIn, seedMembership, seedTenant, signInAs } from "./fixtures";

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
    const tenant = await seedTenant(env.DB, { displayName: "Invite Org" });
    const response = await call(`/api/v1/tenants/${tenant.tenantId}/memberships`, staffAdmin, {
      method: "POST",
      body: JSON.stringify({ email: "New.Invitee@example.test", standing: "owner" }),
    });
    expect(response.status).toBe(201);
    const membership = (await response.json()) as Membership;
    expect(membership).toMatchObject({
      tenantId: tenant.tenantId,
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
    const tenant = await seedTenant(env.DB, { displayName: "Reuse Org" });
    const existing = await signInAs(env, { email: "reused-person@example.test" });

    const response = await call(`/api/v1/tenants/${tenant.tenantId}/memberships`, staffAdmin, {
      method: "POST",
      body: JSON.stringify({ email: "reused-person@example.test", standing: "user" }),
    });
    expect(response.status).toBe(201);
    const membership = (await response.json()) as Membership;
    expect(membership.userId).toBe(existing.userId);
  });

  it("409s inviting the same active member twice", async () => {
    const tenant = await seedTenant(env.DB, { displayName: "Duplicate Org" });
    const body = JSON.stringify({ email: "dup@example.test", standing: "user" });
    const first = await call(`/api/v1/tenants/${tenant.tenantId}/memberships`, staffAdmin, {
      method: "POST",
      body,
    });
    expect(first.status).toBe(201);
    const second = await call(`/api/v1/tenants/${tenant.tenantId}/memberships`, staffAdmin, {
      method: "POST",
      body,
    });
    expect(second.status).toBe(409);
  });

  it("401s anonymous and 403s a staff member without tenant.manage or tenant standing", async () => {
    const tenant = await seedTenant(env.DB, { displayName: "Guarded Org" });
    const path = `/api/v1/tenants/${tenant.tenantId}/memberships`;
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
    const tenantA = await seedTenant(env.DB, { displayName: "Tenant A" });
    const tenantB = await seedTenant(env.DB, { displayName: "Tenant B" });
    const tenantAdmin = await signInAs(env, { email: "tenant-admin-person@example.test" });
    await seedMembership(env.DB, {
      tenantId: tenantA.tenantId,
      userId: tenantAdmin.userId,
      standing: "admin",
    });

    const ownTenant = await call(`/api/v1/tenants/${tenantA.tenantId}/memberships`, tenantAdmin, {
      method: "POST",
      body: JSON.stringify({ email: "invited-by-tenant-admin@example.test", standing: "user" }),
    });
    expect(ownTenant.status).toBe(201);

    const otherTenant = await call(`/api/v1/tenants/${tenantB.tenantId}/memberships`, tenantAdmin, {
      method: "POST",
      body: JSON.stringify({ email: "should-not-be-invited@example.test", standing: "user" }),
    });
    expect(otherTenant.status).toBe(403);
    await expect(otherTenant.json()).resolves.toEqual({ error: "forbidden" });
  });

  it("a plain tenant member (standing 'user') cannot invite anyone", async () => {
    const tenant = await seedTenant(env.DB, { displayName: "Member Only Org" });
    const member = await signInAs(env, { email: "plain-member@example.test" });
    await seedMembership(env.DB, {
      tenantId: tenant.tenantId,
      userId: member.userId,
      standing: "user",
    });

    const response = await call(`/api/v1/tenants/${tenant.tenantId}/memberships`, member, {
      method: "POST",
      body: JSON.stringify({ email: "x@example.test", standing: "user" }),
    });
    expect(response.status).toBe(403);
  });
});

describe("PATCH /api/v1/tenants/:tenantId/memberships/:id", () => {
  it("changes standing and audits USER_STANDING_CHANGED with before/after", async () => {
    const tenant = await seedTenant(env.DB, { displayName: "Standing Org" });
    const invited = (await (
      await call(`/api/v1/tenants/${tenant.tenantId}/memberships`, staffAdmin, {
        method: "POST",
        body: JSON.stringify({ email: "promote-me@example.test", standing: "user" }),
      })
    ).json()) as Membership;

    const response = await call(
      `/api/v1/tenants/${tenant.tenantId}/memberships/${invited.id}`,
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
    const tenantA = await seedTenant(env.DB, { displayName: "PATCH Tenant A" });
    const tenantB = await seedTenant(env.DB, { displayName: "PATCH Tenant B" });
    const invited = (await (
      await call(`/api/v1/tenants/${tenantA.tenantId}/memberships`, staffAdmin, {
        method: "POST",
        body: JSON.stringify({ email: "cross-tenant@example.test", standing: "user" }),
      })
    ).json()) as Membership;

    const response = await call(
      `/api/v1/tenants/${tenantB.tenantId}/memberships/${invited.id}`,
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
    const tenant = await seedTenant(env.DB, { displayName: "Revoke Org" });
    const invited = (await (
      await call(`/api/v1/tenants/${tenant.tenantId}/memberships`, staffAdmin, {
        method: "POST",
        body: JSON.stringify({ email: "revoke-me@example.test", standing: "user" }),
      })
    ).json()) as Membership;

    const response = await call(
      `/api/v1/tenants/${tenant.tenantId}/memberships/${invited.id}`,
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
    const again = await call(
      `/api/v1/tenants/${tenant.tenantId}/memberships/${invited.id}`,
      staffAdmin,
      {
        method: "DELETE",
      },
    );
    expect(again.status).toBe(200);
    const eventsAfter = await auditFor("membership", invited.id);
    expect(eventsAfter.filter((e) => e.eventType === "USER_REMOVED")).toHaveLength(1);
  });
});

// Review U-2 (Medium): tenant standing was unranked, so a tenant admin could promote itself to
// owner and then revoke the real owner. Mirrors staff ranking (S-5): a tenant member may only
// grant a standing at or below its own, and may only change or revoke a membership whose current
// standing is strictly below its own (which also blocks touching its own membership). Staff with
// `tenant.manage` bypass the ranking entirely but not the last-active-owner guard (L-8 pattern).
describe("Standing ranking and the last-active-owner guard (review U-2)", () => {
  it("a tenant admin cannot invite someone as owner (cannot grant above its own standing)", async () => {
    const tenant = await seedTenant(env.DB, { displayName: "Rank Invite Org" });
    const tenantAdmin = await signInAs(env, { email: "rank-admin-invite@example.test" });
    await seedMembership(env.DB, {
      tenantId: tenant.tenantId,
      userId: tenantAdmin.userId,
      standing: "admin",
    });

    const response = await call(`/api/v1/tenants/${tenant.tenantId}/memberships`, tenantAdmin, {
      method: "POST",
      body: JSON.stringify({ email: "should-not-be-owner@example.test", standing: "owner" }),
    });
    expect(response.status).toBe(403);
  });

  it("a tenant owner can grant its own standing to someone else (at or below own is allowed)", async () => {
    const tenant = await seedTenant(env.DB, { displayName: "Rank Owner Invite Org" });
    const tenantOwner = await signInAs(env, { email: "rank-owner-invite@example.test" });
    await seedMembership(env.DB, {
      tenantId: tenant.tenantId,
      userId: tenantOwner.userId,
      standing: "owner",
    });

    const response = await call(`/api/v1/tenants/${tenant.tenantId}/memberships`, tenantOwner, {
      method: "POST",
      body: JSON.stringify({ email: "co-owner@example.test", standing: "owner" }),
    });
    expect(response.status).toBe(201);
  });

  it("staff with tenant.manage bypasses ranking: can promote an admin straight to owner", async () => {
    const tenant = await seedTenant(env.DB, { displayName: "Staff Promote Org" });
    const person = await signInAs(env, { email: "staff-promote-person@example.test" });
    const membership = await seedMembership(env.DB, {
      tenantId: tenant.tenantId,
      userId: person.userId,
      standing: "admin",
    });

    const response = await call(
      `/api/v1/tenants/${tenant.tenantId}/memberships/${membership.membershipId}`,
      staffAdmin,
      { method: "PATCH", body: JSON.stringify({ standing: "owner" }) },
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as Membership).standing).toBe("owner");
  });

  it("staff with tenant.manage still cannot revoke the tenant's only owner (409 last_owner)", async () => {
    const tenant = await seedTenant(env.DB, { displayName: "Staff Last Owner Org" });
    const owner = await signInAs(env, { email: "staff-last-owner-person@example.test" });
    const membership = await seedMembership(env.DB, {
      tenantId: tenant.tenantId,
      userId: owner.userId,
      standing: "owner",
    });

    const response = await call(
      `/api/v1/tenants/${tenant.tenantId}/memberships/${membership.membershipId}`,
      staffAdmin,
      { method: "DELETE" },
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "last_owner" });

    const row = await env.DB.prepare("SELECT status FROM tenant_memberships WHERE id = ?")
      .bind(membership.membershipId)
      .first<{ status: string }>();
    expect(row?.status).toBe("active");
  });

  it("staff with tenant.manage still cannot demote the tenant's only owner via PATCH (409 last_owner)", async () => {
    const tenant = await seedTenant(env.DB, { displayName: "Staff Demote Owner Org" });
    const owner = await signInAs(env, { email: "staff-demote-owner-person@example.test" });
    const membership = await seedMembership(env.DB, {
      tenantId: tenant.tenantId,
      userId: owner.userId,
      standing: "owner",
    });

    const response = await call(
      `/api/v1/tenants/${tenant.tenantId}/memberships/${membership.membershipId}`,
      staffAdmin,
      { method: "PATCH", body: JSON.stringify({ standing: "admin" }) },
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "last_owner" });

    const row = await env.DB.prepare("SELECT standing FROM tenant_memberships WHERE id = ?")
      .bind(membership.membershipId)
      .first<{ standing: string }>();
    expect(row?.standing).toBe("owner");
  });

  it("staff with tenant.manage can revoke an owner when another owner still exists", async () => {
    const tenant = await seedTenant(env.DB, { displayName: "Two Owners Staff Org" });
    const ownerA = await signInAs(env, { email: "two-owners-staff-a@example.test" });
    const ownerB = await signInAs(env, { email: "two-owners-staff-b@example.test" });
    const membershipA = await seedMembership(env.DB, {
      tenantId: tenant.tenantId,
      userId: ownerA.userId,
      standing: "owner",
    });
    await seedMembership(env.DB, {
      tenantId: tenant.tenantId,
      userId: ownerB.userId,
      standing: "owner",
    });

    const response = await call(
      `/api/v1/tenants/${tenant.tenantId}/memberships/${membershipA.membershipId}`,
      staffAdmin,
      { method: "DELETE" },
    );
    expect(response.status).toBe(200);
  });
});
