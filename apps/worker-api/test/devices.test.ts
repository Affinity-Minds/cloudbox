import { env } from "cloudflare:test";
import { and, eq, isNull } from "drizzle-orm";
import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/client";
import { deviceCredentials, devices } from "../src/db/schema";
import app from "../src/index";
import { revokeDevice } from "../src/routes/v1/devices";
import { createEnrollmentToken } from "../src/routes/v1/enrollment";
import { signInAs } from "./auth-fixtures";
import { insertTenant } from "./wt3-fixtures";

async function enrollFreshDevice(ip: string) {
  const { tenantId } = await insertTenant(env);
  const db = createDb(env.DB);
  const created = await createEnrollmentToken(db, {
    tenantId,
    label: "devices-test",
    expiresInHours: 24,
    createdBy: "user_test",
  });
  const { publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  const response = await app.request(
    "/api/v1/agent/enroll",
    {
      method: "POST",
      headers: { "cf-connecting-ip": ip, "content-type": "application/json" },
      body: JSON.stringify({
        token: created.token,
        device: {
          hostname: "revoke-target",
          windowsBuild: "10.0.26100",
          agentVersion: "0.1.0",
          keyProtection: "tpm",
          publicKeyJwk: { kty: "RSA", n: jwk.n, e: jwk.e },
        },
      }),
    },
    env,
  );
  const body = (await response.json()) as { deviceId: string };
  return { tenantId, deviceId: body.deviceId };
}

describe("revokeDevice (handler logic, bypassing the staff gate)", () => {
  it("revokes an enrolled device and its credentials, then reports already_revoked", async () => {
    const { deviceId } = await enrollFreshDevice("devices-unit-1");
    const db = createDb(env.DB);

    const first = await revokeDevice(env, db, { deviceId, actorId: "u1" });
    expect(first).toBe("revoked");

    const [device] = await db.select().from(devices).where(eq(devices.id, deviceId));
    expect(device?.status).toBe("revoked");
    const activeCreds = await db
      .select()
      .from(deviceCredentials)
      .where(and(eq(deviceCredentials.deviceId, deviceId), isNull(deviceCredentials.revokedAt)));
    expect(activeCreds).toHaveLength(0);

    const second = await revokeDevice(env, db, { deviceId, actorId: "u1" });
    expect(second).toBe("already_revoked");
  });

  it("reports not_found for an unknown device id", async () => {
    const db = createDb(env.DB);
    const result = await revokeDevice(env, db, { deviceId: "dev_does-not-exist", actorId: "u1" });
    expect(result).toBe("not_found");
  });
});

describe("POST /api/v1/devices/:deviceId/revoke (staff gate)", () => {
  it("401s without a session and 403s without device.manage", async () => {
    const { deviceId } = await enrollFreshDevice("devices-http-1");

    const anonymous = await app.request(
      `/api/v1/devices/${deviceId}/revoke`,
      { method: "POST" },
      env,
    );
    expect(anonymous.status).toBe(401);

    // A customer session is not read on a staff route (two identity systems, ADR 0002): 401.
    const outsider = await signInAs(env, { email: "devices-outsider@example.test" });
    const denied = await app.request(
      `/api/v1/devices/${deviceId}/revoke`,
      { method: "POST", headers: outsider.headers },
      env,
    );
    expect(denied.status).toBe(401);
  });

  it("204s for staff holding device.manage and audits DEVICE_REVOKED", async () => {
    const { deviceId } = await enrollFreshDevice("devices-http-2");
    const { headers } = await signInAs(env, {
      email: "devices-staff@example.test",
      staffRole: "admin",
    });

    const response = await app.request(
      `/api/v1/devices/${deviceId}/revoke`,
      { method: "POST", headers },
      env,
    );
    expect(response.status).toBe(204);

    const auditRow = await env.DB.prepare(
      "SELECT actor_type FROM audit_log WHERE event_type = 'DEVICE_REVOKED' AND entity_id = ?",
    )
      .bind(deviceId)
      .first<{ actor_type: string }>();
    expect(auditRow?.actor_type).toBe("user");
  });

  it("404s an unknown device", async () => {
    const { headers } = await signInAs(env, {
      email: "devices-staff2@example.test",
      staffRole: "admin",
    });
    const response = await app.request(
      "/api/v1/devices/dev_does-not-exist/revoke",
      { method: "POST", headers },
      env,
    );
    expect(response.status).toBe(404);
  });
});
