import { env } from "cloudflare:test";
import type { BackupJob } from "@cloudbox/contracts";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/crypto";
import app from "../src/index";
import { issueDeviceToken } from "./backups-fixtures";
import { seedDevice, seedTenant, signInAs } from "./fixtures";

async function deviceContext() {
  const { tenantId } = await seedTenant(env.DB);
  const { deviceId } = await seedDevice(env.DB, { tenantId });
  const { headers } = await issueDeviceToken(env, deviceId);
  return { tenantId, deviceId, headers };
}

async function createJob(headers: Record<string, string>) {
  const res = await app.request(
    "/api/v1/backups/jobs",
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ kind: "nightly", sourceDataset: "company-db" }),
    },
    env,
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { job: BackupJob };
  return body.job;
}

describe("POST /api/v1/backups/jobs", () => {
  it("401s without a device Bearer token", async () => {
    const res = await app.request(
      "/api/v1/backups/jobs",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("creates a job in state created", async () => {
    const { headers, tenantId, deviceId } = await deviceContext();
    const job = await createJob(headers);
    expect(job.state).toBe("created");
    expect(job.tenantId).toBe(tenantId);
    expect(job.deviceId).toBe(deviceId);
    expect(job.kind).toBe("nightly");
  });

  it("400s on an invalid kind", async () => {
    const { headers } = await deviceContext();
    const res = await app.request(
      "/api/v1/backups/jobs",
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ kind: "bogus", sourceDataset: "x" }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/v1/backups/jobs/:id (state machine)", () => {
  it("rejects skipping verified_local", async () => {
    const { headers } = await deviceContext();
    const job = await createJob(headers);
    const res = await app.request(
      `/api/v1/backups/jobs/${job.id}`,
      {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ state: "upload_started" }),
      },
      env,
    );
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_transition" });
  });

  it("verified_local requires sha256 and sizeBytes (400 without them)", async () => {
    const { headers } = await deviceContext();
    const job = await createJob(headers);
    const res = await app.request(
      `/api/v1/backups/jobs/${job.id}`,
      {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ state: "verified_local" }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("accepts created -> verified_local -> upload_started, and failed from any non-terminal state", async () => {
    const { headers } = await deviceContext();
    const job = await createJob(headers);
    const sha256 = await sha256Hex("hello");

    const verified = await app.request(
      `/api/v1/backups/jobs/${job.id}`,
      {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ state: "verified_local", sha256, sizeBytes: 5 }),
      },
      env,
    );
    expect(verified.status).toBe(200);
    const verifiedBody = (await verified.json()) as { job: BackupJob };
    expect(verifiedBody.job.state).toBe("verified_local");
    expect(verifiedBody.job.sha256).toBe(sha256);

    const started = await app.request(
      `/api/v1/backups/jobs/${job.id}`,
      {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ state: "upload_started" }),
      },
      env,
    );
    expect(started.status).toBe(200);

    const failed = await app.request(
      `/api/v1/backups/jobs/${job.id}`,
      {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ state: "failed", error: { reason: "disk_full" } }),
      },
      env,
    );
    expect(failed.status).toBe(200);
    const failedBody = (await failed.json()) as { job: BackupJob };
    expect(failedBody.job.state).toBe("failed");
    expect(failedBody.job.error).toEqual({ reason: "disk_full" });

    // Terminal: nothing else is accepted.
    const dead = await app.request(
      `/api/v1/backups/jobs/${job.id}`,
      {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ state: "upload_started" }),
      },
      env,
    );
    expect(dead.status).toBe(409);
  });

  it("404s for a job that belongs to a different device", async () => {
    const a = await deviceContext();
    const b = await deviceContext();
    const job = await createJob(a.headers);
    const res = await app.request(
      `/api/v1/backups/jobs/${job.id}`,
      {
        method: "PATCH",
        headers: { ...b.headers, "content-type": "application/json" },
        body: JSON.stringify({ state: "upload_started" }),
      },
      env,
    );
    expect(res.status).toBe(404);
  });
});

async function toVerifiedLocal(headers: Record<string, string>, job: BackupJob, payload: string) {
  const sha256 = await sha256Hex(payload);
  const res = await app.request(
    `/api/v1/backups/jobs/${job.id}`,
    {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ state: "verified_local", sha256, sizeBytes: payload.length }),
    },
    env,
  );
  expect(res.status).toBe(200);
  return sha256;
}

describe("POST /api/v1/backups/jobs/:id/upload (single-shot)", () => {
  it("409s from state created (must verify_local first)", async () => {
    const { headers } = await deviceContext();
    const job = await createJob(headers);
    const res = await app.request(
      `/api/v1/backups/jobs/${job.id}/upload`,
      { method: "POST", headers, body: "payload" },
      env,
    );
    expect(res.status).toBe(409);
  });

  it("matching sha256 -> cloud_verified, artifact verified", async () => {
    const { headers } = await deviceContext();
    const job = await createJob(headers);
    const payload = "the-actual-backup-bytes";
    await toVerifiedLocal(headers, job, payload);

    const res = await app.request(
      `/api/v1/backups/jobs/${job.id}/upload`,
      { method: "POST", headers, body: payload },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { job: BackupJob; artifact: { verifiedAt: string | null } };
    expect(body.job.state).toBe("cloud_verified");
    expect(body.artifact.verifiedAt).not.toBeNull();
  });

  it("mismatched sha256 -> job failed, artifact deleted", async () => {
    const { headers } = await deviceContext();
    const job = await createJob(headers);
    await toVerifiedLocal(headers, job, "declared-content");

    const res = await app.request(
      `/api/v1/backups/jobs/${job.id}/upload`,
      { method: "POST", headers, body: "different-content-actually-uploaded" },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      job: BackupJob;
      artifact: { deletedAt: string | null; verifiedAt: string | null };
    };
    expect(body.job.state).toBe("failed");
    expect(body.job.error).toMatchObject({ reason: "sha256_mismatch" });
    expect(body.artifact.verifiedAt).toBeNull();
    expect(body.artifact.deletedAt).not.toBeNull();
  });

  it("device can only upload to its own job", async () => {
    const a = await deviceContext();
    const b = await deviceContext();
    const job = await createJob(a.headers);
    await toVerifiedLocal(a.headers, job, "x");
    const res = await app.request(
      `/api/v1/backups/jobs/${job.id}/upload`,
      { method: "POST", headers: b.headers, body: "x" },
      env,
    );
    expect(res.status).toBe(404);
  });
});

describe("multipart upload flow", () => {
  it("init -> one part -> complete -> cloud_verified", async () => {
    const { headers } = await deviceContext();
    const job = await createJob(headers);
    const payload = "multipart-single-part-payload";
    await toVerifiedLocal(headers, job, payload);

    const init = await app.request(
      `/api/v1/backups/jobs/${job.id}/upload/init`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ sizeBytes: payload.length }),
      },
      env,
    );
    expect(init.status).toBe(200);
    const { uploadId } = (await init.json()) as { uploadId: string; artifactId: string };
    expect(uploadId).toBeTruthy();

    const part = await app.request(
      `/api/v1/backups/jobs/${job.id}/upload/parts/1`,
      { method: "PUT", headers, body: payload },
      env,
    );
    expect(part.status).toBe(200);
    const { etag } = (await part.json()) as { partNumber: number; etag: string };
    expect(etag).toBeTruthy();

    const sha256 = await sha256Hex(payload);
    const complete = await app.request(
      `/api/v1/backups/jobs/${job.id}/upload/complete`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ partNumber: 1, etag }],
          sha256,
          sizeBytes: payload.length,
        }),
      },
      env,
    );
    expect(complete.status).toBe(200);
    const body = (await complete.json()) as { job: BackupJob };
    expect(body.job.state).toBe("cloud_verified");
  });

  it("400s a part number outside 1..10000", async () => {
    const { headers } = await deviceContext();
    const job = await createJob(headers);
    const res = await app.request(
      `/api/v1/backups/jobs/${job.id}/upload/parts/0`,
      { method: "PUT", headers, body: "x" },
      env,
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/backups/policy", () => {
  it("returns the global default when the tenant has no override", async () => {
    const { headers, tenantId } = await deviceContext();
    const res = await app.request("/api/v1/backups/policy", { headers }, env);
    expect(res.status).toBe(200);
    const policy = await res.json();
    expect(policy).toMatchObject({ tenantId, isDefault: true, dailyKeep: 30 });
  });
});

describe("PATCH /api/v1/tenants/:tenantId/backup-policy", () => {
  it("401s anonymous, 403s backup.view-only, 200s for backup.restore and persists", async () => {
    const { tenantId } = await deviceContext();

    const anon = await app.request(`/api/v1/tenants/${tenantId}/backup-policy`, {
      method: "PATCH",
      body: "{}",
    });
    expect(anon.status).toBe(401);

    const viewer = await signInAs(env, {
      email: "backups-policy-viewer@example.test",
      staffRole: "read_only",
    });
    const denied = await app.request(
      `/api/v1/tenants/${tenantId}/backup-policy`,
      {
        method: "PATCH",
        headers: { ...viewer.headers, "content-type": "application/json" },
        body: "{}",
      },
      env,
    );
    expect(denied.status).toBe(403);

    const admin = await signInAs(env, {
      email: "backups-policy-admin@example.test",
      staffRole: "admin",
    });
    const updated = await app.request(
      `/api/v1/tenants/${tenantId}/backup-policy`,
      {
        method: "PATCH",
        headers: { ...admin.headers, "content-type": "application/json" },
        body: JSON.stringify({ dailyKeep: 45, yearlyKeep: 2 }),
      },
      env,
    );
    expect(updated.status).toBe(200);
    const body = (await updated.json()) as { policy: { dailyKeep: number; isDefault: boolean } };
    expect(body.policy.dailyKeep).toBe(45);
    expect(body.policy.isDefault).toBe(false);

    // Effective policy now reflects the tenant override, seen from the device's own read.
    const { headers } = await issueDeviceToken(
      env,
      (await seedDevice(env.DB, { tenantId })).deviceId,
    );
    const effective = await app.request("/api/v1/backups/policy", { headers }, env);
    const effectiveBody = (await effective.json()) as { dailyKeep: number };
    expect(effectiveBody.dailyKeep).toBe(45);
  });
});

describe("POST /api/v1/backups/restore-tests", () => {
  it("validates the device belongs to the tenant and the artifact belongs to the device", async () => {
    const { tenantId, deviceId } = await deviceContext();
    const admin = await signInAs(env, {
      email: "backups-restore-admin@example.test",
      staffRole: "admin",
    });

    const res = await app.request(
      "/api/v1/backups/restore-tests",
      {
        method: "POST",
        headers: { ...admin.headers, "content-type": "application/json" },
        body: JSON.stringify({
          tenantId,
          deviceId,
          artifactId: "bka_does-not-exist",
          outcome: "success",
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("403s for a staff member without backup.restore", async () => {
    const { tenantId, deviceId } = await deviceContext();
    const viewer = await signInAs(env, {
      email: "backups-restore-viewer@example.test",
      staffRole: "read_only",
    });
    const res = await app.request(
      "/api/v1/backups/restore-tests",
      {
        method: "POST",
        headers: { ...viewer.headers, "content-type": "application/json" },
        body: JSON.stringify({ tenantId, deviceId, artifactId: "bka_x", outcome: "success" }),
      },
      env,
    );
    expect(res.status).toBe(403);
  });
});
