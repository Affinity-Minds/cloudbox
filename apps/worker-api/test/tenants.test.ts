import { env } from "cloudflare:test";
import type { Tenant, TenantDetailScreen, TenantsScreen } from "@cloudbox/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { countingD1 } from "./counting-d1";
import { type SignedIn, seedDevice, seedSubscription, signInAs } from "./fixtures";

let admin: SignedIn;
let reader: SignedIn;

beforeAll(async () => {
  admin = await signInAs(env, { email: "tenants-admin@example.test", staffRole: "admin" });
  reader = await signInAs(env, { email: "tenants-reader@example.test", staffRole: "read_only" });
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

const createTenant = (who: SignedIn | null, body: Record<string, unknown>) =>
  call("/api/v1/tenants", who, { method: "POST", body: JSON.stringify(body) });

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

async function findMemberships(tenantId: string) {
  const { results } = await env.DB.prepare(
    "SELECT id, tenant_id, user_id, standing, status, invited_by FROM tenant_memberships WHERE tenant_id = ? ORDER BY rowid",
  )
    .bind(tenantId)
    .all<{
      id: string;
      tenant_id: string;
      user_id: string;
      standing: string;
      status: string;
      invited_by: string | null;
    }>();
  return results;
}

async function findCustomerByEmail(email: string) {
  return env.DB.prepare("SELECT id, email, name FROM customer_users WHERE email = ?")
    .bind(email.toLowerCase())
    .first<{ id: string; email: string; name: string }>();
}

describe("POST /api/v1/tenants", () => {
  it("allocates sequential CBX codes atomically and audits TENANT_CREATED", async () => {
    const first = await createTenant(admin, {
      displayName: "Example Org",
      primaryContactEmail: "example-org-owner@example.test",
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as Tenant;
    expect(firstBody.publicCode).toMatch(/^CBX-\d{5}$/);
    expect(firstBody.status).toBe("provisioning");

    const second = await createTenant(admin, {
      displayName: "Second Org",
      primaryContactEmail: "second-org-owner@example.test",
    });
    const secondBody = (await second.json()) as Tenant;
    expect(Number(secondBody.publicCode.slice(4))).toBe(Number(firstBody.publicCode.slice(4)) + 1);

    const events = await auditFor("tenant", firstBody.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "TENANT_CREATED",
      before: null,
      after: { publicCode: firstBody.publicCode, displayName: "Example Org" },
    });
  });

  it("403s a read_only staff member (permission boundary) and 401s anonymous", async () => {
    expect((await createTenant(null, { displayName: "Nope" })).status).toBe(401);
    const denied = await createTenant(reader, { displayName: "Nope" });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toEqual({ error: "forbidden" });
  });

  it("rejects an invalid body with the error shape", async () => {
    const response = await createTenant(admin, {
      displayName: "",
      primaryContactEmail: "invalid-org@example.test",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
  });

  it("rejects a tenant with no primary contact email — required from now on", async () => {
    const response = await createTenant(admin, { displayName: "No Contact Org" });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
  });

  it("appears in the screens/tenants loader in at most three D1 round trips", async () => {
    const created = (await (
      await createTenant(admin, {
        displayName: "Loader Org",
        primaryContactEmail: "loader-org-owner@example.test",
      })
    ).json()) as Tenant;

    const counted = countingD1(env.DB);
    const response = await app.request(
      "/api/v1/screens/tenants",
      { headers: admin.headers },
      { ...env, DB: counted },
    );
    expect(response.status).toBe(200);
    expect(counted.roundTrips).toBeLessThanOrEqual(3);

    const body = (await response.json()) as TenantsScreen;
    const row = body.items.find((item) => item.id === created.id);
    expect(row).toMatchObject({
      publicCode: created.publicCode,
      displayName: "Loader Org",
      status: "provisioning",
      deviceCount: 0,
      // 1, not 0: the primary contact is auto-provisioned as member 1 (standing owner) at
      // creation (owner decision, follow-up to WT-2).
      memberCount: 1,
      nextSubscriptionExpiry: null,
      health: "unknown",
    });
    expect(body.facets.status.some((f) => f.value === "provisioning")).toBe(true);
  });

  it("counts a real member, device and subscription against the right tenant (not the other way round)", async () => {
    // Regression guard: the correlated-subquery counts once compared the OUTER tenant id against
    // the SUBQUERY's own same-named column (e.g. tenant_memberships.id) instead of its tenant_id,
    // because Drizzle's `sql` tag doesn't always qualify an interpolated outer Column with its
    // table name inside a nested subquery — so every count came back 0 while the DB held real
    // rows. A tenant with no related rows can't catch that; this one has one of each.
    const tenant = (await (
      await createTenant(admin, {
        displayName: "Counted Org",
        primaryContactEmail: "counted-org-owner@example.test",
      })
    ).json()) as Tenant;

    const invited = await call(`/api/v1/tenants/${tenant.id}/memberships`, admin, {
      method: "POST",
      body: JSON.stringify({ email: "counted-member@example.test", standing: "owner" }),
    });
    expect(invited.status).toBe(201);

    await seedDevice(env.DB, { tenantId: tenant.id });
    await seedSubscription(env.DB, { tenantId: tenant.id, validUntil: "2027-06-01T00:00:00.000Z" });

    const body = (await (await call("/api/v1/screens/tenants", admin)).json()) as TenantsScreen;
    const row = body.items.find((item) => item.id === tenant.id);
    expect(row).toMatchObject({
      deviceCount: 1,
      // 2: the auto-provisioned primary-contact owner, plus the explicit invite above.
      memberCount: 2,
      nextSubscriptionExpiry: "2027-06-01T00:00:00.000Z",
    });
  });

  it("filters by status, plan and free text", async () => {
    await createTenant(admin, {
      displayName: "Filter Me Org",
      primaryContactEmail: "filter-me-owner@example.test",
      planCode: "cloudbox-6",
    });
    const byQuery = await call("/api/v1/screens/tenants?q=Filter%20Me", admin);
    const byQueryBody = (await byQuery.json()) as TenantsScreen;
    expect(byQueryBody.items.every((i) => i.displayName.includes("Filter Me"))).toBe(true);
    expect(byQueryBody.items.length).toBeGreaterThan(0);

    const byPlan = await call("/api/v1/screens/tenants?plan=cloudbox-6", admin);
    const byPlanBody = (await byPlan.json()) as TenantsScreen;
    expect(byPlanBody.items.every((i) => i.planCode === "cloudbox-6")).toBe(true);
  });

  it("gates the screens loader by tenant.view (a customer session is not read: 401)", async () => {
    const customer = await signInAs(env, { email: "tenants-customer@example.test" });
    const response = await call("/api/v1/screens/tenants", customer);
    expect(response.status).toBe(401);
  });
});

describe("PATCH /api/v1/tenants/:tenantId", () => {
  it("updates fields and audits TENANT_UPDATED with before/after", async () => {
    const created = (await (
      await createTenant(admin, {
        displayName: "Patchable Org",
        primaryContactEmail: "patchable-org-owner@example.test",
        notes: "before",
      })
    ).json()) as Tenant;

    const response = await call(`/api/v1/tenants/${created.id}`, admin, {
      method: "PATCH",
      body: JSON.stringify({ displayName: "Patched Org", notes: "after" }),
    });
    expect(response.status).toBe(200);
    const updated = (await response.json()) as Tenant;
    expect(updated).toMatchObject({ displayName: "Patched Org", notes: "after" });

    const events = await auditFor("tenant", created.id);
    const patchEvent = events.find((e) => e.eventType === "TENANT_UPDATED");
    expect(patchEvent?.before).toMatchObject({ displayName: "Patchable Org", notes: "before" });
    expect(patchEvent?.after).toMatchObject({ displayName: "Patched Org", notes: "after" });
  });

  it("404s an unknown tenant", async () => {
    const response = await call("/api/v1/tenants/ten_missing", admin, {
      method: "PATCH",
      body: JSON.stringify({ displayName: "x" }),
    });
    expect(response.status).toBe(404);
  });
});

describe("POST /api/v1/tenants/:tenantId/archive", () => {
  async function seedArchiveCandidate() {
    const created = (await (
      await createTenant(admin, {
        displayName: "Archive Candidate",
        primaryContactEmail: "archive-candidate-owner@example.test",
      })
    ).json()) as Tenant;
    // Fresh tenants start "provisioning"; move to "active" so it looks like a real, in-use tenant.
    await call(`/api/v1/tenants/${created.id}`, admin, {
      method: "PATCH",
      body: JSON.stringify({ status: "active" }),
    });
    return created;
  }

  const archiveBody = JSON.stringify({ reasonCode: "churned" });

  it("refuses with a reason when a device is still enrolled", async () => {
    const tenant = await seedArchiveCandidate();
    await seedDevice(env.DB, { tenantId: tenant.id });

    const response = await call(`/api/v1/tenants/${tenant.id}/archive`, admin, {
      method: "POST",
      body: archiveBody,
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; detail: string };
    expect(body.error).toBe("conflict");
    expect(body.detail).toMatch(/device/i);
  });

  it("refuses with a reason when an open subscription exists", async () => {
    const tenant = await seedArchiveCandidate();
    await seedSubscription(env.DB, { tenantId: tenant.id, validUntil: "2027-01-01T00:00:00.000Z" });

    const response = await call(`/api/v1/tenants/${tenant.id}/archive`, admin, {
      method: "POST",
      body: archiveBody,
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; detail: string };
    expect(body.detail).toMatch(/subscription/i);
  });

  it("archives cleanly and audits TENANT_ARCHIVED with the reason code and text", async () => {
    const tenant = await seedArchiveCandidate();
    const response = await call(`/api/v1/tenants/${tenant.id}/archive`, admin, {
      method: "POST",
      body: JSON.stringify({ reasonCode: "other", reasonText: "Business closed down" }),
    });
    expect(response.status).toBe(200);
    const archived = (await response.json()) as Tenant;
    expect(archived.status).toBe("archived");
    expect(archived.archivedAt).not.toBeNull();

    const events = await auditFor("tenant", tenant.id);
    const archiveEvent = events.find((e) => e.eventType === "TENANT_ARCHIVED");
    expect(archiveEvent?.before).toMatchObject({ status: "active" });
    expect(archiveEvent?.after).toMatchObject({
      status: "archived",
      reasonCode: "other",
      reasonText: "Business closed down",
      reason: "other: Business closed down",
    });

    // Idempotent-ish: archiving again is a conflict, not a silent 200.
    const again = await call(`/api/v1/tenants/${tenant.id}/archive`, admin, {
      method: "POST",
      body: archiveBody,
    });
    expect(again.status).toBe(409);
  });

  it("reason-code shape: missing/invalid code and other-without-text are 400", async () => {
    const tenant = await seedArchiveCandidate();

    expect(
      (await call(`/api/v1/tenants/${tenant.id}/archive`, admin, { method: "POST", body: "{}" }))
        .status,
    ).toBe(400);
    expect(
      (
        await call(`/api/v1/tenants/${tenant.id}/archive`, admin, {
          method: "POST",
          body: JSON.stringify({ reasonCode: "not_a_real_code" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(`/api/v1/tenants/${tenant.id}/archive`, admin, {
          method: "POST",
          body: JSON.stringify({ reasonCode: "other" }),
        })
      ).status,
    ).toBe(400);
  });
});

describe("GET /api/v1/screens/tenants/:tenantId", () => {
  it("returns tenant, memberships, devices, subscriptions and audit in one round trip", async () => {
    const tenant = (await (
      await createTenant(admin, {
        displayName: "Detail Org",
        primaryContactEmail: "detail-org-owner@example.test",
      })
    ).json()) as Tenant;

    const counted = countingD1(env.DB);
    const response = await app.request(
      `/api/v1/screens/tenants/${tenant.id}`,
      { headers: admin.headers },
      { ...env, DB: counted },
    );
    expect(response.status).toBe(200);
    expect(counted.roundTrips).toBeLessThanOrEqual(3);

    const body = (await response.json()) as TenantDetailScreen;
    expect(body.tenant.id).toBe(tenant.id);
    // Not []: the primary contact is auto-provisioned as member 1 (standing owner).
    expect(body.memberships).toHaveLength(1);
    expect(body.memberships[0]).toMatchObject({
      tenantId: tenant.id,
      email: "detail-org-owner@example.test",
      standing: "owner",
      status: "active",
    });
    expect(body.devices).toEqual([]);
    expect(body.subscriptions).toEqual([]);
    // Inserted after TENANT_CREATED in the same atomic write, so it has the later rowid and
    // sorts first (desc).
    expect(body.auditEvents[0]).toMatchObject({ eventType: "USER_INVITED" });
    expect(body.auditEvents[1]).toMatchObject({ eventType: "TENANT_CREATED" });
  });

  it("404s an unknown tenant", async () => {
    const response = await call("/api/v1/screens/tenants/ten_missing", admin);
    expect(response.status).toBe(404);
  });
});

describe("POST /api/v1/tenants: the primary contact becomes the first Owner member", () => {
  it("creates the customer identity and an active Owner membership, atomically with the tenant", async () => {
    const email = "primary-owner-1@example.test";
    const created = (await (
      await createTenant(admin, { displayName: "Owner Org", primaryContactEmail: email })
    ).json()) as Tenant;

    const customer = await findCustomerByEmail(email);
    expect(customer).toBeTruthy();

    const memberships = await findMemberships(created.id);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({
      tenant_id: created.id,
      user_id: customer?.id,
      standing: "owner",
      status: "active",
      invited_by: admin.userId,
    });

    const events = await auditFor("membership", memberships[0]?.id ?? "");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "USER_INVITED",
      before: null,
      after: { standing: "owner", status: "active", userId: customer?.id },
    });
  });

  it("reuses the existing customer user when a second tenant shares the same primary contact", async () => {
    const email = "shared-owner@example.test";
    const first = (await (
      await createTenant(admin, { displayName: "First Shared Org", primaryContactEmail: email })
    ).json()) as Tenant;
    const second = (await (
      await createTenant(admin, { displayName: "Second Shared Org", primaryContactEmail: email })
    ).json()) as Tenant;

    const [firstMembership] = await findMemberships(first.id);
    const [secondMembership] = await findMemberships(second.id);
    expect(firstMembership?.user_id).toBeTruthy();
    expect(secondMembership?.user_id).toBe(firstMembership?.user_id);

    const { results } = await env.DB.prepare("SELECT id FROM customer_users WHERE email = ?")
      .bind(email)
      .all();
    expect(results).toHaveLength(1);
  });

  it("a PATCH that changes primaryContactEmail does not touch memberships", async () => {
    const oldEmail = "old-contact@example.test";
    const newEmail = "new-contact@example.test";
    const created = (await (
      await createTenant(admin, {
        displayName: "Contact Change Org",
        primaryContactEmail: oldEmail,
      })
    ).json()) as Tenant;

    const before = await findMemberships(created.id);
    expect(before).toHaveLength(1);

    const patched = await call(`/api/v1/tenants/${created.id}`, admin, {
      method: "PATCH",
      body: JSON.stringify({ primaryContactEmail: newEmail }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as Tenant).primaryContactEmail).toBe(newEmail);

    // The old owner is untouched: same rows, same standing/status.
    const after = await findMemberships(created.id);
    expect(after).toEqual(before);

    // The new contact was never provisioned: PATCH never calls ensureCustomerByEmail.
    const newContact = await findCustomerByEmail(newEmail);
    expect(newContact).toBeNull();
  });

  it("refuses to create a tenant with no primary contact email", async () => {
    const response = await createTenant(admin, { displayName: "No Contact Org 2" });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
  });

  it("the last-active-owner guard counts the auto-created owner (review U-2/L-8)", async () => {
    const email = "sole-owner@example.test";
    const created = (await (
      await createTenant(admin, { displayName: "Sole Owner Org", primaryContactEmail: email })
    ).json()) as Tenant;
    const [membership] = await findMemberships(created.id);
    if (!membership) throw new Error("expected the auto-created owner membership to exist");

    const response = await call(
      `/api/v1/tenants/${created.id}/memberships/${membership.id}`,
      admin,
      { method: "DELETE", body: JSON.stringify({ reasonCode: "role_change" }) },
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "last_owner" });

    const [stillThere] = await findMemberships(created.id);
    expect(stillThere?.status).toBe("active");
  });
});
