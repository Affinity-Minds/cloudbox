import { env } from "cloudflare:test";
import type { CreateEnrollmentTokenResponse, EnrollmentToken } from "@cloudbox/contracts";
import { describe, expect, it } from "vitest";
import {
  createEnrollmentToken,
  listEnrollmentTokens,
  revokeEnrollmentToken,
} from "../src/routes/v1/enrollment";
import { createDb } from "../src/db/client";
import { enrollmentTokens } from "../src/db/schema";
import { eq } from "drizzle-orm";
import app from "../src/index";
import { signInAs } from "./auth-fixtures";
import { insertMembership, insertTenant } from "./wt3-fixtures";

describe("createEnrollmentToken (handler logic, bypassing the staff gate)", () => {
  it("returns the plaintext once and stores only its SHA-256 hash", async () => {
    const { tenantId } = await insertTenant(env);
    const db = createDb(env.DB);
    const response = await createEnrollmentToken(db, {
      tenantId,
      label: "Front desk PC",
      expiresInHours: 24,
      createdBy: "user_test",
    });

    expect(response.token).toMatch(/^CBX-ENROLL-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(response.token).not.toMatch(/[ILOU]/); // no ambiguous Crockford characters
    expect(response.label).toBe("Front desk PC");
    expect(response.redeemedAt).toBeNull();
    expect(response.revokedAt).toBeNull();

    const [row] = await db.select().from(enrollmentTokens).where(eq(enrollmentTokens.id, response.id));
    expect(row?.tokenHash).toBeDefined();
    expect(row?.tokenHash).not.toBe(response.token);
    expect(JSON.stringify(row)).not.toContain(response.token);
  });

  it("lists tokens for exactly one tenant, newest first", async () => {
    const tenantA = await insertTenant(env);
    const tenantB = await insertTenant(env);
    const db = createDb(env.DB);
    await createEnrollmentToken(db, {
      tenantId: tenantA.tenantId,
      label: "A1",
      expiresInHours: 24,
      createdBy: "user_test",
    });
    await createEnrollmentToken(db, {
      tenantId: tenantB.tenantId,
      label: "B1",
      expiresInHours: 24,
      createdBy: "user_test",
    });

    const tokensA = await listEnrollmentTokens(db, tenantA.tenantId);
    expect(tokensA).toHaveLength(1);
    expect(tokensA[0]?.label).toBe("A1");
  });

  it("revoke: unredeemed succeeds, then reports already_revoked, then not_found for the wrong tenant", async () => {
    const { tenantId } = await insertTenant(env);
    const db = createDb(env.DB);
    const created = await createEnrollmentToken(db, {
      tenantId,
      label: "Revoke me",
      expiresInHours: 24,
      createdBy: "user_test",
    });

    const first = await revokeEnrollmentToken(db, { tenantId, tokenId: created.id, actorId: "u1" });
    expect(first).toBe("revoked");

    const second = await revokeEnrollmentToken(db, { tenantId, tokenId: created.id, actorId: "u1" });
    expect(second).toBe("already_revoked");

    const other = await insertTenant(env);
    const wrongTenant = await revokeEnrollmentToken(db, {
      tenantId: other.tenantId,
      tokenId: created.id,
      actorId: "u1",
    });
    expect(wrongTenant).toBe("not_found");
  });

  it("revoke: reports already_redeemed once a device has claimed the token", async () => {
    const { tenantId } = await insertTenant(env);
    const db = createDb(env.DB);
    const created = await createEnrollmentToken(db, {
      tenantId,
      label: "Will be redeemed",
      expiresInHours: 24,
      createdBy: "user_test",
    });
    await db
      .update(enrollmentTokens)
      .set({ redeemedAt: new Date().toISOString() })
      .where(eq(enrollmentTokens.id, created.id));

    const result = await revokeEnrollmentToken(db, { tenantId, tokenId: created.id, actorId: "u1" });
    expect(result).toBe("already_redeemed");
  });
});

describe("POST/GET/DELETE /api/v1/tenants/:tenantId/enrollment-tokens (staff gate)", () => {
  it("401s without a session", async () => {
    const { tenantId } = await insertTenant(env);
    const response = await app.request(
      `/api/v1/tenants/${tenantId}/enrollment-tokens`,
      { method: "POST", body: JSON.stringify({ label: "x", expiresInHours: 24 }) },
      env,
    );
    expect(response.status).toBe(401);
  });

  it("403s a signed-in user with neither device.manage nor tenant standing admin", async () => {
    const { tenantId } = await insertTenant(env);
    const { headers } = await signInAs(env, { email: "enroll-outsider@example.test" });
    const response = await app.request(
      `/api/v1/tenants/${tenantId}/enrollment-tokens`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ label: "x", expiresInHours: 24 }),
      },
      env,
    );
    expect(response.status).toBe(403);
  });

  it("201s for staff holding device.manage", async () => {
    const { tenantId } = await insertTenant(env);
    const { headers } = await signInAs(env, {
      email: "enroll-staff@example.test",
      staffRole: "admin",
    });
    const response = await app.request(
      `/api/v1/tenants/${tenantId}/enrollment-tokens`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ label: "Kiosk", expiresInHours: 24 }),
      },
      env,
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as CreateEnrollmentTokenResponse;
    expect(body.token).toMatch(/^CBX-ENROLL-/);
  });

  it("201s for a non-staff tenant member with standing admin on their own tenant, and 403s for another tenant", async () => {
    const tenantA = await insertTenant(env);
    const tenantB = await insertTenant(env);
    const { headers, userId } = await signInAs(env, { email: "tenant-admin@example.test" });
    await insertMembership(env, { tenantId: tenantA.tenantId, userId, standing: "admin" });

    const ownTenant = await app.request(
      `/api/v1/tenants/${tenantA.tenantId}/enrollment-tokens`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ label: "Self-serve", expiresInHours: 24 }),
      },
      env,
    );
    expect(ownTenant.status).toBe(201);

    const otherTenant = await app.request(
      `/api/v1/tenants/${tenantB.tenantId}/enrollment-tokens`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ label: "Nope", expiresInHours: 24 }),
      },
      env,
    );
    expect(otherTenant.status).toBe(403);
  });

  it("GET lists and DELETE revokes through the HTTP layer", async () => {
    const { tenantId } = await insertTenant(env);
    const { headers } = await signInAs(env, {
      email: "enroll-staff2@example.test",
      staffRole: "admin",
    });
    const created = await app.request(
      `/api/v1/tenants/${tenantId}/enrollment-tokens`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ label: "Kiosk 2", expiresInHours: 24 }),
      },
      env,
    );
    const { id } = (await created.json()) as CreateEnrollmentTokenResponse;

    const list = await app.request(`/api/v1/tenants/${tenantId}/enrollment-tokens`, { headers }, env);
    expect(list.status).toBe(200);
    const tokens = (await list.json()) as EnrollmentToken[];
    expect(tokens.some((t) => t.id === id)).toBe(true);
    expect(tokens.find((t) => t.id === id)).not.toHaveProperty("token");

    const revoke = await app.request(
      `/api/v1/tenants/${tenantId}/enrollment-tokens/${id}`,
      { method: "DELETE", headers },
      env,
    );
    expect(revoke.status).toBe(204);

    const notFound = await app.request(
      `/api/v1/tenants/${tenantId}/enrollment-tokens/tok_does-not-exist`,
      { method: "DELETE", headers },
      env,
    );
    expect(notFound.status).toBe(404);
  });
});
