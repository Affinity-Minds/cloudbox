import { env } from "cloudflare:test";
import type {
  AgentEntitlementResponse,
  EnrollResponse,
  HeartbeatResponse,
} from "@cloudbox/contracts";
import { generateServerSigningKey } from "@cloudbox/licensing-contracts";
import { and, eq, isNull } from "drizzle-orm";
import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/client";
import { deviceCredentials, devices } from "../src/db/schema";
import app from "../src/index";
import { createEnrollmentToken, revokeEnrollmentToken } from "../src/routes/v1/enrollment";
import { signInAs } from "./auth-fixtures";
import { insertTenant } from "./wt3-fixtures";

/** WT-5's issuance path needs `ENTITLEMENT_SIGNING_JWK` (test/subscriptions.test.ts's own pattern);
 * generated once and reused, since it's only a signing key for this file's requests, not state. */
let signingEnv: typeof env | undefined;
async function envWithSigningKey(): Promise<typeof env> {
  if (!signingEnv) {
    const server = await generateServerSigningKey();
    signingEnv = { ...env, ENTITLEMENT_SIGNING_JWK: JSON.stringify(server.privateJwk) };
  }
  return signingEnv;
}

/** Issues generation 1 for `deviceId` through WT-5's real HTTP route (super_admin holds every
 * `license.*` permission, needed later to revoke), after creating the subscription it requires. */
async function issueEntitlement(tenantId: string, deviceId: string) {
  const { headers: staffHeaders } = await signInAs(env, {
    email: `entitlement-issuer-${deviceId}@example.test`,
    staffRole: "super_admin",
  });
  const jsonHeaders = { ...staffHeaders, "content-type": "application/json" };
  const withKey = await envWithSigningKey();

  const subscription = await app.request(
    `/api/v1/tenants/${tenantId}/subscriptions`,
    {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        planCode: "cloudbox-6",
        status: "active",
        validFrom: new Date().toISOString(),
        validUntil: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    },
    withKey,
  );
  if (subscription.status !== 201) {
    throw new Error(
      `could not create subscription: ${subscription.status} ${await subscription.text()}`,
    );
  }

  const issue = await app.request(
    `/api/v1/devices/${deviceId}/entitlements/issue`,
    { method: "POST", headers: jsonHeaders, body: JSON.stringify({}) },
    withKey,
  );
  if (issue.status !== 201) {
    throw new Error(`could not issue entitlement: ${issue.status} ${await issue.text()}`);
  }

  return { staffHeaders, withKey };
}

type RsaPublicJwk = { kty: "RSA"; n: string; e: string };

async function freshDeviceJwk(): Promise<RsaPublicJwk> {
  const { publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  return { kty: "RSA", n: jwk.n as string, e: jwk.e as string };
}

async function issueToken(tenantId: string, expiresInHours = 24): Promise<string> {
  const db = createDb(env.DB);
  const created = await createEnrollmentToken(db, {
    tenantId,
    label: "agent-test",
    expiresInHours,
    createdBy: "user_test",
  });
  return created.token;
}

function enrollBody(
  token: string,
  jwk: RsaPublicJwk,
  overrides: Partial<{ hostname: string }> = {},
) {
  return {
    token,
    device: {
      hostname: overrides.hostname ?? "front-desk-01",
      windowsBuild: "10.0.26100",
      agentVersion: "0.1.0",
      keyProtection: "tpm" as const,
      publicKeyJwk: jwk,
    },
  };
}

async function enroll(token: string, jwk: RsaPublicJwk, ip: string, overrides = {}) {
  return app.request(
    "/api/v1/agent/enroll",
    {
      method: "POST",
      headers: { "cf-connecting-ip": ip, "content-type": "application/json" },
      body: JSON.stringify(enrollBody(token, jwk, overrides)),
    },
    env,
  );
}

describe("POST /api/v1/agent/enroll", () => {
  it("enrolls a device and returns a one-time deviceToken", async () => {
    const { tenantId, publicCode } = await insertTenant(env);
    const token = await issueToken(tenantId);
    const response = await enroll(token, await freshDeviceJwk(), "enroll-happy-1");

    expect(response.status).toBe(201);
    const body = (await response.json()) as EnrollResponse;
    expect(body.tenantId).toBe(tenantId);
    expect(body.tenantCode).toBe(publicCode);
    expect(body.deviceName).toMatch(/^CLOUDBOX-\d{5}$/);
    expect(body.deviceToken).toMatch(/^[0-9a-f]{64}$/);

    const db = createDb(env.DB);
    const [row] = await db.select().from(devices).where(eq(devices.id, body.deviceId));
    expect(row?.status).toBe("enrolled");
    expect(row?.tenantId).toBe(tenantId);
  });

  it("rejects an invalid body with invalid_request", async () => {
    const response = await app.request(
      "/api/v1/agent/enroll",
      {
        method: "POST",
        headers: { "cf-connecting-ip": "enroll-invalid-body", "content-type": "application/json" },
        body: JSON.stringify({ token: "short" }),
      },
      env,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
  });

  it("rejects an unknown token, an expired token and a revoked token with the same message", async () => {
    const unknown = await enroll("CBX-ENROLL-ZZZZ-ZZZZ", await freshDeviceJwk(), "enroll-unknown");
    expect(unknown.status).toBe(400);
    await expect(unknown.json()).resolves.toEqual({ error: "invalid_enrollment_token" });

    const { tenantId } = await insertTenant(env);
    const db = createDb(env.DB);

    const expiredCreated = await createEnrollmentToken(db, {
      tenantId,
      label: "expired",
      expiresInHours: 1,
      createdBy: "user_test",
    });
    const { enrollmentTokens } = await import("../src/db/schema");
    await db
      .update(enrollmentTokens)
      .set({ expiresAt: new Date(Date.now() - 60_000).toISOString() })
      .where(eq(enrollmentTokens.id, expiredCreated.id));
    const expiredResponse = await enroll(
      expiredCreated.token,
      await freshDeviceJwk(),
      "enroll-expired",
    );
    expect(expiredResponse.status).toBe(400);
    await expect(expiredResponse.json()).resolves.toEqual({ error: "invalid_enrollment_token" });

    const revokedCreated = await createEnrollmentToken(db, {
      tenantId,
      label: "revoked",
      expiresInHours: 24,
      createdBy: "user_test",
    });
    await revokeEnrollmentToken(db, { tenantId, tokenId: revokedCreated.id, actorId: "u1" });
    const revokedResponse = await enroll(
      revokedCreated.token,
      await freshDeviceJwk(),
      "enroll-revoked",
    );
    expect(revokedResponse.status).toBe(400);
    await expect(revokedResponse.json()).resolves.toEqual({ error: "invalid_enrollment_token" });
  });

  it("a redeemed token cannot be redeemed a second time", async () => {
    const { tenantId } = await insertTenant(env);
    const token = await issueToken(tenantId);
    const jwk = await freshDeviceJwk();

    const first = await enroll(token, jwk, "enroll-reuse-1");
    expect(first.status).toBe(201);

    const second = await enroll(token, await freshDeviceJwk(), "enroll-reuse-2");
    expect(second.status).toBe(400);
    await expect(second.json()).resolves.toEqual({ error: "invalid_enrollment_token" });
  });

  it("409s a duplicate device key and gives the second token back for retry", async () => {
    const { tenantId } = await insertTenant(env);
    const jwk = await freshDeviceJwk();
    const tokenOne = await issueToken(tenantId);
    const tokenTwo = await issueToken(tenantId);

    const first = await enroll(tokenOne, jwk, "enroll-dup-1", { hostname: "dup-host-1" });
    expect(first.status).toBe(201);

    const second = await enroll(tokenTwo, jwk, "enroll-dup-2", { hostname: "dup-host-2" });
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toEqual({ error: "device_already_enrolled" });

    // The second token was handed back (compensated), so a fresh key can still redeem it.
    const retry = await enroll(tokenTwo, await freshDeviceJwk(), "enroll-dup-3", {
      hostname: "dup-host-3",
    });
    expect(retry.status).toBe(201);
  });

  it("rate-limits repeated attempts from the same IP within the window", async () => {
    const ip = "enroll-rate-limit-1";
    let last: Response | undefined;
    for (let i = 0; i < 11; i += 1) {
      last = await enroll("CBX-ENROLL-AAAA-AAAA", await freshDeviceJwk(), ip);
    }
    expect(last?.status).toBe(429);
    await expect(last?.json()).resolves.toEqual({ error: "rate_limited" });
  });
});

async function enrollFreshDevice(ip: string) {
  const { tenantId } = await insertTenant(env);
  const token = await issueToken(tenantId);
  const response = await enroll(token, await freshDeviceJwk(), ip);
  const body = (await response.json()) as EnrollResponse;
  return body; // includes tenantId
}

const HEALTH_DOC = {
  device: "front-desk-01",
  agent: { version: "0.1.1", healthy: true },
  rdp: { state: "listening", listener: null },
  users: { configured: null, limit: null, active_sessions: null },
  storage: { free_bytes: null },
  updates: { state: "unknown", reboot_required: null },
  security: { device_key: "tpm" as const, tamper: "clear" },
};

describe("POST /api/v1/agent/heartbeat", () => {
  it("401s without a Bearer token and with a wrong one", async () => {
    const noAuth = await app.request(
      "/api/v1/agent/heartbeat",
      { method: "POST", body: JSON.stringify({ health: HEALTH_DOC }) },
      env,
    );
    expect(noAuth.status).toBe(401);

    const wrongAuth = await app.request(
      "/api/v1/agent/heartbeat",
      {
        method: "POST",
        headers: { authorization: "Bearer not-a-real-token" },
        body: JSON.stringify({ health: HEALTH_DOC }),
      },
      env,
    );
    expect(wrongAuth.status).toBe(401);
  });

  it("accepts null-tolerant AgentHealth fields, stores the document, and reports no entitlement yet", async () => {
    const enrolled = await enrollFreshDevice("heartbeat-happy-1");
    const response = await app.request(
      "/api/v1/agent/heartbeat",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${enrolled.deviceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          health: { ...HEALTH_DOC, agent: { version: "0.1.2", healthy: true } },
        }),
      },
      env,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as HeartbeatResponse;
    expect(body.entitlementGeneration).toBeNull();
    expect(body.commands).toEqual([]);
    expect(typeof body.serverTime).toBe("string");

    const db = createDb(env.DB);
    const [row] = await db.select().from(devices).where(eq(devices.id, enrolled.deviceId));
    expect(row?.agentVersion).toBe("0.1.2");
    expect(row?.lastSeenAt).not.toBeNull();
    expect(JSON.parse(row?.lastHealthJson ?? "null")).toMatchObject({ rdp: { listener: null } });
  });

  it("reports the current entitlement generation from WT-5's issuance service", async () => {
    const enrolled = await enrollFreshDevice("heartbeat-entitlement-1");
    await issueEntitlement(enrolled.tenantId, enrolled.deviceId);

    const response = await app.request(
      "/api/v1/agent/heartbeat",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${enrolled.deviceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ health: HEALTH_DOC }),
      },
      env,
    );
    const body = (await response.json()) as HeartbeatResponse;
    expect(body.entitlementGeneration).toBe(1);
  });
});

describe("GET /api/v1/agent/entitlement", () => {
  it("404s when none has been issued", async () => {
    const enrolled = await enrollFreshDevice("entitlement-none-1");
    const response = await app.request(
      "/api/v1/agent/entitlement",
      { headers: { authorization: `Bearer ${enrolled.deviceToken}` } },
      env,
    );
    expect(response.status).toBe(404);
  });

  it("end-to-end through WT-5's issuance service: issue → GET returns the token; revoke → GET 404s again", async () => {
    const enrolled = await enrollFreshDevice("entitlement-e2e-1");
    const { staffHeaders } = await issueEntitlement(enrolled.tenantId, enrolled.deviceId);

    const issued = await app.request(
      "/api/v1/agent/entitlement",
      { headers: { authorization: `Bearer ${enrolled.deviceToken}` } },
      env,
    );
    expect(issued.status).toBe(200);
    expect(issued.headers.get("cache-control")).toBe("no-store");
    const issuedBody = (await issued.json()) as AgentEntitlementResponse;
    expect(issuedBody.generation).toBe(1);
    expect(typeof issuedBody.entitlement).toBe("string");

    const revoke = await app.request(
      `/api/v1/devices/${enrolled.deviceId}/entitlements/revoke`,
      {
        method: "POST",
        headers: { ...staffHeaders, "content-type": "application/json" },
        body: JSON.stringify({ reason: "test: end-to-end revoke" }),
      },
      env,
    );
    expect(revoke.status).toBe(200);

    const afterRevoke = await app.request(
      "/api/v1/agent/entitlement",
      { headers: { authorization: `Bearer ${enrolled.deviceToken}` } },
      env,
    );
    expect(afterRevoke.status).toBe(404);
  });
});

describe("POST /api/v1/agent/uninstalled", () => {
  it("revokes the device and its credentials, audits the change, and is idempotent on retry", async () => {
    const enrolled = await enrollFreshDevice("uninstall-1");
    const db = createDb(env.DB);

    const first = await app.request(
      "/api/v1/agent/uninstalled",
      { method: "POST", headers: { authorization: `Bearer ${enrolled.deviceToken}` } },
      env,
    );
    expect(first.status).toBe(204);

    const [device] = await db.select().from(devices).where(eq(devices.id, enrolled.deviceId));
    expect(device?.status).toBe("revoked");
    expect(device?.revokedAt).not.toBeNull();

    const activeCredentials = await db
      .select()
      .from(deviceCredentials)
      .where(
        and(eq(deviceCredentials.deviceId, enrolled.deviceId), isNull(deviceCredentials.revokedAt)),
      );
    expect(activeCredentials).toHaveLength(0);

    const auditRow = await env.DB.prepare(
      "SELECT actor_type FROM audit_log WHERE event_type = 'DEVICE_UNINSTALLED' AND entity_id = ?",
    )
      .bind(enrolled.deviceId)
      .first<{ actor_type: string }>();
    expect(auditRow?.actor_type).toBe("device");

    // Retry with the same (now-revoked) token: still 204, not 401.
    const second = await app.request(
      "/api/v1/agent/uninstalled",
      { method: "POST", headers: { authorization: `Bearer ${enrolled.deviceToken}` } },
      env,
    );
    expect(second.status).toBe(204);
  });

  it("401s a token that was never issued", async () => {
    const response = await app.request(
      "/api/v1/agent/uninstalled",
      { method: "POST", headers: { authorization: "Bearer never-issued" } },
      env,
    );
    expect(response.status).toBe(401);
  });
});
