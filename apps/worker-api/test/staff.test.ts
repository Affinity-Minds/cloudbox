import { env } from "cloudflare:test";
import type { SessionResponse, StaffMember } from "@cloudbox/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { type SignedIn, signInAs } from "./auth-fixtures";

let root: SignedIn;
let admin: SignedIn;

beforeAll(async () => {
  root = await signInAs(env, { email: "root@example.test", staffRole: "super_admin" });
  admin = await signInAs(env, { email: "admin@example.test", staffRole: "admin" });
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

const INITIAL = "initial-password-0001";
const grant = (who: SignedIn | null, email: string, role: string, initialPassword?: string) =>
  call("/api/v1/staff", who, {
    method: "POST",
    body: JSON.stringify({ email, role, initialPassword }),
  });

async function auditFor(entityId: string) {
  const { results } = await env.DB.prepare(
    "SELECT event_type, actor_id, before_json, after_json FROM audit_log WHERE entity_type = 'staff_member' AND entity_id = ? ORDER BY rowid",
  )
    .bind(entityId)
    .all<{ event_type: string; actor_id: string; before_json: string; after_json: string }>();
  return results;
}

describe("staff management API", () => {
  it("is gated by staff.manage: 401 anonymous, 403 for admin", async () => {
    expect((await call("/api/v1/staff", null)).status).toBe(401);
    expect((await call("/api/v1/staff", admin)).status).toBe(403);
    expect((await grant(admin, "x@example.test", "support", INITIAL)).status).toBe(403);
    expect((await call(`/api/v1/staff/${root.userId}`, admin, { method: "DELETE" })).status).toBe(
      403,
    );
  });

  it("lists staff with emails and roles", async () => {
    const response = await call("/api/v1/staff", root);
    expect(response.status).toBe(200);
    const { items } = (await response.json()) as { items: StaffMember[] };
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: root.userId,
          email: "root@example.test",
          role: "super_admin",
        }),
        expect.objectContaining({ userId: admin.userId, role: "admin" }),
      ]),
    );
  });

  it("creates a new staff member with an initial password: one user row, then password sign-in", async () => {
    expect((await grant(root, "New.Support@Example.test", "support")).status).toBe(400);
    const created = await grant(root, "New.Support@Example.test", "support", INITIAL);
    expect(created.status).toBe(201);
    const member = (await created.json()) as StaffMember;
    expect(member).toMatchObject({
      email: "new.support@example.test",
      role: "support",
      createdBy: root.userId,
    });
    const users = await env.DB.prepare('SELECT count(*) AS n FROM "user" WHERE email = ?')
      .bind("new.support@example.test")
      .first<{ n: number }>();
    expect(users?.n).toBe(1);

    const signIn = await app.request(
      "/api/ops/auth/sign-in/email",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.9",
          origin: "http://localhost",
        },
        body: JSON.stringify({ email: "new.support@example.test", password: INITIAL }),
      },
      env,
    );
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const session = (await (
      await app.request("/api/v1/auth/session", { headers: { cookie } }, env)
    ).json()) as SessionResponse;
    expect(session.user.id).toBe(member.userId);
    expect(session.user.staffRole).toBe("support");
    expect(session.setup).toEqual({ passwordChangeRequired: true, authenticatorRequired: true });

    const rows = await auditFor(member.userId);
    expect(rows.map((r) => r.event_type)).toEqual(["STAFF_ROLE_GRANTED", "STAFF_PASSWORD_SET"]);
    expect(JSON.stringify(rows)).not.toContain(INITIAL);
  });

  it("changes a role (audited with before/after) and is idempotent for the same role", async () => {
    const target = await signInAs(env, { email: "changer@example.test", staffRole: "read_only" });
    const changed = await grant(root, "changer@example.test", "admin");
    expect(changed.status).toBe(200);
    expect(((await changed.json()) as StaffMember).role).toBe("admin");
    const same = await grant(root, "changer@example.test", "admin");
    expect(same.status).toBe(200);

    const rows = await auditFor(target.userId);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.before_json ?? "null")).toEqual({ role: "read_only" });
    expect(JSON.parse(rows[0]?.after_json ?? "null")).toMatchObject({ role: "admin" });
  });

  it("revokes a role: audited, and the user loses access on the next request", async () => {
    const target = await signInAs(env, { email: "revokee@example.test", staffRole: "read_only" });
    expect((await call("/api/v1/screens/audit", target)).status).toBe(200);
    const revoked = await call(`/api/v1/staff/${target.userId}`, root, { method: "DELETE" });
    expect(revoked.status).toBe(204);
    expect((await call("/api/v1/screens/audit", target)).status).toBe(403);
    const rows = await auditFor(target.userId);
    expect(rows.at(-1)).toMatchObject({ event_type: "STAFF_ROLE_REVOKED", actor_id: root.userId });
    expect((await call(`/api/v1/staff/${target.userId}`, root, { method: "DELETE" })).status).toBe(
      404,
    );
  });

  it("refuses to revoke yourself or demote the last super admin", async () => {
    const self = await call(`/api/v1/staff/${root.userId}`, root, { method: "DELETE" });
    expect(self.status).toBe(409);
    await expect(self.json()).resolves.toEqual({ error: "conflict", detail: "cannot_revoke_self" });

    // Other super admins exist in this file's database only if a test made them; make sure not.
    const { results } = await env.DB.prepare(
      "SELECT user_id FROM staff_members WHERE role = 'super_admin'",
    ).all<{ user_id: string }>();
    expect(results.map((r) => r.user_id)).toEqual([root.userId]);
    // Nobody changes their own role (only accounts strictly below the caller; review S-5).
    const demote = await grant(root, "root@example.test", "admin");
    expect(demote.status).toBe(403);
    await expect(demote.json()).resolves.toEqual({
      error: "forbidden",
      detail: "target_not_below_caller",
    });
  });

  it("validates the body with the error shape", async () => {
    const response = await grant(root, "not-an-email", "super_admin", INITIAL);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    expect((await grant(root, "ok@example.test", "owner", INITIAL)).status).toBe(400);
    expect((await grant(root, "short@example.test", "support", "too-short")).status).toBe(400);
  });

  it("refuses a cross-site grant", async () => {
    const response = await app.request(
      "/api/v1/staff",
      {
        method: "POST",
        headers: {
          cookie: root.cookie,
          origin: "https://box.affinityminds.in.evil.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ email: "csrf@example.test", role: "super_admin" }),
      },
      env,
    );
    expect(response.status).toBe(403);
  });
});
