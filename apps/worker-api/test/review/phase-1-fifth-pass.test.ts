// WT-8 fifth pass (docs/reviews/phase-1-security.md, "Fifth pass / final verdict"): identity
// separation. Asserts the SECURE behaviour; a failing test is an open finding.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../../src/index";
import { opsBasePath } from "../../src/ops-shell";
import { seedMembership, seedTenant, signInAs } from "../fixtures";

const req = (path: string, headers: Record<string, string>, method = "GET", body?: unknown) =>
  app.request(
    path,
    {
      method,
      headers: { ...headers, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );

describe("V-1 (holds): a customer cookie never reaches staff scope, and vice versa", () => {
  it("customer (tenant owner) gets 401 on staff permission routes", async () => {
    const t = await seedTenant(env.DB);
    const cust = await signInAs(env, { email: "v1-cust@example.test" });
    await seedMembership(env.DB, { tenantId: t.tenantId, userId: cust.userId, standing: "owner" });
    for (const path of [
      "/api/v1/staff",
      "/api/v1/screens/audit",
      "/api/v1/screens/overview",
      "/api/v1/plans",
    ]) {
      expect((await req(path, cust.headers)).status).toBe(401);
    }
  });

  it("a super admin (staff cookie) has no tenant standing and no customer routes", async () => {
    const t = await seedTenant(env.DB);
    const staff = await signInAs(env, { email: "v1-staff@example.test", staffRole: "super_admin" });
    expect((await req("/api/v1/me/tenants", staff.headers)).status).toBe(401);
    const sw = await req("/api/v1/me/active-tenant", staff.headers, "POST", {
      tenantId: t.tenantId,
    });
    expect(sw.status).toBe(401);
  });

  it("both cookies at once: a customer admin plus a read_only staff member cannot combine scopes", async () => {
    const t = await seedTenant(env.DB);
    const cust = await signInAs(env, { email: "v1-both-c@example.test" });
    await seedMembership(env.DB, { tenantId: t.tenantId, userId: cust.userId, standing: "user" });
    const staff = await signInAs(env, { email: "v1-both-s@example.test", staffRole: "read_only" });
    const both = { ...cust.headers, cookie: `${cust.cookie}; ${staff.cookie}` };
    // read_only lacks tenant.manage; the customer is only 'user': neither may invite.
    const res = await req(`/api/v1/tenants/${t.tenantId}/memberships`, both, "POST", {
      email: "v1-invitee@example.test",
      standing: "owner",
    });
    expect(res.status).toBe(403);
    // Nor may the customer reach a staff screen by riding along with the staff cookie.
    expect((await req("/api/v1/staff", both)).status).toBe(403);
  });
});

describe("V-2 (holds): OPS_BASE_PATH is a single safe segment", () => {
  it("rejects traversal, multi-segment and empty values", () => {
    for (const bad of ["", " ", "/", "/../x", "/a/b", "ops", "/ops.", "/%2e%2e"]) {
      expect(opsBasePath({ OPS_BASE_PATH: bad })).toBe("/ops");
    }
    expect(opsBasePath({ OPS_BASE_PATH: "/k7-console" })).toBe("/k7-console");
  });
  it("(Low) does not accept a base that collides with /api or /assets", () => {
    expect(opsBasePath({ OPS_BASE_PATH: "/api" })).toBe("/ops");
    expect(opsBasePath({ OPS_BASE_PATH: "/assets" })).toBe("/ops");
  });
});
