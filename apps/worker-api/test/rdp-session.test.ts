// Owner: WT-11. POST /api/v1/connect/devices/:deviceId/session (ADR 0013): membership boundary,
// slot assignment, expiry, and audit. Every request goes through the real WT-1 middleware with a
// real Better Auth customer session (signInAs), same pattern as test/subscriptions.test.ts.
import { env } from "cloudflare:test";
import type { RdpSessionResponse } from "@cloudbox/contracts";
import { eq } from "drizzle-orm";
import { calculateJwkThumbprint, compactDecrypt, exportJWK, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db/client";
import { devices, tenantMemberships, tenants } from "../src/db/schema";
import { newId, nowIso } from "../src/ids";
import app from "../src/index";
import { rdpSessionGrants } from "../src/rdp/session-grants-table";
import { type SignedIn, signInAs } from "./auth-fixtures";
import { seedSubscription } from "./fixtures";

let seq = 0;

async function seedTenant() {
  seq += 1;
  const id = `ten_wt11_${crypto.randomUUID()}`;
  await createDb(env.DB)
    .insert(tenants)
    .values({
      id,
      publicCode: `CBX-8${String(seq).padStart(4, "0")}${Math.floor(Math.random() * 1000)}`,
      displayName: `WT-11 Org ${seq}`,
      status: "active",
    });
  return id;
}

async function seedMember(
  tenantId: string,
  user: SignedIn,
  standing: "owner" | "admin" | "user" = "user",
) {
  await createDb(env.DB)
    .insert(tenantMemberships)
    .values({
      id: newId("membership"),
      tenantId,
      userId: user.userId,
      standing,
      status: "active",
      createdAt: nowIso(),
    });
}

async function seedDeviceWithRealKey(
  tenantId: string,
  status: "enrolled" | "revoked" = "enrolled",
) {
  const { publicKey, privateKey } = await generateKeyPair("RSA-OAEP-256", {
    modulusLength: 2048,
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  const deviceId = `dev_${crypto.randomUUID()}`;
  await createDb(env.DB)
    .insert(devices)
    .values({
      id: deviceId,
      tenantId,
      name: `CLOUDBOX-${deviceId.slice(4, 9)}`,
      status,
      devicePublicKeyJwk: JSON.stringify(publicJwk),
      deviceKeyThumbprint: await calculateJwkThumbprint(publicJwk, "sha256"),
      keyProtection: "software",
      hostname: "lab-pc",
    });
  return { deviceId, privateKey };
}

function call(method: string, path: string, who: SignedIn | null) {
  return app.request(
    `/api/v1${path}`,
    { method, headers: { "content-type": "application/json", ...(who?.headers ?? {}) } },
    env,
  );
}

describe("POST /connect/devices/:deviceId/session", () => {
  let member: SignedIn;
  let stranger: SignedIn;

  beforeAll(async () => {
    member = await signInAs(env, { email: "wt11-member@example.test" });
    stranger = await signInAs(env, { email: "wt11-stranger@example.test" });
  });

  it("grants a managed-user credential to an active member (slot 1, generation from an empty device)", async () => {
    const tenantId = await seedTenant();
    await seedSubscription(env.DB, { tenantId, maxManagedUsers: 3 });
    await seedMember(tenantId, member);
    const { deviceId, privateKey } = await seedDeviceWithRealKey(tenantId);

    const res = await call(
      "POST",
      `/connect/devices/${deviceId}/session?tenantId=${tenantId}`,
      member,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as RdpSessionResponse;
    expect(body.deviceId).toBe(deviceId);
    expect(body.user).toBe("cloud01");
    expect(body.password).toHaveLength(20);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // Audited without ever writing the password or its hash.
    const rows = await createDb(env.DB)
      .select()
      .from(rdpSessionGrants)
      .where(eq(rdpSessionGrants.deviceId, deviceId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.slot).toBe(1);
    expect(JSON.stringify(rows[0])).not.toContain(body.password);

    // The stored ciphertext decrypts, with this device's own key, to exactly the returned password.
    const jwe = rows[0]?.passwordCiphertext ?? "";
    const { plaintext } = await compactDecrypt(jwe, privateKey);
    expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual({ password: body.password });
  });

  it("assigns the lowest free slot, skipping one already granted", async () => {
    const tenantId = await seedTenant();
    await seedSubscription(env.DB, { tenantId, maxManagedUsers: 3 });
    await seedMember(tenantId, member);
    const { deviceId } = await seedDeviceWithRealKey(tenantId);

    const first = (await (
      await call("POST", `/connect/devices/${deviceId}/session?tenantId=${tenantId}`, member)
    ).json()) as RdpSessionResponse;
    expect(first.user).toBe("cloud01");

    const second = (await (
      await call("POST", `/connect/devices/${deviceId}/session?tenantId=${tenantId}`, member)
    ).json()) as RdpSessionResponse;
    expect(second.user).toBe("cloud02");
  });

  it("409s once every managed slot is already granted", async () => {
    const tenantId = await seedTenant();
    await seedSubscription(env.DB, { tenantId, maxManagedUsers: 1 });
    await seedMember(tenantId, member);
    const { deviceId } = await seedDeviceWithRealKey(tenantId);

    const ok = await call(
      "POST",
      `/connect/devices/${deviceId}/session?tenantId=${tenantId}`,
      member,
    );
    expect(ok.status).toBe(201);

    const full = await call(
      "POST",
      `/connect/devices/${deviceId}/session?tenantId=${tenantId}`,
      member,
    );
    expect(full.status).toBe(409);
    expect(await full.json()).toEqual({ error: "no_free_slot" });
  });

  it("re-grants a slot once its grant has expired", async () => {
    const tenantId = await seedTenant();
    await seedSubscription(env.DB, { tenantId, maxManagedUsers: 1 });
    await seedMember(tenantId, member);
    const { deviceId } = await seedDeviceWithRealKey(tenantId);

    const first = await call(
      "POST",
      `/connect/devices/${deviceId}/session?tenantId=${tenantId}`,
      member,
    );
    expect(first.status).toBe(201);

    // Force the grant into the past instead of waiting out the real 15-minute TTL.
    await createDb(env.DB)
      .update(rdpSessionGrants)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(rdpSessionGrants.deviceId, deviceId));

    const again = await call(
      "POST",
      `/connect/devices/${deviceId}/session?tenantId=${tenantId}`,
      member,
    );
    expect(again.status).toBe(201);
    expect(((await again.json()) as RdpSessionResponse).user).toBe("cloud01");
  });

  it("403s a signed-in customer who is not a member of the device's tenant (tenant boundary)", async () => {
    const tenantId = await seedTenant();
    await seedSubscription(env.DB, { tenantId, maxManagedUsers: 3 });
    await seedMember(tenantId, member);
    const { deviceId } = await seedDeviceWithRealKey(tenantId);

    const res = await call(
      "POST",
      `/connect/devices/${deviceId}/session?tenantId=${tenantId}`,
      stranger,
    );
    expect(res.status).toBe(403);
  });

  it("403s a member of a different tenant who is not a member of this device's own tenant", async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    await seedSubscription(env.DB, { tenantId: tenantA, maxManagedUsers: 3 });
    await seedSubscription(env.DB, { tenantId: tenantB, maxManagedUsers: 3 });
    await seedMember(tenantB, member);
    const { deviceId } = await seedDeviceWithRealKey(tenantA);

    // The caller is an active member of tenant B, but the device belongs to tenant A.
    const res = await call(
      "POST",
      `/connect/devices/${deviceId}/session?tenantId=${tenantB}`,
      member,
    );
    expect(res.status).toBe(404);
  });

  it("401s an unauthenticated caller", async () => {
    const tenantId = await seedTenant();
    const { deviceId } = await seedDeviceWithRealKey(tenantId);
    const res = await call(
      "POST",
      `/connect/devices/${deviceId}/session?tenantId=${tenantId}`,
      null,
    );
    expect(res.status).toBe(401);
  });

  it("audits RDP_SESSION_GRANTED with no secret in before/after", async () => {
    const tenantId = await seedTenant();
    await seedSubscription(env.DB, { tenantId, maxManagedUsers: 3 });
    await seedMember(tenantId, member);
    const { deviceId } = await seedDeviceWithRealKey(tenantId);

    await call("POST", `/connect/devices/${deviceId}/session?tenantId=${tenantId}`, member);

    const auditRes = await env.DB.prepare(
      "SELECT after_json FROM audit_log WHERE event_type = 'RDP_SESSION_GRANTED' AND entity_id = ?1",
    )
      .bind(deviceId)
      .all<{ after_json: string }>();
    expect(auditRes.results).toHaveLength(1);
    const after = JSON.parse(auditRes.results[0]?.after_json ?? "{}");
    expect(after).toMatchObject({ user: "cloud01", slot: 1 });
    expect(JSON.stringify(after)).not.toMatch(/password/i);
  });
});
