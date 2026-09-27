import { env } from "cloudflare:test";
import type { BackupsScreen } from "@cloudbox/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/crypto";
import app from "../src/index";
import { issueDeviceToken } from "./backups-fixtures";
import { countingD1, type SignedIn, seedDevice, seedTenant, signInAs } from "./fixtures";

let AUTH_ROUND_TRIPS = 0;
let staff: SignedIn;
beforeAll(async () => {
  staff = await signInAs(env, { email: "backups-screen-staff@example.test", staffRole: "support" });
  const counted = countingD1(env.DB);
  await app.request("/api/v1/auth/session", { headers: staff.headers }, { ...env, DB: counted });
  AUTH_ROUND_TRIPS = counted.roundTrips;
});

async function seedVerifiedBackup(deviceId: string) {
  const { headers } = await issueDeviceToken(env, deviceId);
  const create = await app.request(
    "/api/v1/backups/jobs",
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ kind: "nightly", sourceDataset: "company-db" }),
    },
    env,
  );
  const { job } = (await create.json()) as { job: { id: string } };
  const payload = "screens-fixture-payload";
  const sha256 = await sha256Hex(payload);
  await app.request(
    `/api/v1/backups/jobs/${job.id}`,
    {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ state: "verified_local", sha256, sizeBytes: payload.length }),
    },
    env,
  );
  await app.request(
    `/api/v1/backups/jobs/${job.id}/upload`,
    { method: "POST", headers, body: payload },
    env,
  );
  return job.id;
}

describe("GET /api/v1/screens/backups", () => {
  it("401s without a session, 403s without backup.view", async () => {
    const anonymous = await app.request("/api/v1/screens/backups", {}, env);
    expect(anonymous.status).toBe(401);

    const outsider = await signInAs(env, { email: "backups-screen-outsider@example.test" });
    const denied = await app.request("/api/v1/screens/backups", { headers: outsider.headers }, env);
    expect(denied.status).toBe(401); // customer session, never read on a staff route (ADR 0002)

    await env.DB.prepare(
      "DELETE FROM role_permissions WHERE role = 'admin' AND permission_key = 'backup.view'",
    ).run();
    try {
      const admin = await signInAs(env, {
        email: "backups-screen-noaccess@example.test",
        staffRole: "admin",
      });
      const forbidden = await app.request(
        "/api/v1/screens/backups",
        { headers: admin.headers },
        env,
      );
      expect(forbidden.status).toBe(403);
    } finally {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO role_permissions (role, permission_key) VALUES ('admin', 'backup.view')",
      ).run();
    }
  });

  it("shows a device's state and cloud backup time once verified, within the loader ceiling", async () => {
    const { tenantId } = await seedTenant(env.DB);
    const { deviceId, name } = await seedDevice(env.DB, { tenantId });
    await seedVerifiedBackup(deviceId);

    const counted = countingD1(env.DB);
    const res = await app.request(
      "/api/v1/screens/backups",
      { headers: staff.headers },
      { ...env, DB: counted },
    );
    expect(res.status).toBe(200);
    expect(counted.roundTrips).toBeLessThanOrEqual(3 + AUTH_ROUND_TRIPS);

    const body = (await res.json()) as BackupsScreen;
    const row = body.items.find((r) => r.deviceId === deviceId);
    expect(row).toMatchObject({ deviceName: name, state: "cloud_verified" });
    expect(row?.lastCloudBackupAt).not.toBeNull();
    expect(body.exceptions.devicesProtected).toBeGreaterThanOrEqual(1);
  });

  it("filters by tenant and by state", async () => {
    const { tenantId } = await seedTenant(env.DB);
    const { deviceId } = await seedDevice(env.DB, { tenantId });
    await seedVerifiedBackup(deviceId);

    const filtered = await app.request(
      `/api/v1/screens/backups?tenant=${tenantId}&state=cloud_verified`,
      { headers: staff.headers },
      env,
    );
    const body = (await filtered.json()) as BackupsScreen;
    expect(body.items.every((r) => r.tenantId === tenantId)).toBe(true);
    expect(body.items.every((r) => r.state === "cloud_verified")).toBe(true);
  });
});

describe("GET /api/v1/screens/backups/:deviceId", () => {
  it("404s for an unknown device, 200 with jobs/artifacts/policy for a real one", async () => {
    const missing = await app.request(
      "/api/v1/screens/backups/dev_does-not-exist",
      { headers: staff.headers },
      env,
    );
    expect(missing.status).toBe(404);

    const { tenantId } = await seedTenant(env.DB);
    const { deviceId } = await seedDevice(env.DB, { tenantId });
    await seedVerifiedBackup(deviceId);

    const counted = countingD1(env.DB);
    const res = await app.request(
      `/api/v1/screens/backups/${deviceId}`,
      { headers: staff.headers },
      { ...env, DB: counted },
    );
    expect(res.status).toBe(200);
    expect(counted.roundTrips).toBeLessThanOrEqual(3 + AUTH_ROUND_TRIPS);

    const body = (await res.json()) as {
      jobs: unknown[];
      artifacts: unknown[];
      restoreTests: unknown[];
    };
    expect(body).toMatchObject({
      device: { id: deviceId, tenantId },
      policy: { isDefault: true },
    });
    expect(body.jobs.length).toBeGreaterThanOrEqual(1);
    expect(body.artifacts.length).toBeGreaterThanOrEqual(1);
    expect(body.restoreTests).toEqual([]);
  });
});
