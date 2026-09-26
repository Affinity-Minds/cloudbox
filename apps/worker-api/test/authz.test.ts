import { env } from "cloudflare:test";
import type { SessionResponse } from "@cloudbox/contracts";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { requireStaff, requireUser } from "../src/auth/middleware";
import { requirePermission, requireTenantStanding } from "../src/authz/permissions";
import type { AppEnv } from "../src/env";
import app from "../src/index";
import { signInAs } from "./auth-fixtures";

const get = (path: string, headers: Record<string, string> = {}) =>
  app.request(path, { headers }, env);

describe("requireUser / session", () => {
  it("answers 401 unauthenticated without a session", async () => {
    const response = await get("/api/v1/auth/session");
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthenticated" });
  });

  it("answers 401 for a forged or unknown session cookie", async () => {
    const response = await get("/api/v1/auth/session", {
      cookie: "better-auth.session_token=forged.signature",
    });
    expect(response.status).toBe(401);
  });

  it("returns the user, staff role and permissions from rows", async () => {
    const { headers } = await signInAs(env, {
      email: "Support.Person@Example.test",
      staffRole: "support",
    });
    const response = await get("/api/v1/auth/session", headers);
    expect(response.status).toBe(200);
    const body = (await response.json()) as SessionResponse;
    expect(body.user).toMatchObject({ email: "support.person@example.test", staffRole: "support" });
    expect(body.permissions).toContain("device.command");
    expect(body.permissions).not.toContain("tenant.manage");
    expect(body.activeTenantId).toBeNull();
  });

  it("reports a signed-in non-staff user with no permissions", async () => {
    const { headers } = await signInAs(env, { email: "customer@example.test" });
    const body = (await (await get("/api/v1/auth/session", headers)).json()) as SessionResponse;
    expect(body.user.staffRole).toBeNull();
    expect(body.permissions).toEqual([]);
  });

  it("logout revokes the session: the same cookie is 401 afterwards, and it is audited", async () => {
    const signedIn = await signInAs(env, { email: "leaver@example.test", staffRole: "read_only" });
    const out = await app.request(
      "/api/v1/auth/logout",
      { method: "POST", headers: signedIn.headers },
      env,
    );
    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toMatch(/session_token=;/);
    expect((await get("/api/v1/auth/session", signedIn.headers)).status).toBe(401);

    const row = await env.DB.prepare(
      "SELECT actor_id FROM audit_log WHERE event_type = 'AUTH_LOGOUT' AND entity_id = ?",
    )
      .bind(signedIn.userId)
      .first<{ actor_id: string }>();
    expect(row?.actor_id).toBe(signedIn.userId);
  });

  it("routes Better Auth's own sign-out through the audited logout", async () => {
    const signedIn = await signInAs(env, { email: "leaver2@example.test" });
    const out = await app.request(
      "/api/auth/sign-out",
      { method: "POST", headers: signedIn.headers },
      env,
    );
    expect(out.status).toBe(204);
    expect((await get("/api/v1/auth/session", signedIn.headers)).status).toBe(401);
  });

  it("refuses a cookie-authenticated write from a foreign origin", async () => {
    const signedIn = await signInAs(env, { email: "csrf@example.test" });
    const response = await app.request(
      "/api/v1/auth/logout",
      { method: "POST", headers: { cookie: signedIn.cookie, origin: "https://evil.example" } },
      env,
    );
    expect(response.status).toBe(403);
    expect((await get("/api/v1/auth/session", signedIn.headers)).status).toBe(200);
  });
});

describe("review L-1 / L-3", () => {
  it("L-1: the Vite dev origin is not trusted in production", async () => {
    const signedIn = await signInAs(env, { email: "vite-origin@example.test" });
    const prod = { ...env, ENVIRONMENT: "production" as const };
    const fromVite = await app.request(
      "/api/v1/auth/logout",
      { method: "POST", headers: { cookie: signedIn.cookie, origin: "http://localhost:5173" } },
      prod,
    );
    expect(fromVite.status).toBe(403);
    const inDev = await app.request(
      "/api/v1/auth/logout",
      { method: "POST", headers: { cookie: signedIn.cookie, origin: "http://localhost:5173" } },
      env,
    );
    expect(inDev.status).toBe(204);
  });

  it("L-3: a client X-Correlation-Id is echoed but never written to audit rows", async () => {
    const signedIn = await signInAs(env, { email: "corr@example.test" });
    const out = await app.request(
      "/api/v1/auth/logout",
      { method: "POST", headers: { ...signedIn.headers, "x-correlation-id": "planted-corr-0001" } },
      env,
    );
    expect(out.status).toBe(204);
    expect(out.headers.get("x-correlation-id")).toBe("planted-corr-0001");
    const serverId = out.headers.get("x-request-id");
    expect(serverId).toMatch(/^[0-9a-f-]{36}$/);
    const row = await env.DB.prepare(
      "SELECT correlation_id FROM audit_log WHERE event_type = 'AUTH_LOGOUT' AND entity_id = ?",
    )
      .bind(signedIn.userId)
      .first<{ correlation_id: string }>();
    expect(row?.correlation_id).toBe(serverId);
  });
});

describe("requirePermission", () => {
  const probe = new Hono<AppEnv>();
  probe.get("/staff-only", requireStaff(), (c) => c.json({ ok: true, user: c.var.user }));
  probe.get("/audit", requirePermission("audit.view"), (c) => c.json({ ok: true }));
  probe.get("/staff-manage", requirePermission("staff.manage"), (c) => c.json({ ok: true }));
  probe.get("/any-user", requireUser(), (c) => c.json({ id: c.var.user.id }));
  const call = (path: string, headers: Record<string, string> = {}) =>
    probe.request(path, { headers }, env);

  it("401 without a session, 403 for a non-staff user, 200 with the grant", async () => {
    expect((await call("/audit")).status).toBe(401);
    const customer = await signInAs(env, { email: "perm-customer@example.test" });
    expect((await call("/any-user", customer.headers)).status).toBe(200);
    const denied = await call("/staff-only", customer.headers);
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toEqual({ error: "forbidden" });
    expect((await call("/audit", customer.headers)).status).toBe(403);

    const reader = await signInAs(env, {
      email: "perm-reader@example.test",
      staffRole: "read_only",
    });
    expect((await call("/staff-only", reader.headers)).status).toBe(200);
    expect((await call("/audit", reader.headers)).status).toBe(200);
    expect((await call("/staff-manage", reader.headers)).status).toBe(403);
  });

  it("admin is denied staff.manage by the seed; super admin holds it", async () => {
    const admin = await signInAs(env, { email: "perm-admin@example.test", staffRole: "admin" });
    expect((await call("/staff-manage", admin.headers)).status).toBe(403);
    const root = await signInAs(env, { email: "perm-root@example.test", staffRole: "super_admin" });
    expect((await call("/staff-manage", root.headers)).status).toBe(200);
  });

  it("super admin permissions are rows: deleting one denies the super admin on the next request", async () => {
    const root = await signInAs(env, { email: "rows-root@example.test", staffRole: "super_admin" });
    expect((await call("/audit", root.headers)).status).toBe(200);

    await env.DB.prepare(
      "DELETE FROM role_permissions WHERE role = 'super_admin' AND permission_key = 'audit.view'",
    ).run();
    try {
      const denied = await call("/audit", root.headers);
      expect(denied.status).toBe(403);
      await expect(denied.json()).resolves.toEqual({ error: "forbidden" });
      // The real screen route too.
      expect((await get("/api/v1/screens/audit", root.headers)).status).toBe(403);
    } finally {
      await env.DB.prepare(
        "INSERT INTO role_permissions (role, permission_key) VALUES ('super_admin', 'audit.view')",
      ).run();
    }
    expect((await call("/audit", root.headers)).status).toBe(200);
  });

  it("a revoked staff row takes effect on the next request", async () => {
    const reader = await signInAs(env, { email: "revoked@example.test", staffRole: "read_only" });
    expect((await call("/staff-only", reader.headers)).status).toBe(200);
    await env.DB.prepare("DELETE FROM staff_members WHERE user_id = ?").bind(reader.userId).run();
    expect((await call("/staff-only", reader.headers)).status).toBe(403);
  });
});

describe("requireTenantStanding", () => {
  const probe = new Hono<AppEnv>();
  const tenantRoutes = new Hono<AppEnv>();
  tenantRoutes.get("/member", requireTenantStanding("user"), (c) => c.json({ ok: true }));
  tenantRoutes.post("/manage", requireTenantStanding("admin"), (c) => c.json({ ok: true }));
  tenantRoutes.get("/own", requireTenantStanding("owner"), (c) => c.json({ ok: true }));
  // Same nesting as routes/v1/index.ts: the param lives in the mount prefix.
  probe.route("/tenants/:tenantId/things", tenantRoutes);

  async function seedTenant(id: string, code: string) {
    await env.DB.prepare(
      "INSERT INTO tenants (id, public_code, display_name, status) VALUES (?, ?, ?, 'active')",
    )
      .bind(id, code, `Tenant ${code}`)
      .run();
  }
  async function seedMembership(
    tenantId: string,
    userId: string,
    standing: string,
    status = "active",
  ) {
    await env.DB.prepare(
      "INSERT INTO tenant_memberships (id, tenant_id, user_id, standing, status) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(`mem_${crypto.randomUUID()}`, tenantId, userId, standing, status)
      .run();
  }

  it("resolves standing for the path tenant and ignores a body tenantId", async () => {
    await seedTenant("ten_a", "CBX-90001");
    await seedTenant("ten_b", "CBX-90002");
    const member = await signInAs(env, { email: "tenant-user@example.test" });
    const owner = await signInAs(env, { email: "tenant-owner@example.test" });
    const former = await signInAs(env, { email: "tenant-former@example.test" });
    await seedMembership("ten_a", member.userId, "user");
    await seedMembership("ten_a", owner.userId, "owner");
    await seedMembership("ten_b", owner.userId, "admin");
    await seedMembership("ten_a", former.userId, "owner", "revoked");

    const call = (path: string, headers: Record<string, string>, init: RequestInit = {}) =>
      probe.request(path, { ...init, headers }, env);

    expect((await call("/tenants/ten_a/things/member", {})).status).toBe(401);
    expect((await call("/tenants/ten_a/things/member", member.headers)).status).toBe(200);
    expect((await call("/tenants/ten_a/things/own", member.headers)).status).toBe(403);
    // Tenant boundary: a member of A is nobody in B, whatever the body says.
    const crossTenant = await call("/tenants/ten_b/things/manage", member.headers, {
      method: "POST",
      body: JSON.stringify({ tenantId: "ten_a" }),
    });
    expect(crossTenant.status).toBe(403);
    await expect(crossTenant.json()).resolves.toEqual({ error: "forbidden" });

    expect((await call("/tenants/ten_a/things/own", owner.headers)).status).toBe(200);
    expect(
      (await call("/tenants/ten_b/things/manage", owner.headers, { method: "POST" })).status,
    ).toBe(200);
    expect((await call("/tenants/ten_b/things/own", owner.headers)).status).toBe(403);
    // A revoked membership grants nothing.
    expect((await call("/tenants/ten_a/things/member", former.headers)).status).toBe(403);
  });
});
