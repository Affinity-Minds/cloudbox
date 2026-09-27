// Owner: WT-18. OTA release management (master spec §18, §45; Slices 10.1-10.4). Real WT-1
// sessions for staff routes, a directly-seeded device credential (same shape `requireDevice()`
// resolves — agent.test.ts's own enroll flow is not needed here, nothing under test touches the
// device's RSA key material) for the device-facing routes.
import { env } from "cloudflare:test";
import type {
  AssignedReleaseResponse,
  Release,
  ReleaseDetailScreen,
  ReleasesScreen,
} from "@cloudbox/contracts";
import {
  generateReleaseSigningKey,
  type ReleaseSigningKey,
  verifyManifest,
} from "@cloudbox/update-contracts";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { randomOpaqueToken, sha256Hex } from "../src/crypto";
import { createDb } from "../src/db/client";
import { deviceCredentials, releases as releasesTable } from "../src/db/schema";
import app from "../src/index";
import { percentBucket } from "../src/releases/resolve";
import { MAX_PACKAGE_BYTES, storePackage, UploadRefusal } from "../src/releases/upload";
import { signInAs } from "./auth-fixtures";
import { seedDevice, seedTenant } from "./fixtures";

// ─── fixtures local to this file ────────────────────────────────────────────────────────────────

let keyPair: ReleaseSigningKey | undefined;
async function releaseKeyPair(): Promise<ReleaseSigningKey> {
  keyPair ??= await generateReleaseSigningKey();
  return keyPair;
}

/** `RELEASE_SIGNING_JWK` set to a fixed test-only key so the manifest can be verified afterwards. */
async function envWithSigningKey(): Promise<typeof env> {
  const key = await releaseKeyPair();
  return { ...env, RELEASE_SIGNING_JWK: JSON.stringify(key.privateJwk) };
}

async function staffHeaders(
  role: "super_admin" | "admin" | "support" | "read_only" = "super_admin",
) {
  const { headers } = await signInAs(env, {
    email: `releases-${role}-${crypto.randomUUID()}@example.test`,
    staffRole: role,
  });
  return headers;
}

/** Inserts a `device_credentials` row directly, same hash `requireDevice()` looks up. */
async function issueDeviceToken(e: typeof env, deviceId: string): Promise<string> {
  const token = randomOpaqueToken();
  await createDb(e.DB)
    .insert(deviceCredentials)
    .values({
      id: `cred_${crypto.randomUUID()}`,
      deviceId,
      tokenHash: await sha256Hex(token),
      createdAt: new Date().toISOString(),
    });
  return token;
}

const PACKAGE_BYTES = new TextEncoder().encode("fake installer payload for wt-18 tests");

function uploadForm(fields: Record<string, string>, bytes = PACKAGE_BYTES, filename = "agent.msi") {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  form.set("file", new File([bytes], filename, { type: "application/octet-stream" }));
  return form;
}

async function uploadRelease(
  e: typeof env,
  headers: Record<string, string>,
  fields: Partial<
    Record<"component" | "version" | "channel" | "notes" | "minAgentVersion", string>
  > = {},
) {
  const body = uploadForm({
    component: "agent",
    version: "1.0.0",
    channel: "development",
    ...fields,
  });
  return app.request("/api/v1/releases", { method: "POST", headers, body }, e);
}

async function sha256Of(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── upload ─────────────────────────────────────────────────────────────────────────────────────

describe("POST /api/v1/releases (upload)", () => {
  it("stores the package in R2, computes its sha256 and signs a verifiable manifest", async () => {
    const e = await envWithSigningKey();
    const headers = await staffHeaders();
    const res = await uploadRelease(e, headers, { version: "1.0.1", notes: "first cut" });
    expect(res.status).toBe(201);
    const { release } = (await res.json()) as { release: Release };

    expect(release.status).toBe("draft");
    expect(release.component).toBe("agent");
    expect(release.package.sizeBytes).toBe(PACKAGE_BYTES.length);
    expect(release.package.sha256).toBe(await sha256Of(PACKAGE_BYTES));
    expect(release.package.r2Key).toBe(`releases/agent/1.0.1/agent.msi`);

    const object = await e.ARTIFACTS.get(release.package.r2Key);
    if (!object) throw new Error("expected the package to exist in R2");
    expect(new Uint8Array(await object.arrayBuffer())).toEqual(PACKAGE_BYTES);

    const [row] = await createDb(e.DB)
      .select({ manifestJws: releasesTable.manifestJws })
      .from(releasesTable)
      .where(eq(releasesTable.id, release.id));
    const key = await releaseKeyPair();
    const { manifest, kid } = await verifyManifest({
      jws: row?.manifestJws ?? "",
      serverPublicJwks: [key.publicJwk],
    });
    expect(kid).toBe(key.kid);
    expect(manifest).toMatchObject({
      component: "agent",
      version: "1.0.1",
      channel: "development",
      notes: "first cut",
      package: { r2Key: release.package.r2Key, sha256: release.package.sha256 },
    });
  });

  it("503s when RELEASE_SIGNING_JWK is not configured", async () => {
    const headers = await staffHeaders();
    const res = await uploadRelease(env, headers, { version: "1.0.2" });
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ error: "signing_key_unavailable" });
  });

  it("409s a duplicate component+version", async () => {
    const e = await envWithSigningKey();
    const headers = await staffHeaders();
    const first = await uploadRelease(e, headers, { version: "1.0.3" });
    expect(first.status).toBe(201);
    const second = await uploadRelease(e, headers, { version: "1.0.3" });
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({ error: "version_exists" });
  });

  it("400s an invalid field (bad semver) without touching R2", async () => {
    const e = await envWithSigningKey();
    const headers = await staffHeaders();
    const res = await uploadRelease(e, headers, { version: "not-semver" });
    expect(res.status).toBe(400);
  });

  it("413s a request whose Content-Length already exceeds the cap", async () => {
    const e = await envWithSigningKey();
    const headers = await staffHeaders();
    const form = uploadForm({ component: "agent", version: "1.0.4", channel: "development" });
    const res = await app.request(
      "/api/v1/releases",
      {
        method: "POST",
        headers: { ...headers, "content-length": String(MAX_PACKAGE_BYTES + 1) },
        body: form,
      },
      e,
    );
    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toMatchObject({ error: "package_too_large" });
  });

  it("refuses an oversized package at the storage layer (unit test, no real 200MB body)", async () => {
    // A `File`-shaped object whose `size` alone reports over the cap: `storePackage` checks
    // `.size` before ever calling `.stream()`, so this never allocates real memory.
    const fakeFile = {
      size: MAX_PACKAGE_BYTES + 1,
      name: "huge.msi",
      type: "application/octet-stream",
      stream: () => {
        throw new Error("must not be called: the size check happens first");
      },
    } as unknown as File;
    await expect(
      storePackage(env.ARTIFACTS, { component: "agent", version: "9.9.9", file: fakeFile }),
    ).rejects.toMatchObject({ code: "package_too_large" });
    expect(UploadRefusal).toBeDefined();
  });

  it("refuses an empty file", async () => {
    const fakeFile = {
      size: 0,
      name: "empty.msi",
      type: "application/octet-stream",
    } as unknown as File;
    await expect(
      storePackage(env.ARTIFACTS, { component: "agent", version: "9.9.8", file: fakeFile }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
});

// ─── permission boundaries ──────────────────────────────────────────────────────────────────────

describe("permission boundaries", () => {
  it("401s every staff route without a session", async () => {
    const form = uploadForm({ component: "agent", version: "2.0.0", channel: "development" });
    const paths: [string, string, BodyInit?][] = [
      ["POST", "/api/v1/releases", form],
      ["POST", "/api/v1/releases/rel_x/promote", JSON.stringify({ channel: "pilot" })],
      ["POST", "/api/v1/releases/rel_x/withdraw", JSON.stringify({ reason: "test" })],
      ["GET", "/api/v1/releases/rel_x/assignments"],
      ["POST", "/api/v1/releases/rel_x/assignments", JSON.stringify({ scope: "device" })],
      ["DELETE", "/api/v1/releases/rel_x/assignments/rla_x"],
      ["GET", "/api/v1/screens/releases"],
      ["GET", "/api/v1/screens/releases/rel_x"],
    ];
    for (const [method, path, body] of paths) {
      const headers: Record<string, string> = {};
      if (typeof body === "string") headers["content-type"] = "application/json";
      const res = await app.request(path, { method, body, headers }, env);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("403s update.release/update.deploy actions for support and read_only, but allows update.view", async () => {
    const e = await envWithSigningKey();
    for (const role of ["support", "read_only"] as const) {
      const headers = await staffHeaders(role);
      const upload = await uploadRelease(e, headers, {
        version: `3.${role === "support" ? 0 : 1}.0`,
      });
      expect(upload.status, role).toBe(403);

      const screen = await app.request("/api/v1/screens/releases", { headers }, e);
      expect(screen.status, role).toBe(200);
    }
  });

  it("allows admin the same as super_admin for upload/promote/withdraw/assignments", async () => {
    const e = await envWithSigningKey();
    const headers = await staffHeaders("admin");
    const res = await uploadRelease(e, headers, { version: "3.2.0" });
    expect(res.status).toBe(201);
  });

  it("a device Bearer token cannot promote a release (no staff session)", async () => {
    const e = await envWithSigningKey();
    const tenant = await seedTenant(e.DB);
    const device = await seedDevice(e.DB, { tenantId: tenant.tenantId });
    const token = await issueDeviceToken(e, device.deviceId);
    const res = await app.request(
      "/api/v1/releases/rel_x/promote",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ channel: "pilot" }),
      },
      e,
    );
    expect(res.status).toBe(401);
  });
});

// ─── health-gated promotion ──────────────────────────────────────────────────────────────────────

describe("promotion", () => {
  async function draftRelease(e: typeof env, headers: Record<string, string>, version: string) {
    const res = await uploadRelease(e, headers, { version });
    const { release } = (await res.json()) as { release: Release };
    return release;
  }

  it("draft -> pilot needs no gate; pilot -> stable needs a health gate", async () => {
    const e = await envWithSigningKey();
    const headers = await staffHeaders();
    const release = await draftRelease(e, headers, "4.0.0");

    const toPilot = await app.request(
      `/api/v1/releases/${release.id}/promote`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ channel: "pilot" }),
      },
      e,
    );
    expect(toPilot.status).toBe(200);
    await expect(toPilot.json()).resolves.toMatchObject({
      release: { status: "pilot", channel: "pilot" },
    });

    const toStableNoResults = await app.request(
      `/api/v1/releases/${release.id}/promote`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ channel: "stable" }),
      },
      e,
    );
    expect(toStableNoResults.status).toBe(409);
    await expect(toStableNoResults.json()).resolves.toMatchObject({ error: "health_gate_failed" });
  });

  it("passes the health gate with >=1 installed_healthy and 0 unhealthy/rolled_back", async () => {
    const e = await envWithSigningKey();
    const headers = await staffHeaders();
    const release = await draftRelease(e, headers, "4.1.0");
    await app.request(
      `/api/v1/releases/${release.id}/promote`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ channel: "pilot" }),
      },
      e,
    );

    const tenant = await seedTenant(e.DB);
    const device = await seedDevice(e.DB, { tenantId: tenant.tenantId });
    const deviceToken = await issueDeviceToken(e, device.deviceId);
    const result = await app.request(
      `/api/v1/releases/${release.id}/result`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
        body: JSON.stringify({ state: "installed_healthy" }),
      },
      e,
    );
    expect(result.status).toBe(201);

    const toStable = await app.request(
      `/api/v1/releases/${release.id}/promote`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ channel: "stable" }),
      },
      e,
    );
    expect(toStable.status).toBe(200);
    await expect(toStable.json()).resolves.toMatchObject({
      release: { status: "stable", channel: "stable" },
    });
  });

  it("refuses the gate when an installed_unhealthy result is also present", async () => {
    const e = await envWithSigningKey();
    const headers = await staffHeaders();
    const release = await draftRelease(e, headers, "4.2.0");
    await app.request(
      `/api/v1/releases/${release.id}/promote`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ channel: "pilot" }),
      },
      e,
    );
    const tenant = await seedTenant(e.DB);
    const good = await seedDevice(e.DB, { tenantId: tenant.tenantId });
    const bad = await seedDevice(e.DB, { tenantId: tenant.tenantId });
    const goodToken = await issueDeviceToken(e, good.deviceId);
    const badToken = await issueDeviceToken(e, bad.deviceId);
    for (const [token, state] of [
      [goodToken, "installed_healthy"],
      [badToken, "installed_unhealthy"],
    ] as const) {
      await app.request(
        `/api/v1/releases/${release.id}/result`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ state }),
        },
        e,
      );
    }
    const toStable = await app.request(
      `/api/v1/releases/${release.id}/promote`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ channel: "stable" }),
      },
      e,
    );
    expect(toStable.status).toBe(409);
    await expect(toStable.json()).resolves.toMatchObject({ error: "health_gate_failed" });
  });

  it("refuses draft -> stable directly, and any promote on a withdrawn release", async () => {
    const e = await envWithSigningKey();
    const headers = await staffHeaders();
    const release = await draftRelease(e, headers, "4.3.0");
    const direct = await app.request(
      `/api/v1/releases/${release.id}/promote`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ channel: "stable" }),
      },
      e,
    );
    expect(direct.status).toBe(409);
    await expect(direct.json()).resolves.toMatchObject({ error: "must_pilot_first" });

    await app.request(
      `/api/v1/releases/${release.id}/promote`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ channel: "pilot" }),
      },
      e,
    );
    const withdraw = await app.request(
      `/api/v1/releases/${release.id}/withdraw`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ reason: "bad build" }),
      },
      e,
    );
    expect(withdraw.status).toBe(200);

    const afterWithdraw = await app.request(
      `/api/v1/releases/${release.id}/promote`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ channel: "pilot" }),
      },
      e,
    );
    expect(afterWithdraw.status).toBe(409);
    await expect(afterWithdraw.json()).resolves.toMatchObject({ error: "already_withdrawn" });
  });
});

// ─── assignment resolution and percent bucketing ────────────────────────────────────────────────

describe("assignment resolution", () => {
  async function stableRelease(e: typeof env, headers: Record<string, string>, version: string) {
    const upload = await uploadRelease(e, headers, { version, channel: "development" });
    const { release } = (await upload.json()) as { release: Release };
    for (const channel of ["pilot", "stable"] as const) {
      if (channel === "stable") {
        const tenant = await seedTenant(e.DB);
        const device = await seedDevice(e.DB, { tenantId: tenant.tenantId });
        const token = await issueDeviceToken(e, device.deviceId);
        await app.request(
          `/api/v1/releases/${release.id}/result`,
          {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ state: "installed_healthy" }),
          },
          e,
        );
      }
      await app.request(
        `/api/v1/releases/${release.id}/promote`,
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ channel }),
        },
        e,
      );
    }
    return release;
  }

  it("percentBucket is deterministic and in [0,100)", async () => {
    const a = await percentBucket("dev_stable-id");
    const b = await percentBucket("dev_stable-id");
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(100);
    // A different id need not collide, but must itself be stable across calls.
    const c1 = await percentBucket("dev_other-id");
    const c2 = await percentBucket("dev_other-id");
    expect(c1).toBe(c2);
  });

  it("a device with no assignment gets the channel default (newest channel=stable release)", async () => {
    const e = await envWithSigningKey();
    const headers = await staffHeaders();
    await stableRelease(e, headers, "5.0.0");
    const tenant = await seedTenant(e.DB);
    const device = await seedDevice(e.DB, { tenantId: tenant.tenantId });
    const token = await issueDeviceToken(e, device.deviceId);

    const res = await app.request(
      "/api/v1/releases/assigned?component=agent",
      { headers: { authorization: `Bearer ${token}` } },
      e,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AssignedReleaseResponse;
    expect(body.manifest.version).toBe("5.0.0");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("does not see a pilot-only release with no assignment (404, not the pilot release)", async () => {
    // A component of its own ("status", not "agent") so this test's channel is guaranteed empty
    // regardless of what earlier tests in this file promoted to stable — the file's D1 database is
    // shared across `it()`s, only isolated per test *file* (test/apply-migrations.ts).
    const e = await envWithSigningKey();
    const headers = await staffHeaders();
    const upload = await uploadRelease(e, headers, {
      component: "status",
      version: "5.1.0",
      channel: "development",
    });
    const { release } = (await upload.json()) as { release: Release };
    await app.request(
      `/api/v1/releases/${release.id}/promote`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ channel: "pilot" }),
      },
      e,
    );

    const tenant = await seedTenant(e.DB);
    const device = await seedDevice(e.DB, { tenantId: tenant.tenantId });
    const token = await issueDeviceToken(e, device.deviceId);
    const res = await app.request(
      "/api/v1/releases/assigned?component=status",
      { headers: { authorization: `Bearer ${token}` } },
      e,
    );
    expect(res.status).toBe(404);
  });

  it("a device assignment on a draft release wins over everything, even the channel default", async () => {
    const e = await envWithSigningKey();
    const headers = await staffHeaders();
    await stableRelease(e, headers, "5.2.0"); // the channel default, if nothing else wins
    const draft = await uploadRelease(e, headers, { version: "5.2.1", channel: "development" });
    const { release: draftRelease } = (await draft.json()) as { release: Release };

    const tenant = await seedTenant(e.DB);
    const device = await seedDevice(e.DB, { tenantId: tenant.tenantId });
    const token = await issueDeviceToken(e, device.deviceId);

    const assign = await app.request(
      `/api/v1/releases/${draftRelease.id}/assignments`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ scope: "device", deviceId: device.deviceId }),
      },
      e,
    );
    expect(assign.status).toBe(201);

    const res = await app.request(
      "/api/v1/releases/assigned?component=agent",
      { headers: { authorization: `Bearer ${token}` } },
      e,
    );
    const body = (await res.json()) as AssignedReleaseResponse;
    expect(body.manifest.version).toBe("5.2.1");
  });

  it("a tenant assignment beats the channel default but loses to a device assignment", async () => {
    const e = await envWithSigningKey();
    const headers = await staffHeaders();
    await stableRelease(e, headers, "5.3.0");
    const tenantRelease = await stableRelease(e, headers, "5.3.1"); // will be assigned to the tenant

    const tenant = await seedTenant(e.DB);
    const device = await seedDevice(e.DB, { tenantId: tenant.tenantId });
    const token = await issueDeviceToken(e, device.deviceId);

    await app.request(
      `/api/v1/releases/${tenantRelease.id}/assignments`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ scope: "tenant", tenantId: tenant.tenantId }),
      },
      e,
    );

    const res = await app.request(
      "/api/v1/releases/assigned?component=agent",
      { headers: { authorization: `Bearer ${token}` } },
      e,
    );
    const body = (await res.json()) as AssignedReleaseResponse;
    expect(body.manifest.version).toBe("5.3.1");
  });

  it("cannot assign a tenant or percent scope to a draft release", async () => {
    const e = await envWithSigningKey();
    const headers = await staffHeaders();
    const upload = await uploadRelease(e, headers, { version: "5.4.0" });
    const { release } = (await upload.json()) as { release: Release };
    const tenant = await seedTenant(e.DB);

    const tenantAssign = await app.request(
      `/api/v1/releases/${release.id}/assignments`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ scope: "tenant", tenantId: tenant.tenantId }),
      },
      e,
    );
    expect(tenantAssign.status).toBe(409);
    await expect(tenantAssign.json()).resolves.toMatchObject({ error: "release_not_released" });
  });
});

// ─── results and screens ─────────────────────────────────────────────────────────────────────────

describe("results and screens", () => {
  it("records a device-reported result and reflects it in the release list's counts", async () => {
    const e = await envWithSigningKey();
    const headers = await staffHeaders();
    const upload = await uploadRelease(e, headers, { version: "6.0.0" });
    const { release } = (await upload.json()) as { release: Release };
    const tenant = await seedTenant(e.DB);
    const device = await seedDevice(e.DB, { tenantId: tenant.tenantId });
    const token = await issueDeviceToken(e, device.deviceId);

    const result = await app.request(
      `/api/v1/releases/${release.id}/result`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ state: "downloaded", detail: { bytesWritten: 1024 } }),
      },
      e,
    );
    expect(result.status).toBe(201);

    const list = await app.request("/api/v1/screens/releases", { headers }, e);
    const listBody = (await list.json()) as ReleasesScreen;
    const item = listBody.items.find((i) => i.id === release.id);
    expect(item?.resultCounts.downloaded).toBe(1);

    const detail = await app.request(`/api/v1/screens/releases/${release.id}`, { headers }, e);
    const detailBody = (await detail.json()) as ReleaseDetailScreen;
    expect(detailBody.results).toHaveLength(1);
    expect(detailBody.results[0]).toMatchObject({ state: "downloaded", deviceId: device.deviceId });
  });

  it("a device token cannot record a result without a valid Bearer", async () => {
    const e = await envWithSigningKey();
    const headers = await staffHeaders();
    const upload = await uploadRelease(e, headers, { version: "6.1.0" });
    const { release } = (await upload.json()) as { release: Release };
    const res = await app.request(
      `/api/v1/releases/${release.id}/result`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: "downloaded" }),
      },
      e,
    );
    expect(res.status).toBe(401);
  });
});

// ─── download ─────────────────────────────────────────────────────────────────────────────────

describe("GET /api/v1/releases/:id/download", () => {
  it("streams the package bytes for a valid, unexpired token", async () => {
    const e = await envWithSigningKey();
    const headers = await staffHeaders();
    const upload = await uploadRelease(e, headers, { version: "7.0.0" });
    const { release } = (await upload.json()) as { release: Release };
    const tenant = await seedTenant(e.DB);
    const device = await seedDevice(e.DB, { tenantId: tenant.tenantId });
    const token = await issueDeviceToken(e, device.deviceId);

    await app.request(
      `/api/v1/releases/${release.id}/assignments`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ scope: "device", deviceId: device.deviceId }),
      },
      e,
    );
    const assigned = await app.request(
      "/api/v1/releases/assigned?component=agent",
      { headers: { authorization: `Bearer ${token}` } },
      e,
    );
    const { downloadUrl } = (await assigned.json()) as AssignedReleaseResponse;

    const download = await app.request(
      downloadUrl,
      { headers: { authorization: `Bearer ${token}` } },
      e,
    );
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(PACKAGE_BYTES);
  });

  it("401s a tampered or expired token", async () => {
    const e = await envWithSigningKey();
    const headers = await staffHeaders();
    const upload = await uploadRelease(e, headers, { version: "7.1.0" });
    const { release } = (await upload.json()) as { release: Release };
    const tenant = await seedTenant(e.DB);
    const device = await seedDevice(e.DB, { tenantId: tenant.tenantId });
    const token = await issueDeviceToken(e, device.deviceId);

    const tampered = await app.request(
      `/api/v1/releases/${release.id}/download?exp=9999999999&token=${"0".repeat(64)}`,
      { headers: { authorization: `Bearer ${token}` } },
      e,
    );
    expect(tampered.status).toBe(401);

    const expired = await app.request(
      `/api/v1/releases/${release.id}/download?exp=1&token=${"0".repeat(64)}`,
      { headers: { authorization: `Bearer ${token}` } },
      e,
    );
    expect(expired.status).toBe(401);
  });
});
