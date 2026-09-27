// Licence hold (migration 0019, bug found by WT-10): a staff licence revoke must not be undone by
// heartbeat auto-issuance. Only a staff Issue/Renew lifts the hold.
import { env } from "cloudflare:test";
import {
  type EnrollResponse,
  type HeartbeatResponse,
  LICENSE_REVOKED_MESSAGE,
  type OnboardingOverview,
} from "@cloudbox/contracts";
import { generateServerSigningKey } from "@cloudbox/licensing-contracts";
import { exportJWK, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db/client";
import { EntitlementRefusal, issueForDevice } from "../src/entitlement/service";
import type { Bindings } from "../src/env";
import app from "../src/index";
import { activateLicense } from "../src/onboarding/activation";
import { createEnrollmentToken } from "../src/routes/v1/enrollment";
import { seedMembership, seedSubscription, seedTenant, signInAs, TEST_ORIGIN } from "./fixtures";

let testEnv: Bindings;
beforeAll(async () => {
  const server = await generateServerSigningKey();
  testEnv = { ...env, ENTITLEMENT_SIGNING_JWK: JSON.stringify(server.privateJwk) };
});

let ipSeq = 0;
const nextIp = () => `198.51.99.${++ipSeq}`;

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(
    path,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": nextIp(),
        origin: TEST_ORIGIN,
        ...headers,
      },
      body: JSON.stringify(body),
    },
    testEnv,
  );
}

const heartbeat = async (token: string) =>
  (await (
    await post(
      "/api/v1/agent/heartbeat",
      { health: { device: "x", agent: { version: "0.1.0", healthy: true } } },
      { authorization: `Bearer ${token}` },
    )
  ).json()) as HeartbeatResponse;

const staff = (role: "super_admin" | "admin" | "support") =>
  signInAs(testEnv, { email: `hold-${role}@example.test`, staffRole: role });

/** A tenant with an active plan and one licensed server (issued at enrollment). */
async function licensedServer() {
  const tenant = await seedTenant(testEnv.DB);
  await seedSubscription(testEnv.DB, { tenantId: tenant.tenantId, status: "active" });
  const { token } = await createEnrollmentToken(createDb(testEnv.DB), {
    tenantId: tenant.tenantId,
    label: "hold test",
    expiresInHours: 1,
    createdBy: "staff-test",
  });
  const { publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  const res = await post("/api/v1/agent/enroll", {
    token,
    device: {
      hostname: "hold-host",
      windowsBuild: "10.0.26100.1",
      agentVersion: "0.1.0",
      keyProtection: "software",
      publicKeyJwk: { kty: "RSA", n: jwk.n, e: jwk.e },
    },
  });
  expect(res.status).toBe(201);
  const device = (await res.json()) as EnrollResponse;
  expect(device.licenseState).toBe("licensed");
  return { tenant, device };
}

const revoke = async (deviceId: string, headers: Record<string, string>) =>
  post(
    `/api/v1/devices/${deviceId}/entitlements/revoke`,
    { reason: "lab: stop this server" },
    headers,
  );

const holdOf = (deviceId: string) =>
  testEnv.DB.prepare(
    "SELECT license_hold_reason AS reason, license_hold_by AS by FROM devices WHERE id = ?1",
  )
    .bind(deviceId)
    .first<{ reason: string | null; by: string | null }>();

const auditCount = async (eventType: string, entityId: string) =>
  (
    await testEnv.DB.prepare(
      "SELECT count(*) AS n FROM audit_log WHERE event_type = ?1 AND entity_id = ?2",
    )
      .bind(eventType, entityId)
      .first<{ n: number }>()
  )?.n ?? 0;

const entitlementCount = async (deviceId: string) =>
  (
    await testEnv.DB.prepare("SELECT count(*) AS n FROM entitlements WHERE device_id = ?1")
      .bind(deviceId)
      .first<{ n: number }>()
  )?.n ?? 0;

describe("licence hold", () => {
  it("revoke holds the device: the next heartbeats do not re-issue and report revoked", async () => {
    const { device } = await licensedServer();
    const superAdmin = await staff("super_admin");
    const res = await revoke(device.deviceId, superAdmin.headers);
    expect(res.status).toBe(200);
    expect(await holdOf(device.deviceId)).toEqual({
      reason: "lab: stop this server",
      by: superAdmin.userId,
    });
    expect(await auditCount("LICENSE_HOLD_PLACED", device.deviceId)).toBe(1);

    for (let i = 0; i < 2; i += 1) {
      const beat = await heartbeat(device.deviceToken);
      expect(beat).toMatchObject({
        entitlementGeneration: null,
        licenseState: "revoked",
        message: LICENSE_REVOKED_MESSAGE,
      });
    }
    expect(await entitlementCount(device.deviceId)).toBe(1);
    const entitlement = await app.request(
      "/api/v1/agent/entitlement",
      { headers: { authorization: `Bearer ${device.deviceToken}` } },
      testEnv,
    );
    expect(entitlement.status).toBe(404);
  });

  it("a staff Issue clears the hold (audited) and issues; heartbeat is licensed again", async () => {
    const { device } = await licensedServer();
    const superAdmin = await staff("super_admin");
    await revoke(device.deviceId, superAdmin.headers);
    const issued = await post(
      `/api/v1/devices/${device.deviceId}/entitlements/issue`,
      {},
      superAdmin.headers,
    );
    expect(issued.status).toBe(201);
    expect((await holdOf(device.deviceId))?.reason).toBeNull();
    expect(await auditCount("LICENSE_HOLD_CLEARED", device.deviceId)).toBe(1);
    expect(await heartbeat(device.deviceToken)).toMatchObject({
      entitlementGeneration: 2,
      licenseState: "licensed",
    });
  });

  it("activation (and any automatic issuance) of a held device does not issue", async () => {
    const { tenant, device } = await licensedServer();
    await revoke(device.deviceId, (await staff("super_admin")).headers);
    const db = createDb(testEnv.DB);
    const outcome = await activateLicense(
      testEnv,
      db,
      { id: device.deviceId, tenantId: tenant.tenantId },
      { source: "activation" },
    );
    expect(outcome).toEqual({
      licenseState: "revoked",
      message: LICENSE_REVOKED_MESSAGE,
      generation: null,
    });
    await expect(
      issueForDevice(testEnv, db, {
        deviceId: device.deviceId,
        kind: "issue",
        actor: { id: "system", type: "system", source: "auto" },
      }),
    ).rejects.toSatisfy((e) => e instanceof EntitlementRefusal && e.code === "license_hold");
    expect(await entitlementCount(device.deviceId)).toBe(1);
  });

  it("permission boundaries are unchanged: admin cannot revoke, support cannot issue", async () => {
    const { device } = await licensedServer();
    expect((await revoke(device.deviceId, (await staff("admin")).headers)).status).toBe(403);
    expect((await holdOf(device.deviceId))?.reason).toBeNull();
    await revoke(device.deviceId, (await staff("super_admin")).headers);
    const support = await staff("support");
    expect(
      (await post(`/api/v1/devices/${device.deviceId}/entitlements/issue`, {}, support.headers))
        .status,
    ).toBe(403);
    expect((await holdOf(device.deviceId))?.reason).toBe("lab: stop this server");
    const customer = await signInAs(testEnv, { email: "hold-customer@example.test" });
    expect(
      (await post(`/api/v1/devices/${device.deviceId}/entitlements/issue`, {}, customer.headers))
        .status,
    ).toBe(401);
  });

  it("Fleet detail and the portal show the hold", async () => {
    const { tenant, device } = await licensedServer();
    const superAdmin = await staff("super_admin");
    await revoke(device.deviceId, superAdmin.headers);
    const detail = (await (
      await app.request(
        `/api/v1/screens/fleet/${device.deviceId}`,
        { headers: superAdmin.headers },
        testEnv,
      )
    ).json()) as { device: { licenseHold: { reason: string } | null } };
    expect(detail.device.licenseHold).toMatchObject({ reason: "lab: stop this server" });

    const owner = await signInAs(testEnv, { email: "hold-owner@example.test" });
    await seedMembership(testEnv.DB, {
      tenantId: tenant.tenantId,
      userId: owner.userId,
      standing: "owner",
    });
    const overview = (await (
      await app.request("/api/v1/onboarding/overview", { headers: owner.headers }, testEnv)
    ).json()) as OnboardingOverview;
    expect(overview.tenants.find((t) => t.tenantId === tenant.tenantId)?.heldDevices).toBe(1);
  });
});
