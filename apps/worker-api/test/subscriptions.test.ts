// Owner: WT-5. Plans, subscriptions, entitlement issuance/renewal/revocation, subscription screens.
//
// Authorization: WT-1 implements `requirePermission`. Until its spine is merged, the middleware is
// mocked here with a header-driven stand-in so the handlers are exercised; the real permission
// boundary per key is `test.todo` at the bottom and becomes live once `signInAs` exists.
import { env } from "cloudflare:test";
import type {
  AuditEntry,
  IssueEntitlementResponse,
  SubscriptionDetailScreen,
  SubscriptionsScreen,
} from "@cloudbox/contracts";
import {
  generateServerSigningKey,
  type ServerSigningKey,
  verifyEntitlement,
} from "@cloudbox/licensing-contracts";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, type JWK } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db/client";
import { auditLog, devices, entitlements, signingKeys, tenants } from "../src/db/schema";
import { currentEntitlementForDevice } from "../src/entitlement/service";
import type { AppEnv } from "../src/env";
import { countingD1 } from "./fixtures";

vi.mock("../src/authz/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/authz/permissions")>();
  return {
    ...actual,
    // Stand-in for WT-1: grants exactly the keys listed in `x-test-permissions`.
    requirePermission:
      (key: string): MiddlewareHandler<AppEnv> =>
      async (c, next) => {
        const granted = (c.req.header("x-test-permissions") ?? "").split(",");
        if (!granted.includes(key)) return c.json({ error: "forbidden" }, 403);
        c.set("user", { id: "usr_test", email: "t@example.test", name: "T", staffRole: null });
        await next();
      },
  };
});

const ALL = [
  "subscription.view",
  "subscription.manage",
  "license.issue",
  "license.renew",
  "license.revoke",
].join(",");

let server: ServerSigningKey;
let testEnv: typeof env;
// The pool evaluates `main` (src/index.ts) before this file's mock is registered, so the app is
// re-imported from a fresh module registry to pick the stand-in up.
let app: (typeof import("../src/index"))["default"];

beforeAll(async () => {
  vi.resetModules();
  app = (await import("../src/index")).default;
  server = await generateServerSigningKey();
  testEnv = { ...env, ENTITLEMENT_SIGNING_JWK: JSON.stringify(server.privateJwk) };
});

function call(
  method: string,
  path: string,
  body?: unknown,
  opts: { permissions?: string; env?: typeof env } = {},
) {
  return app.request(
    `/api/v1${path}`,
    {
      method,
      headers: {
        "content-type": "application/json",
        "x-test-permissions": opts.permissions ?? ALL,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    opts.env ?? testEnv,
  );
}

let seq = 0;
async function seedTenant(): Promise<string> {
  seq += 1;
  const id = `ten_wt5_${crypto.randomUUID()}`;
  await createDb(env.DB)
    .insert(tenants)
    .values({
      id,
      publicCode: `CBX-9${String(seq).padStart(4, "0")}${Math.floor(Math.random() * 1000)}`,
      displayName: `WT-5 Org ${seq}`,
      status: "active",
    });
  return id;
}

type SeededDevice = { deviceId: string; privateJwk: JWK };
async function seedDevice(tenantId: string, status: "enrolled" | "revoked" = "enrolled") {
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
  return { deviceId, privateJwk: await exportJWK(privateKey) } satisfies SeededDevice;
}

const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();

async function createSubscription(tenantId: string, body: Record<string, unknown> = {}) {
  const response = await call("POST", `/tenants/${tenantId}/subscriptions`, {
    planCode: "cloudbox-6",
    validFrom: iso(-1),
    validUntil: iso(365),
    ...body,
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { subscription: { id: string } }).subscription.id;
}

async function auditFor(entityId: string): Promise<AuditEntry[]> {
  const rows = await createDb(env.DB)
    .select()
    .from(auditLog)
    .where(eq(auditLog.entityId, entityId));
  return rows.map((row) => ({
    ...row,
    before: row.beforeJson ? JSON.parse(row.beforeJson) : null,
    after: row.afterJson ? JSON.parse(row.afterJson) : null,
  }));
}

describe("GET /api/v1/plans", () => {
  it("lists the seeded cloudbox-6 plan", async () => {
    const response = await call("GET", "/plans");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[] };
    expect(body.items).toContainEqual({
      code: "cloudbox-6",
      name: "CloudBox 6",
      maxDevices: 1,
      maxManagedUsers: 6,
      features: ["remote_access", "managed_backup", "fleet"],
      offlineGraceDays: 7,
      renewalWarningDays: 30,
    });
  });
});

describe("subscriptions", () => {
  it("creates with plan defaults and audits SUBSCRIPTION_CHANGED", async () => {
    const tenantId = await seedTenant();
    const response = await call("POST", `/tenants/${tenantId}/subscriptions`, {
      planCode: "cloudbox-6",
      validFrom: iso(0),
      validUntil: iso(365),
      offlineGraceDays: 14,
    });
    expect(response.status).toBe(201);
    const { subscription } = (await response.json()) as {
      subscription: Record<string, unknown> & { id: string };
    };
    expect(subscription).toMatchObject({
      tenantId,
      planCode: "cloudbox-6",
      status: "active",
      maxManagedUsers: 6,
      offlineGraceDays: 14,
      renewalWarningDays: 30,
      features: ["remote_access", "managed_backup", "fleet"],
    });
    expect(subscription.id).toMatch(/^sub_/);

    const [event] = await auditFor(subscription.id);
    expect(event).toMatchObject({
      eventType: "SUBSCRIPTION_CHANGED",
      action: "created",
      actorType: "user",
      actorId: "usr_test",
      before: null,
      after: { id: subscription.id, status: "active" },
    });

    const list = await call("GET", `/tenants/${tenantId}/subscriptions`);
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(1);
  });

  it("enforces the date, plan, tenant and one-open-subscription rules", async () => {
    const tenantId = await seedTenant();
    const bad = (body: unknown) => call("POST", `/tenants/${tenantId}/subscriptions`, body);

    expect(
      (await bad({ planCode: "cloudbox-6", validFrom: iso(10), validUntil: iso(5) })).status,
    ).toBe(400);
    const unknownPlan = await bad({ planCode: "nope", validFrom: iso(0), validUntil: iso(5) });
    expect(unknownPlan.status).toBe(400);
    expect(await unknownPlan.json()).toEqual({ error: "invalid_request", detail: "unknown_plan" });
    expect(
      (await bad({ planCode: "cloudbox-6", status: "cancelled", validFrom: iso(0), validUntil: iso(5) }))
        .status,
    ).toBe(400);
    expect(
      (
        await call("POST", "/tenants/ten_missing/subscriptions", {
          planCode: "cloudbox-6",
          validFrom: iso(0),
          validUntil: iso(5),
        })
      ).status,
    ).toBe(404);

    const first = await createSubscription(tenantId);
    const second = await bad({ planCode: "cloudbox-6", validFrom: iso(0), validUntil: iso(5) });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "subscription_exists", detail: first });
  });

  it("patches status and dates with before/after audit; cancelled is terminal", async () => {
    const tenantId = await seedTenant();
    const id = await createSubscription(tenantId);

    expect((await call("PATCH", `/subscriptions/${id}`, {})).status).toBe(400);
    expect(
      (await call("PATCH", `/subscriptions/${id}`, { validUntil: iso(-30) })).status,
    ).toBe(400);

    const extended = iso(730);
    const patched = await call("PATCH", `/subscriptions/${id}`, {
      status: "past_due",
      validUntil: extended,
    });
    expect(patched.status).toBe(200);
    const events = await auditFor(id);
    expect(events.at(-1)).toMatchObject({
      eventType: "SUBSCRIPTION_CHANGED",
      action: "updated",
      before: { status: "active" },
      after: { status: "past_due", validUntil: extended },
    });

    const cancelled = await call("PATCH", `/subscriptions/${id}`, { status: "cancelled" });
    expect(cancelled.status).toBe(200);
    expect((await auditFor(id)).at(-1)?.action).toBe("cancelled");
    expect((await call("PATCH", `/subscriptions/${id}`, { status: "active" })).status).toBe(409);
    expect((await call("PATCH", "/subscriptions/sub_missing", { status: "active" })).status).toBe(
      404,
    );

    // A cancelled subscription frees the tenant for a new one.
    await createSubscription(tenantId);
  });
});

describe("entitlement issuance", () => {
  it("refuses without an active subscription on the device's tenant (409)", async () => {
    const tenantId = await seedTenant();
    const { deviceId } = await seedDevice(tenantId);

    const none = await call("POST", `/devices/${deviceId}/entitlements/issue`, {});
    expect(none.status).toBe(409);
    expect(await none.json()).toEqual({ error: "no_active_subscription" });

    const subId = await createSubscription(tenantId, {
      validFrom: iso(-400),
      validUntil: iso(-1),
    });
    expect((await call("POST", `/devices/${deviceId}/entitlements/issue`, {})).status).toBe(409);

    await call("PATCH", `/subscriptions/${subId}`, { validUntil: iso(30), status: "suspended" });
    expect((await call("POST", `/devices/${deviceId}/entitlements/issue`, {})).status).toBe(409);

    // An active subscription on ANOTHER tenant does not license this device.
    const otherTenant = await seedTenant();
    await createSubscription(otherTenant);
    expect((await call("POST", `/devices/${deviceId}/entitlements/issue`, {})).status).toBe(409);
    expect(
      await createDb(env.DB).select().from(entitlements).where(eq(entitlements.deviceId, deviceId)),
    ).toHaveLength(0);
  });

  it("issues a device-bound JWE, stores it, audits claims but never the token", async () => {
    const tenantId = await seedTenant();
    const device = await seedDevice(tenantId);
    const subscriptionId = await createSubscription(tenantId);

    const response = await call("POST", `/devices/${device.deviceId}/entitlements/issue`, {});
    expect(response.status).toBe(201);
    const text = await response.text();
    const body = JSON.parse(text) as IssueEntitlementResponse;
    expect(body.entitlement).toMatchObject({
      deviceId: device.deviceId,
      subscriptionId,
      generation: 1,
      issuedBy: "usr_test",
      revokedAt: null,
    });
    expect(body.claims).toMatchObject({
      iss: "cloudbox",
      kid: server.kid,
      device_id: device.deviceId,
      tenant_id: tenantId,
      max_managed_users: 6,
      generation: 1,
    });

    const [row] = await createDb(env.DB)
      .select()
      .from(entitlements)
      .where(eq(entitlements.id, body.entitlement.id));
    expect(row?.token.split(".")).toHaveLength(5);
    expect(text).not.toContain(row?.token ?? "missing");
    expect(JSON.parse(row?.claimsJson ?? "{}")).toEqual(body.claims);

    // The device (and only the device) can open it; the signature checks against the pinned kid.
    const verified = await verifyEntitlement({
      token: row?.token ?? "",
      devicePrivateJwk: device.privateJwk,
      serverPublicJwks: [server.publicJwk],
    });
    expect(verified.claims).toEqual(body.claims);

    const events = await auditFor(body.entitlement.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "LICENSE_ISSUED", after: { claims: body.claims } });
    expect(JSON.stringify(events[0])).not.toContain(row?.token ?? "missing");

    // ensureSigningKey recorded the public half once.
    const keys = await createDb(env.DB)
      .select()
      .from(signingKeys)
      .where(eq(signingKeys.kid, server.kid));
    expect(keys).toHaveLength(1);
    expect(JSON.parse(keys[0]?.publicJwk ?? "{}")).toEqual(server.publicJwk);
  });

  it("strictly increases generation across issue and renew; renew caps at the subscription end", async () => {
    const tenantId = await seedTenant();
    const { deviceId } = await seedDevice(tenantId);
    await createSubscription(tenantId, { validUntil: iso(100) });

    const renewFirst = await call("POST", `/devices/${deviceId}/entitlements/renew`, {});
    expect(renewFirst.status).toBe(409);
    expect(await renewFirst.json()).toEqual({ error: "no_entitlement_to_renew" });

    const generations: number[] = [];
    for (const [action, validUntil] of [
      ["issue", iso(30)],
      ["renew", iso(500)],
      ["issue", undefined],
    ] as const) {
      const response = await call("POST", `/devices/${deviceId}/entitlements/${action}`, {
        validUntil,
      });
      expect(response.status).toBe(201);
      const body = (await response.json()) as IssueEntitlementResponse;
      generations.push(body.entitlement.generation);
      if (action === "renew") {
        // Asked for 500 days, capped at the subscription's 100.
        expect(Date.parse(body.entitlement.validUntil)).toBeLessThan(Date.now() + 101 * DAY);
      }
    }
    expect(generations).toEqual([1, 2, 3]);

    const events = await createDb(env.DB)
      .select({ eventType: auditLog.eventType })
      .from(auditLog)
      .innerJoin(entitlements, eq(entitlements.id, auditLog.entityId))
      .where(eq(entitlements.deviceId, deviceId));
    expect(events.map((e) => e.eventType).sort()).toEqual([
      "LICENSE_ISSUED",
      "LICENSE_ISSUED",
      "LICENSE_RENEWED",
    ]);
  });

  it("revoke needs a typed reason, revokes every live generation, and the agent gets nothing", async () => {
    const tenantId = await seedTenant();
    const { deviceId } = await seedDevice(tenantId);
    await createSubscription(tenantId);
    await call("POST", `/devices/${deviceId}/entitlements/issue`, {});
    await call("POST", `/devices/${deviceId}/entitlements/renew`, {});
    const db = createDb(env.DB);
    expect(await currentEntitlementForDevice(db, deviceId)).toMatchObject({ generation: 2 });

    expect((await call("POST", `/devices/${deviceId}/entitlements/revoke`, {})).status).toBe(400);
    expect(
      (await call("POST", `/devices/${deviceId}/entitlements/revoke`, { reason: "  " })).status,
    ).toBe(400);

    const revoked = await call("POST", `/devices/${deviceId}/entitlements/revoke`, {
      reason: "Customer returned the hardware",
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({ deviceId, revokedGenerations: [2, 1] });

    // What WT-3's GET /agent/entitlement serves: nothing, and never an older generation.
    expect(await currentEntitlementForDevice(db, deviceId)).toBeNull();
    const rows = await db.select().from(entitlements).where(eq(entitlements.deviceId, deviceId));
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);

    const history = await call("GET", `/devices/${deviceId}/entitlements`);
    const items = ((await history.json()) as { items: { id: string; generation: number }[] }).items;
    expect(items.map((i) => i.generation)).toEqual([2, 1]);
    expect(JSON.stringify(items)).not.toContain("token");
    const revokeEvents = (await auditFor(items[0]?.id ?? "")).filter(
      (e) => e.eventType === "LICENSE_REVOKED",
    );
    expect(revokeEvents[0]?.after).toMatchObject({
      reason: "Customer returned the hardware",
      generations: [2, 1],
    });

    const again = await call("POST", `/devices/${deviceId}/entitlements/revoke`, { reason: "x".repeat(5) });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "no_active_entitlement" });
    expect((await call("POST", `/devices/${deviceId}/entitlements/renew`, {})).status).toBe(409);

    // Re-licensing after revocation continues the sequence.
    const reissued = await call("POST", `/devices/${deviceId}/entitlements/issue`, {});
    expect(((await reissued.json()) as IssueEntitlementResponse).entitlement.generation).toBe(3);
  });

  it("refuses revoked devices, over-limit devices, unknown devices and a missing signing key", async () => {
    const tenantId = await seedTenant();
    await createSubscription(tenantId);
    const first = await seedDevice(tenantId);
    const second = await seedDevice(tenantId);
    const revoked = await seedDevice(tenantId, "revoked");

    const notEnrolled = await call("POST", `/devices/${revoked.deviceId}/entitlements/issue`, {});
    expect(notEnrolled.status).toBe(409);
    expect(await notEnrolled.json()).toEqual({ error: "device_not_enrolled" });

    expect((await call("POST", "/devices/dev_missing/entitlements/issue", {})).status).toBe(404);

    const noKey = await call(
      "POST",
      `/devices/${first.deviceId}/entitlements/issue`,
      {},
      { env: { ...env, ENTITLEMENT_SIGNING_JWK: undefined } },
    );
    expect(noKey.status).toBe(503);
    expect(await noKey.json()).toEqual({ error: "signing_key_unavailable" });

    expect((await call("POST", `/devices/${first.deviceId}/entitlements/issue`, {})).status).toBe(
      201,
    );
    // cloudbox-6 licenses one device.
    const overLimit = await call("POST", `/devices/${second.deviceId}/entitlements/issue`, {});
    expect(overLimit.status).toBe(409);
    expect(await overLimit.json()).toMatchObject({ error: "device_limit_reached" });
    // Revoking the first frees the seat.
    await call("POST", `/devices/${first.deviceId}/entitlements/revoke`, { reason: "swap" });
    expect((await call("POST", `/devices/${second.deviceId}/entitlements/issue`, {})).status).toBe(
      201,
    );
  });

  it("refuses to sign with a retired key", async () => {
    const retired = await generateServerSigningKey();
    await createDb(env.DB)
      .insert(signingKeys)
      .values({
        kid: retired.kid,
        alg: "ES256",
        publicJwk: JSON.stringify(retired.publicJwk),
        status: "retired",
      });
    const tenantId = await seedTenant();
    const { deviceId } = await seedDevice(tenantId);
    await createSubscription(tenantId);
    const response = await call(
      "POST",
      `/devices/${deviceId}/entitlements/issue`,
      {},
      { env: { ...env, ENTITLEMENT_SIGNING_JWK: JSON.stringify(retired.privateJwk) } },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "signing_key_retired" });
  });
});

describe("subscription screens", () => {
  it("lists subscriptions with derived expiry and device generations in one round trip", async () => {
    const tenantId = await seedTenant();
    const { deviceId } = await seedDevice(tenantId);
    const subscriptionId = await createSubscription(tenantId, { validUntil: iso(10) });
    await call("POST", `/devices/${deviceId}/entitlements/issue`, {});

    const expiredTenant = await seedTenant();
    const expiredId = await createSubscription(expiredTenant, {
      validFrom: iso(-100),
      validUntil: iso(-3),
    });

    const counted = countingD1(env.DB);
    const response = await call("GET", "/screens/subscriptions", undefined, {
      env: { ...testEnv, DB: counted },
    });
    expect(response.status).toBe(200);
    expect(counted.roundTrips).toBeLessThanOrEqual(1);
    const screen = (await response.json()) as SubscriptionsScreen;
    const item = screen.items.find((i) => i.id === subscriptionId);
    expect(item).toMatchObject({
      tenantId,
      planName: "CloudBox 6",
      expiry: "expiring",
      issuable: true,
      devices: [{ id: deviceId, currentGeneration: 1, currentRevoked: false }],
    });
    expect(item?.daysRemaining).toBeGreaterThanOrEqual(9);
    expect(screen.items.find((i) => i.id === expiredId)).toMatchObject({
      expiry: "expired",
      issuable: false,
    });
    expect(screen.plans.map((p) => p.code)).toContain("cloudbox-6");
    expect(screen.tenants.map((t) => t.id)).toContain(tenantId);
  });

  it("serves the detail with entitlement history and never the token", async () => {
    const tenantId = await seedTenant();
    const { deviceId } = await seedDevice(tenantId);
    const subscriptionId = await createSubscription(tenantId);
    await call("POST", `/devices/${deviceId}/entitlements/issue`, {});
    await call("POST", `/devices/${deviceId}/entitlements/renew`, {});
    await call("POST", `/devices/${deviceId}/entitlements/revoke`, { reason: "test revoke" });

    const counted = countingD1(env.DB);
    const response = await call("GET", `/screens/subscriptions/${subscriptionId}`, undefined, {
      env: { ...testEnv, DB: counted },
    });
    expect(response.status).toBe(200);
    expect(counted.roundTrips).toBeLessThanOrEqual(1);
    const text = await response.text();
    expect(text).not.toMatch(/"token"/);
    const detail = JSON.parse(text) as SubscriptionDetailScreen;
    expect(detail.signingKeyConfigured).toBe(true);
    expect(detail.plan.code).toBe("cloudbox-6");
    expect(detail.subscription.devices).toMatchObject([
      { id: deviceId, currentGeneration: 2, currentRevoked: true },
    ]);
    expect(detail.entitlements.map((e) => [e.generation, e.revokedAt !== null])).toEqual([
      [2, true],
      [1, true],
    ]);
    expect(detail.entitlements[0]?.validFrom).toMatch(/^\d{4}-/);

    expect((await call("GET", "/screens/subscriptions/sub_missing")).status).toBe(404);
  });
});

describe("authorization (stand-in middleware until WT-1)", () => {
  const routes: [string, string, string, unknown?][] = [
    ["subscription.view", "GET", "/plans"],
    ["subscription.view", "GET", "/screens/subscriptions"],
    ["subscription.view", "GET", "/screens/subscriptions/sub_x"],
    ["subscription.view", "GET", "/tenants/ten_x/subscriptions"],
    ["subscription.view", "GET", "/devices/dev_x/entitlements"],
    ["subscription.manage", "POST", "/tenants/ten_x/subscriptions", {}],
    ["subscription.manage", "PATCH", "/subscriptions/sub_x", {}],
    ["license.issue", "POST", "/devices/dev_x/entitlements/issue", {}],
    ["license.renew", "POST", "/devices/dev_x/entitlements/renew", {}],
    ["license.revoke", "POST", "/devices/dev_x/entitlements/revoke", {}],
  ];

  it.each(routes)("%s gates %s %s before validation or D1", async (key, method, path, body) => {
    const others = ALL.split(",")
      .filter((k) => k !== key)
      .join(",");
    const counted = countingD1(env.DB);
    const denied = await call(method, path, body, {
      permissions: others,
      env: { ...testEnv, DB: counted },
    });
    expect(denied.status).toBe(403);
    expect(counted.roundTrips).toBe(0);
    const allowed = await call(method, path, body, { permissions: key });
    expect(allowed.status).not.toBe(403);
  });
});

describe("authorization boundary (real WT-1 middleware)", () => {
  // Un-todo once WT-1's requirePermission and test/auth-fixtures.ts signInAs(env, {email, staffRole})
  // are merged into phase-1/identity. Seed matrix (migration 0003): admin lacks license.revoke;
  // support and read_only have every *.view only.
  it.todo("anonymous → 401 on every WT-5 route");
  it.todo("read_only: GET /plans and screens 200; POST/PATCH subscriptions 403");
  it.todo("support: subscription.view only; license.issue/renew/revoke 403");
  it.todo("admin: subscription.manage, license.issue, license.renew allowed; license.revoke 403");
  it.todo("super_admin: every WT-5 route allowed, including license.revoke");
});
