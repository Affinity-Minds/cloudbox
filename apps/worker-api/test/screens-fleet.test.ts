import { env } from "cloudflare:test";
import type { FleetDetailScreen, FleetScreen } from "@cloudbox/contracts";
import { exportJWK, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db/client";
import app from "../src/index";
import { createEnrollmentToken } from "../src/routes/v1/enrollment";
import { type SignedIn, signInAs } from "./auth-fixtures";
import { countingD1 } from "./fixtures";
import { insertMembership, insertTenant } from "./wt3-fixtures";

async function enrollFreshDevice(tenantId: string, ip: string, hostname = "fleet-test-host") {
  const db = createDb(env.DB);
  const created = await createEnrollmentToken(db, {
    tenantId,
    label: "fleet-test",
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
          hostname,
          windowsBuild: "10.0.26100",
          agentVersion: "0.1.0",
          keyProtection: "software",
          publicKeyJwk: { kty: "RSA", n: jwk.n, e: jwk.e },
        },
      }),
    },
    env,
  );
  return (await response.json()) as { deviceId: string; deviceToken: string };
}

let AUTH_ROUND_TRIPS = 0;
let staff: SignedIn;
beforeAll(async () => {
  staff = await signInAs(env, { email: "fleet-staff@example.test", staffRole: "support" });
  const counted = countingD1(env.DB);
  await app.request("/api/v1/auth/session", { headers: staff.headers }, { ...env, DB: counted });
  AUTH_ROUND_TRIPS = counted.roundTrips;
});

describe("GET /api/v1/screens/fleet", () => {
  it("401s without a session and 403s a signed-in user with no staff grant and no tenant membership", async () => {
    const anonymous = await app.request("/api/v1/screens/fleet", {}, env);
    expect(anonymous.status).toBe(401);

    const outsider = await signInAs(env, { email: "fleet-outsider@example.test" });
    const denied = await app.request("/api/v1/screens/fleet", { headers: outsider.headers }, env);
    expect(denied.status).toBe(403);
  });

  it("shows a device Offline until it heartbeats, then Online, with an honest empty state for a fresh tenant", async () => {
    const { tenantId } = await insertTenant(env, { displayName: "Fresh Co" });
    const empty = await app.request(
      `/api/v1/screens/fleet?tenant=${tenantId}`,
      { headers: staff.headers },
      env,
    );
    const emptyBody = (await empty.json()) as FleetScreen;
    expect(emptyBody.items).toEqual([]);
    expect(emptyBody.facets).toEqual({ total: 0, online: 0, offline: 0, degradedKey: 0 });

    const enrolled = await enrollFreshDevice(tenantId, "fleet-online-1");
    const afterEnroll = (await (
      await app.request(`/api/v1/screens/fleet?tenant=${tenantId}`, { headers: staff.headers }, env)
    ).json()) as FleetScreen;
    const row = afterEnroll.items.find((d) => d.id === enrolled.deviceId);
    expect(row?.online).toBe(false);
    expect(row?.keyProtection).toBe("software");
    expect(row?.licenseState).toBe("none");

    await app.request(
      "/api/v1/agent/heartbeat",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${enrolled.deviceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ health: { device: "d", agent: { version: "0.1.0", healthy: true } } }),
      },
      env,
    );
    const afterHeartbeat = (await (
      await app.request(`/api/v1/screens/fleet?tenant=${tenantId}`, { headers: staff.headers }, env)
    ).json()) as FleetScreen;
    const onlineRow = afterHeartbeat.items.find((d) => d.id === enrolled.deviceId);
    expect(onlineRow?.online).toBe(true);
  });

  it("loads the list in at most three D1 round trips beyond auth", async () => {
    const { tenantId } = await insertTenant(env);
    await enrollFreshDevice(tenantId, "fleet-roundtrips-1");

    const counted = countingD1(env.DB);
    const response = await app.request(
      `/api/v1/screens/fleet?tenant=${tenantId}`,
      { headers: staff.headers },
      { ...env, DB: counted },
    );
    expect(response.status).toBe(200);
    expect(counted.roundTrips).toBeLessThanOrEqual(3 + AUTH_ROUND_TRIPS);
  });

  it("restricts a tenant-standing (non-staff) caller to their own tenant and 403s a cross-tenant query", async () => {
    const tenantA = await insertTenant(env, { displayName: "Tenant A" });
    const tenantB = await insertTenant(env, { displayName: "Tenant B" });
    await enrollFreshDevice(tenantA.tenantId, "fleet-tenant-a-1", "tenant-a-host");
    await enrollFreshDevice(tenantB.tenantId, "fleet-tenant-b-1", "tenant-b-host");

    const { headers, userId } = await signInAs(env, { email: "fleet-tenant-admin@example.test" });
    await insertMembership(env, { tenantId: tenantA.tenantId, userId, standing: "admin" });

    const ownScope = await app.request("/api/v1/screens/fleet", { headers }, env);
    expect(ownScope.status).toBe(200);
    const ownBody = (await ownScope.json()) as FleetScreen;
    expect(ownBody.items.every((d) => d.tenantId === tenantA.tenantId)).toBe(true);
    expect(ownBody.items.some((d) => d.hostname === "tenant-a-host")).toBe(true);
    expect(ownBody.items.some((d) => d.hostname === "tenant-b-host")).toBe(false);

    const explicitOwn = await app.request(
      `/api/v1/screens/fleet?tenant=${tenantA.tenantId}`,
      { headers },
      env,
    );
    expect(explicitOwn.status).toBe(200);

    const crossTenant = await app.request(
      `/api/v1/screens/fleet?tenant=${tenantB.tenantId}`,
      { headers },
      env,
    );
    expect(crossTenant.status).toBe(403);
  });
});

describe("GET /api/v1/screens/fleet/:deviceId", () => {
  it("404s an unknown device and 403s a tenant caller reading another tenant's device", async () => {
    const notFound = await app.request(
      "/api/v1/screens/fleet/dev_does-not-exist",
      { headers: staff.headers },
      env,
    );
    expect(notFound.status).toBe(404);

    const tenantA = await insertTenant(env);
    const tenantB = await insertTenant(env);
    const deviceB = await enrollFreshDevice(tenantB.tenantId, "fleet-detail-cross-1");
    const { headers, userId } = await signInAs(env, { email: "fleet-detail-admin@example.test" });
    await insertMembership(env, { tenantId: tenantA.tenantId, userId, standing: "user" });

    const forbidden = await app.request(
      `/api/v1/screens/fleet/${deviceB.deviceId}`,
      { headers },
      env,
    );
    expect(forbidden.status).toBe(403);
  });

  it("returns overview, license (none yet) and audit tab data for a staff caller", async () => {
    const { tenantId } = await insertTenant(env);
    const enrolled = await enrollFreshDevice(tenantId, "fleet-detail-staff-1");

    const response = await app.request(
      `/api/v1/screens/fleet/${enrolled.deviceId}`,
      { headers: staff.headers },
      env,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as FleetDetailScreen;
    expect(body.device.id).toBe(enrolled.deviceId);
    expect(body.device.licenseState).toBe("none");
    expect(body.entitlements).toEqual([]);
    expect(body.audit.some((entry) => entry.eventType === "DEVICE_ENROLLED")).toBe(true);
  });
});
