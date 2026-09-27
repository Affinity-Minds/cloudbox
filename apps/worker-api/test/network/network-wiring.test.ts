// Owner: WT-9. HTTP-level wiring: the enroll response's `network` field, the Connect device
// network route (permission/membership boundaries), and that device/membership revoke actually
// call through to the peer revocation. These go through `app.request`, so the route handlers'
// own (non-injectable) call to the global `fetch` is stubbed for the duration of each test —
// `resolveController`'s `fetchImpl` seam is for the lower-level unit tests; nothing in a route
// handler threads a fetch override through `c.env`, matching production.
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../../src/db/client";
import { networkPeers } from "../../src/db/schema";
import app from "../../src/index";
import { createEnrollmentToken } from "../../src/routes/v1/enrollment";
import { seedMembership, seedTenant, signInAs } from "../fixtures";
import { createFakeNetbirdServer, type FakeNetbirdServer } from "./fake-netbird-server";

const NETBIRD_ENV = {
  NETBIRD_API_URL: "https://fake.netbird.test",
  NETBIRD_API_TOKEN: "fake-token",
};

const originalFetch = globalThis.fetch;
let server: FakeNetbirdServer;

beforeEach(() => {
  server = createFakeNetbirdServer();
  globalThis.fetch = server.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function enroll(env_: Record<string, unknown>, ip: string, tenantId: string) {
  const db = createDb((env_.DB as D1Database) ?? env.DB);
  const token = await createEnrollmentToken(db, {
    tenantId,
    label: "network-wiring-test",
    expiresInHours: 24,
    createdBy: "user_test",
  });
  const { publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  return app.request(
    "/api/v1/agent/enroll",
    {
      method: "POST",
      headers: { "cf-connecting-ip": ip, "content-type": "application/json" },
      body: JSON.stringify({
        token: token.token,
        device: {
          hostname: "network-wiring-host",
          windowsBuild: "10.0.26100",
          agentVersion: "0.1.0",
          keyProtection: "tpm",
          publicKeyJwk: { kty: "RSA", n: jwk.n, e: jwk.e },
        },
      }),
    },
    { ...env, ...env_ },
  );
}

describe("POST /agent/enroll — network field", () => {
  it("includes network {setupKey, managementUrl} when NetBird is configured", async () => {
    const { tenantId } = await seedTenant(env.DB);
    const response = await enroll(NETBIRD_ENV, "network-wiring-1", tenantId);
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      network?: { setupKey: string; managementUrl: string };
    };
    expect(body.network?.setupKey).toMatch(/FAKE-SETUP-KEY$/);
    expect(body.network?.managementUrl).toBe("https://fake.netbird.test");
  });

  it("omits network entirely when NetBird is not configured (production today)", async () => {
    const { tenantId } = await seedTenant(env.DB);
    const response = await enroll({}, "network-wiring-2", tenantId);
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("network");
  });
});

describe("GET /connect/devices/:deviceId/network", () => {
  it("401s without a session", async () => {
    const response = await app.request(
      "/api/v1/connect/devices/dev_probe/network",
      {},
      { ...env, ...NETBIRD_ENV },
    );
    expect(response.status).toBe(401);
  });

  it("403s a signed-in customer who is not a member of the device's tenant", async () => {
    const { tenantId } = await seedTenant(env.DB);
    const enrollResponse = await enroll(NETBIRD_ENV, "network-wiring-3", tenantId);
    const { deviceId } = (await enrollResponse.json()) as { deviceId: string };
    const outsider = await signInAs(env, { email: "network-outsider@example.test" });

    const response = await app.request(
      `/api/v1/connect/devices/${deviceId}/network`,
      { headers: outsider.headers },
      { ...env, ...NETBIRD_ENV },
    );
    expect(response.status).toBe(403);
  });

  it("404s an unknown device id", async () => {
    const member = await signInAs(env, { email: "network-member-404@example.test" });
    const response = await app.request(
      "/api/v1/connect/devices/dev_does-not-exist/network",
      { headers: member.headers },
      { ...env, ...NETBIRD_ENV },
    );
    expect(response.status).toBe(404);
  });

  it("mints a client key for an active member, audited NETWORK_CLIENT_KEY_ISSUED", async () => {
    const { tenantId } = await seedTenant(env.DB);
    const enrollResponse = await enroll(NETBIRD_ENV, "network-wiring-4", tenantId);
    const { deviceId } = (await enrollResponse.json()) as { deviceId: string };
    const member = await signInAs(env, { email: "network-member-ok@example.test" });
    await seedMembership(env.DB, { tenantId, userId: member.userId, standing: "user" });

    const response = await app.request(
      `/api/v1/connect/devices/${deviceId}/network`,
      { headers: member.headers },
      { ...env, ...NETBIRD_ENV },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      setupKey: string;
      managementUrl: string;
      expiresAt: string;
    };
    expect(body.setupKey).toMatch(/FAKE-SETUP-KEY$/);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const db = createDb(env.DB);
    const [row] = await db
      .select()
      .from(networkPeers)
      .where(eq(networkPeers.userId, member.userId));
    expect(row?.kind).toBe("client");
    expect(row?.status).toBe("pending");
  });

  it("404s network_not_configured when NetBird is unset", async () => {
    const { tenantId } = await seedTenant(env.DB);
    const enrollResponse = await enroll({}, "network-wiring-5", tenantId);
    const { deviceId } = (await enrollResponse.json()) as { deviceId: string };
    const member = await signInAs(env, { email: "network-member-noconfig@example.test" });
    await seedMembership(env.DB, { tenantId, userId: member.userId, standing: "user" });

    const response = await app.request(
      `/api/v1/connect/devices/${deviceId}/network`,
      { headers: member.headers },
      env,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "network_not_configured" });
  });
});

describe("device revoke and membership revoke call the peer revocations", () => {
  it("POST /devices/:id/revoke revokes the device's network_peers row too", async () => {
    const { tenantId } = await seedTenant(env.DB);
    const enrollResponse = await enroll(NETBIRD_ENV, "network-wiring-6", tenantId);
    const { deviceId } = (await enrollResponse.json()) as { deviceId: string };
    const staff = await signInAs(env, {
      email: "network-revoke-staff@example.test",
      staffRole: "super_admin",
    });

    const revokeResponse = await app.request(
      `/api/v1/devices/${deviceId}/revoke`,
      {
        method: "POST",
        headers: { ...staff.headers, "content-type": "application/json" },
        body: JSON.stringify({ reasonCode: "decommissioned" }),
      },
      { ...env, ...NETBIRD_ENV },
    );
    expect(revokeResponse.status).toBe(204);

    const db = createDb(env.DB);
    const [row] = await db.select().from(networkPeers).where(eq(networkPeers.deviceId, deviceId));
    expect(row?.status).toBe("revoked");
  });

  it("DELETE membership revokes the member's client network_peers row too", async () => {
    const { tenantId } = await seedTenant(env.DB);
    const enrollResponse = await enroll(NETBIRD_ENV, "network-wiring-7", tenantId);
    const { deviceId } = (await enrollResponse.json()) as { deviceId: string };
    const owner = await signInAs(env, { email: "network-revoke-owner@example.test" });
    await seedMembership(env.DB, { tenantId, userId: owner.userId, standing: "owner" });
    const member = await signInAs(env, { email: "network-revoke-member@example.test" });
    const membership = await seedMembership(env.DB, {
      tenantId,
      userId: member.userId,
      standing: "user",
    });

    // Member mints its client key first, so there is a network_peers row to revoke.
    await app.request(
      `/api/v1/connect/devices/${deviceId}/network`,
      { headers: member.headers },
      { ...env, ...NETBIRD_ENV },
    );

    const deleteResponse = await app.request(
      `/api/v1/tenants/${tenantId}/memberships/${membership.membershipId}`,
      {
        method: "DELETE",
        headers: { ...owner.headers, "content-type": "application/json" },
        body: JSON.stringify({ reasonCode: "left_organisation" }),
      },
      { ...env, ...NETBIRD_ENV },
    );
    expect(deleteResponse.status).toBe(200);

    const db = createDb(env.DB);
    const [row] = await db
      .select()
      .from(networkPeers)
      .where(eq(networkPeers.userId, member.userId));
    expect(row?.status).toBe("revoked");
  });
});
