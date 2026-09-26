// WT-14 (ADR 0011): self-service start path, tenant self-creation, device self-activation, plan
// redemption at activation + licence generation, heartbeat auto-issuance, Connect sign-in.
import { env } from "cloudflare:test";
import {
  type ActivationGrantResponse,
  CONNECT_INVALID,
  type ConnectDevicesResponse,
  type CreateOwnTenantResponse,
  type EnrollResponse,
  type HeartbeatResponse,
  NO_ACTIVE_PLAN_MESSAGE,
  type OnboardingOverview,
  type SessionResponse,
} from "@cloudbox/contracts";
import { generateServerSigningKey } from "@cloudbox/licensing-contracts";
import { exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { verifyTurnstile } from "../src/auth/challenge";
import { ensureCustomerByEmail } from "../src/auth/users";
import { createDb } from "../src/db/client";
import type { Bindings } from "../src/env";
import app from "../src/index";
import { DEFAULT_TERM_DAYS, planTermDays } from "../src/onboarding/activation";
import { isOpsDocument } from "../src/ops-shell";
import { seedMembership, seedSubscription, seedTenant, signInAs, TEST_ORIGIN } from "./fixtures";

type Sent = { to: string; text: string };

let testEnv: Bindings;
const sent: Sent[] = [];

beforeAll(async () => {
  const server = await generateServerSigningKey();
  testEnv = {
    ...env,
    ENTITLEMENT_SIGNING_JWK: JSON.stringify(server.privateJwk),
    TURNSTILE_SECRET_KEY: "test-turnstile-secret",
    TURNSTILE_SITE_KEY: "test-site-key",
    EMAIL: {
      send: async (m: Sent) => {
        sent.push(m);
        return { messageId: `m${sent.length}` };
      },
    } as unknown as SendEmail,
  };
  // A two-server plan, so a second activation can be licensed too.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO plans (code, name, max_devices, max_managed_users, features_json, offline_grace_days, renewal_warning_days)
     VALUES ('test-two', 'Test Two', 2, 6, '["remote_access","fleet"]', 7, 30)`,
  ).run();
});

afterEach(() => vi.restoreAllMocks());

let ipSeq = 0;
const nextIp = () => `192.0.2.${++ipSeq}`;

const codeFor = (email: string) => {
  const message = sent.filter((m) => m.to === email).at(-1);
  const code = message?.text.match(/\b(\d{6})\b/)?.[1];
  if (!code) throw new Error(`no code sent to ${email}`);
  return code;
};
const mailsTo = (email: string) => sent.filter((m) => m.to === email).length;

/** Turnstile siteverify stub: every token passes for our hostname (app.request runs on localhost). */
function turnstileOk() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    expect(String(input)).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    return Response.json({ success: true, hostname: "localhost" });
  });
}

function post(path: string, body: unknown, headers: Record<string, string> = {}, ip = nextIp()) {
  return app.request(
    path,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": ip,
        origin: TEST_ORIGIN,
        ...headers,
      },
      body: JSON.stringify(body),
    },
    testEnv,
  );
}
const get = (path: string, headers: Record<string, string> = {}) =>
  app.request(path, { headers }, testEnv);

const cookieFrom = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

const count = async (sql: string, ...binds: unknown[]) =>
  (
    await env.DB.prepare(sql)
      .bind(...binds)
      .first<{ n: number }>()
  )?.n ?? 0;

async function auditRows(eventType: string, entityId?: string) {
  const { results } = await env.DB.prepare(
    `SELECT actor_type, actor_id, source, after_json FROM audit_log WHERE event_type = ?1 ${
      entityId ? "AND entity_id = ?2" : ""
    } ORDER BY rowid`,
  )
    .bind(...(entityId ? [eventType, entityId] : [eventType]))
    .all<{ actor_type: string; actor_id: string; source: string; after_json: string | null }>();
  return results.map((r) => ({ ...r, after: r.after_json ? JSON.parse(r.after_json) : null }));
}

async function freshDeviceJwk() {
  const { publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  return { kty: "RSA" as const, n: jwk.n as string, e: jwk.e as string };
}

async function enroll(token: string) {
  return post("/api/v1/agent/enroll", {
    token,
    device: {
      hostname: `host-${ipSeq}`,
      windowsBuild: "10.0.26100.1",
      agentVersion: "0.1.0",
      keyProtection: "software",
      publicKeyJwk: await freshDeviceJwk(),
    },
  });
}

const heartbeat = (deviceToken: string) =>
  post(
    "/api/v1/agent/heartbeat",
    { health: { device: "x", agent: { version: "0.1.0", healthy: true } } },
    { authorization: `Bearer ${deviceToken}` },
  );

/** A customer who owns a fresh self-created tenant. */
async function ownerWithTenant(email: string) {
  const owner = await signInAs(testEnv, { email });
  const res = await post(
    "/api/v1/onboarding/tenants",
    { displayName: `Org of ${email}`, timezone: "Asia/Kolkata" },
    owner.headers,
  );
  expect(res.status).toBe(201);
  return { owner, ...((await res.json()) as CreateOwnTenantResponse) };
}

async function grant(headers: Record<string, string>, tenantId: string) {
  return post("/api/v1/onboarding/activation-grants", { tenantId }, headers);
}

async function activate(headers: Record<string, string>, tenantId: string) {
  const g = await grant(headers, tenantId);
  expect(g.status).toBe(201);
  const res = await enroll(((await g.json()) as ActivationGrantResponse).grant);
  expect(res.status).toBe(201);
  return (await res.json()) as EnrollResponse;
}

async function assignPlan(tenantId: string, planCode = "cloudbox-6", dates?: object) {
  const staff = await signInAs(testEnv, {
    email: "wt14-plans@example.test",
    staffRole: "super_admin",
  });
  const res = await post(
    `/api/v1/tenants/${tenantId}/subscriptions`,
    { planCode, ...dates },
    staff.headers,
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { subscription: { id: string; status: string } }).subscription;
}

const subscriptionRow = (id: string) =>
  env.DB.prepare("SELECT status, valid_from, valid_until FROM subscriptions WHERE id = ?1")
    .bind(id)
    .first<{ status: string; valid_from: string | null; valid_until: string | null }>();

// ─── A. start path ─────────────────────────────────────────────────────────────────────────────

describe("start path: the only way a customer identity is created without an admin", () => {
  it("requires a Turnstile token on send and on verify", async () => {
    const email = "start-no-token@example.test";
    const noToken = await post("/api/auth/start/send-code", { email });
    expect(noToken.status).toBe(403);
    expect(await noToken.json()).toMatchObject({
      error: "challenge_required",
      detail: { siteKey: "test-site-key" },
    });
    expect(mailsTo(email)).toBe(0);

    // A token siteverify rejects (or one solved on another hostname) is no better.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ success: true, hostname: "evil.example" }),
    );
    const wrongHost = await post(
      "/api/auth/start/send-code",
      { email },
      { "x-cloudbox-turnstile": "tok" },
    );
    expect(wrongHost.status).toBe(403);
    expect(await count("SELECT count(*) AS n FROM customer_users WHERE email = ?1", email)).toBe(0);
  });

  it("without TURNSTILE_SECRET_KEY the start path is closed", async () => {
    const res = await app.request(
      "/api/auth/start/send-code",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: TEST_ORIGIN,
          "x-cloudbox-turnstile": "tok",
        },
        body: JSON.stringify({ email: "start-unconfigured@example.test" }),
      },
      { ...testEnv, TURNSTILE_SECRET_KEY: "" },
    );
    expect(res.status).toBe(403);
  });

  it("send → verify creates exactly one customer row, audited CUSTOMER_SIGNUP, once", async () => {
    turnstileOk();
    const email = "Start.New@Example.test";
    const normal = email.toLowerCase();
    const ip = nextIp();
    const sendRes = await post(
      "/api/auth/start/send-code",
      { email },
      { "x-cloudbox-turnstile": "t1" },
      ip,
    );
    expect(sendRes.status).toBe(200);
    expect(await sendRes.json()).toEqual({ success: true });
    expect(mailsTo(normal)).toBe(1);
    // Sending creates nothing yet.
    expect(await count("SELECT count(*) AS n FROM customer_users WHERE email = ?1", normal)).toBe(
      0,
    );

    const verifyNoToken = await post(
      "/api/auth/start/verify",
      { email, code: codeFor(normal) },
      {},
      ip,
    );
    expect(verifyNoToken.status).toBe(403);
    expect(await count("SELECT count(*) AS n FROM customer_users WHERE email = ?1", normal)).toBe(
      0,
    );

    const verify = await post(
      "/api/auth/start/verify",
      { email, code: codeFor(normal) },
      { "x-cloudbox-turnstile": "t2" },
      ip,
    );
    expect(verify.status).toBe(200);
    expect(cookieFrom(verify)).toContain("cbx_session=");
    expect(await count("SELECT count(*) AS n FROM customer_users WHERE email = ?1", normal)).toBe(
      1,
    );
    const user = await env.DB.prepare("SELECT id FROM customer_users WHERE email = ?1")
      .bind(normal)
      .first<{ id: string }>();
    const signups = await auditRows("CUSTOMER_SIGNUP", user?.id);
    expect(signups).toHaveLength(1);
    expect(signups[0]).toMatchObject({ actor_type: "user", source: "self_onboarding" });
    expect(signups[0]?.after).toMatchObject({ email: normal });

    // Signing in again through /start is a sign-in: no second row, no second CUSTOMER_SIGNUP.
    const ip2 = nextIp();
    await post("/api/auth/start/send-code", { email }, { "x-cloudbox-turnstile": "t3" }, ip2);
    const again = await post(
      "/api/auth/start/verify",
      { email, code: codeFor(normal) },
      { "x-cloudbox-turnstile": "t4" },
      ip2,
    );
    expect(again.status).toBe(200);
    expect(await count("SELECT count(*) AS n FROM customer_users WHERE email = ?1", normal)).toBe(
      1,
    );
    expect(await auditRows("CUSTOMER_SIGNUP", user?.id)).toHaveLength(1);
  });

  it("a wrong code creates nothing", async () => {
    turnstileOk();
    const email = "start-wrong@example.test";
    const ip = nextIp();
    await post("/api/auth/start/send-code", { email }, { "x-cloudbox-turnstile": "a" }, ip);
    const wrong = codeFor(email) === "000000" ? "111111" : "000000";
    const res = await post(
      "/api/auth/start/verify",
      { email, code: wrong },
      { "x-cloudbox-turnstile": "b" },
      ip,
    );
    expect(res.status).toBe(400);
    expect(await count("SELECT count(*) AS n FROM customer_users WHERE email = ?1", email)).toBe(0);
  });

  it("/login stays closed: an unknown address gets no code and no row", async () => {
    const email = "login-still-closed@example.test";
    const send = await post("/api/auth/email-otp/send-verification-otp", {
      email,
      type: "sign-in",
    });
    expect(send.status).toBe(200);
    expect(mailsTo(email)).toBe(0);
    const verify = await post("/api/auth/sign-in/email-otp", { email, otp: "123456" });
    expect(verify.status).toBe(400);
    expect(await count("SELECT count(*) AS n FROM customer_users WHERE email = ?1", email)).toBe(0);
  });

  it("limits sends per (email, client) and per client", async () => {
    turnstileOk();
    const ip = nextIp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await post(
        "/api/auth/start/send-code",
        { email: "start-limit@example.test" },
        { "x-cloudbox-turnstile": `l${i}` },
        ip,
      );
      statuses.push(res.status);
    }
    // Better Auth's own per-IP limit (3 / 60 s) and ours (5 / 15 min per (email, client)).
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses.at(-1)).toBe(429);

    const client = nextIp();
    const perClient: number[] = [];
    for (let i = 0; i < 21; i += 1) {
      const res = await post(
        "/api/auth/start/send-code",
        { email: `spray-${i}@example.test` },
        { "x-cloudbox-turnstile": `s${i}` },
        client,
      );
      perClient.push(res.status);
    }
    expect(perClient.at(-1)).toBe(429);
  });
});

// ─── B. tenant self-creation ──────────────────────────────────────────────────────────────────

describe("tenant self-creation", () => {
  it("creates a provisioning tenant with the caller as owner and no subscription", async () => {
    const { owner, tenantId, tenantCode } = await ownerWithTenant("self-tenant@example.test");
    expect(tenantCode).toMatch(/^CBX-\d{5}$/);
    const tenant = await env.DB.prepare(
      "SELECT status, primary_contact_email, timezone FROM tenants WHERE id = ?1",
    )
      .bind(tenantId)
      .first();
    expect(tenant).toEqual({
      status: "provisioning",
      primary_contact_email: "self-tenant@example.test",
      timezone: "Asia/Kolkata",
    });
    const membership = await env.DB.prepare(
      "SELECT id, user_id, standing, status, invited_by FROM tenant_memberships WHERE tenant_id = ?1",
    )
      .bind(tenantId)
      .all<{ id: string; user_id: string; standing: string; status: string; invited_by: string }>();
    expect(membership.results).toHaveLength(1);
    expect(membership.results[0]).toMatchObject({
      user_id: owner.userId,
      standing: "owner",
      status: "active",
      invited_by: owner.userId,
    });
    expect(
      await count("SELECT count(*) AS n FROM subscriptions WHERE tenant_id = ?1", tenantId),
    ).toBe(0);

    const created = await auditRows("TENANT_CREATED", tenantId);
    expect(created).toEqual([
      expect.objectContaining({
        actor_type: "user",
        actor_id: owner.userId,
        source: "self_onboarding",
      }),
    ]);
    const invited = await auditRows("USER_INVITED", membership.results[0]?.id);
    expect(invited).toEqual([expect.objectContaining({ source: "self_onboarding" })]);

    // A customer may own several; the portal overview shows each with its plan state.
    const second = await post(
      "/api/v1/onboarding/tenants",
      { displayName: "Second org", timezone: "UTC" },
      owner.headers,
    );
    expect(second.status).toBe(201);
    const overview = (await (
      await get("/api/v1/onboarding/overview", owner.headers)
    ).json()) as OnboardingOverview;
    expect(overview.tenants).toHaveLength(2);
    expect(overview.tenants[0]).toMatchObject({
      tenantCode,
      standing: "owner",
      plan: { state: "no_active_plan", message: NO_ACTIVE_PLAN_MESSAGE },
    });
    expect(overview.activeTenantId).toBe(
      ((await second.json()) as CreateOwnTenantResponse).tenantId,
    );
  });

  it("needs a customer session (a staff session is 401) and a valid body", async () => {
    const staff = await signInAs(testEnv, {
      email: "self-tenant-staff@example.test",
      staffRole: "super_admin",
    });
    expect(
      (
        await post(
          "/api/v1/onboarding/tenants",
          { displayName: "x", timezone: "UTC" },
          staff.headers,
        )
      ).status,
    ).toBe(401);
    expect(
      (await post("/api/v1/onboarding/tenants", { displayName: "x", timezone: "UTC" })).status,
    ).toBe(401);
    const customer = await signInAs(testEnv, { email: "self-tenant-bad@example.test" });
    expect(
      (await post("/api/v1/onboarding/tenants", { displayName: "" }, customer.headers)).status,
    ).toBe(400);
  });
});

// ─── C. device self-activation ────────────────────────────────────────────────────────────────

describe("activation grants", () => {
  it("an Owner gets a 15-minute one-time grant that enrolls through /agent/enroll", async () => {
    const { owner, tenantId, tenantCode } = await ownerWithTenant("grant-owner@example.test");
    const res = await grant(owner.headers, tenantId);
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as ActivationGrantResponse;
    expect(body.grant).toMatch(/^CBX-ENROLL-/);
    expect(body.tenantCode).toBe(tenantCode);
    const ttl = Date.parse(body.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(14 * 60_000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000);

    const row = await env.DB.prepare(
      "SELECT label, created_by FROM enrollment_tokens WHERE id = ?1",
    )
      .bind(body.enrollmentTokenId)
      .first();
    expect(row).toEqual({
      label: "self-activation by grant-owner@example.test",
      created_by: owner.userId,
    });
    const created = await auditRows("ENROLLMENT_TOKEN_CREATED", body.enrollmentTokenId);
    expect(created[0]).toMatchObject({ source: "self_activation" });
    expect(created[0]?.after).toMatchObject({ source: "self_activation" });

    const enrolled = await enroll(body.grant);
    expect(enrolled.status).toBe(201);
    const device = (await enrolled.json()) as EnrollResponse;
    expect(device).toMatchObject({ tenantId, tenantCode });
    // One-time: the same grant cannot enroll a second machine.
    expect((await enroll(body.grant)).status).toBe(400);
  });

  it("needs Owner or Admin standing on that tenant", async () => {
    const { owner, tenantId } = await ownerWithTenant("grant-standing@example.test");
    const adminUser = await ensureCustomerByEmail(testEnv, "grant-admin@example.test");
    const plainUser = await ensureCustomerByEmail(testEnv, "grant-user@example.test");
    await seedMembership(env.DB, { tenantId, userId: adminUser, standing: "admin" });
    await seedMembership(env.DB, { tenantId, userId: plainUser, standing: "user" });
    const admin = await signInAs(testEnv, { email: "grant-admin@example.test" });
    const user = await signInAs(testEnv, { email: "grant-user@example.test" });
    expect((await grant(admin.headers, tenantId)).status).toBe(201);
    expect((await grant(user.headers, tenantId)).status).toBe(403);
    expect((await post("/api/v1/onboarding/activation-grants", { tenantId })).status).toBe(401);
    void owner;
  });

  it("a member of tenant A cannot mint a grant for tenant B", async () => {
    const a = await ownerWithTenant("grant-a@example.test");
    const b = await ownerWithTenant("grant-b@example.test");
    expect((await grant(a.owner.headers, b.tenantId)).status).toBe(403);
    expect((await grant(a.owner.headers, "ten_does-not-exist")).status).toBe(403);
    expect((await grant(b.owner.headers, b.tenantId)).status).toBe(201);
  });
});

// ─── D. two events: plan assignment, then redemption + licence at activation ──────────────────

describe("plan redemption and licence generation at activation", () => {
  it("staff assigning a plan without dates makes it pending, with no dates", async () => {
    const { tenantId } = await ownerWithTenant("pending-assign@example.test");
    const subscription = await assignPlan(tenantId);
    expect(subscription.status).toBe("pending");
    expect(await subscriptionRow(subscription.id)).toEqual({
      status: "pending",
      valid_from: null,
      valid_until: null,
    });
  });

  it("the first activation redeems the pending plan with correct dates and issues the licence", async () => {
    const { owner, tenantId } = await ownerWithTenant("redeem-first@example.test");
    const subscription = await assignPlan(tenantId, "test-two");
    const before = Date.now();
    const device = await activate(owner.headers, tenantId);
    expect(device.licenseState).toBe("licensed");
    expect(device.message).toBeUndefined();

    const row = await subscriptionRow(subscription.id);
    expect(row?.status).toBe("active");
    const from = Date.parse(row?.valid_from ?? "");
    expect(from).toBeGreaterThanOrEqual(before - 1000);
    expect(from).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(row?.valid_until ?? "") - from).toBe(
      (await planTermDays(createDb(env.DB), "test-two")) * 86_400_000,
    );

    const redeemed = await auditRows("SUBSCRIPTION_REDEEMED", subscription.id);
    expect(redeemed).toHaveLength(1);
    expect(redeemed[0]).toMatchObject({ actor_type: "system", source: "activation" });
    expect(redeemed[0]?.after).toMatchObject({ status: "active", deviceId: device.deviceId });

    const issued = await env.DB.prepare(
      "SELECT a.actor_type, a.source FROM audit_log a JOIN entitlements e ON e.id = a.entity_id WHERE a.event_type = 'LICENSE_ISSUED' AND e.device_id = ?1",
    )
      .bind(device.deviceId)
      .all();
    expect(issued.results).toEqual([{ actor_type: "system", source: "activation" }]);

    const entitlement = await get("/api/v1/agent/entitlement", {
      authorization: `Bearer ${device.deviceToken}`,
    });
    expect(entitlement.status).toBe(200);

    // A second server does not redeem again; it just gets its own entitlement (max_devices 2).
    const second = await activate(owner.headers, tenantId);
    expect(second.licenseState).toBe("licensed");
    expect(await auditRows("SUBSCRIPTION_REDEEMED", subscription.id)).toHaveLength(1);
    expect((await subscriptionRow(subscription.id))?.valid_from).toBe(row?.valid_from);

    // A third one is over the plan's limit: enrolled, told why, no licence.
    const third = await activate(owner.headers, tenantId);
    expect(third.licenseState).toBe("device_limit_reached");
  });

  it("uses plans.term_days when the column exists (WT-13), else 365 days", async () => {
    const db = createDb(env.DB);
    expect(DEFAULT_TERM_DAYS).toBe(365);
    try {
      await env.DB.prepare("ALTER TABLE plans ADD COLUMN term_days integer").run();
    } catch {
      // Already there (WT-13's migration).
    }
    await env.DB.prepare(
      `INSERT OR IGNORE INTO plans (code, name, max_devices, max_managed_users, features_json, offline_grace_days, renewal_warning_days)
       VALUES ('test-30', 'Thirty days', 1, 6, '["remote_access"]', 7, 30)`,
    ).run();
    await env.DB.prepare("UPDATE plans SET term_days = 30 WHERE code = 'test-30'").run();
    expect(await planTermDays(db, "test-30")).toBe(30);
    await env.DB.prepare("UPDATE plans SET term_days = NULL WHERE code = 'test-30'").run();
    expect(await planTermDays(db, "test-30")).toBe(365);
  });

  it("no plan: the device still enrolls, and enroll + heartbeat say no_active_plan", async () => {
    const { owner, tenantId } = await ownerWithTenant("no-plan@example.test");
    const device = await activate(owner.headers, tenantId);
    expect(device).toMatchObject({
      licenseState: "no_active_plan",
      message: NO_ACTIVE_PLAN_MESSAGE,
    });
    expect(
      await count(
        "SELECT count(*) AS n FROM devices WHERE id = ?1 AND status = 'enrolled'",
        device.deviceId,
      ),
    ).toBe(1);

    const beat = (await (await heartbeat(device.deviceToken)).json()) as HeartbeatResponse;
    expect(beat).toMatchObject({
      entitlementGeneration: null,
      licenseState: "no_active_plan",
      message: NO_ACTIVE_PLAN_MESSAGE,
      commands: [],
    });
    expect(
      (await get("/api/v1/agent/entitlement", { authorization: `Bearer ${device.deviceToken}` }))
        .status,
    ).toBe(404);

    // Plan attached AFTER activation: the next heartbeat redeems it and issues (source auto).
    const subscription = await assignPlan(tenantId);
    const after = (await (await heartbeat(device.deviceToken)).json()) as HeartbeatResponse;
    expect(after).toMatchObject({ entitlementGeneration: 1, licenseState: "licensed" });
    expect(after.message).toBeUndefined();
    const redeemed = await auditRows("SUBSCRIPTION_REDEEMED", subscription.id);
    expect(redeemed).toEqual([expect.objectContaining({ source: "auto" })]);
    expect((await subscriptionRow(subscription.id))?.status).toBe("active");
    // Later heartbeats do not issue again.
    const steady = (await (await heartbeat(device.deviceToken)).json()) as HeartbeatResponse;
    expect(steady).toMatchObject({ entitlementGeneration: 1, licenseState: "licensed" });
    expect(
      await count("SELECT count(*) AS n FROM entitlements WHERE device_id = ?1", device.deviceId),
    ).toBe(1);
  });

  it("heartbeat auto-issues against an already-active subscription", async () => {
    const tenant = await seedTenant(env.DB);
    const staff = await signInAs(testEnv, {
      email: "auto-issue-staff@example.test",
      staffRole: "super_admin",
    });
    const token = await post(
      `/api/v1/tenants/${tenant.tenantId}/enrollment-tokens`,
      { label: "staff code", expiresInHours: 1 },
      staff.headers,
    );
    expect(token.status).toBe(201);
    // Enrolled before any plan: nothing to issue yet.
    const device = (await (
      await enroll(((await token.json()) as { token: string }).token)
    ).json()) as EnrollResponse;
    expect(device.licenseState).toBe("no_active_plan");
    await seedSubscription(env.DB, { tenantId: tenant.tenantId, status: "active" });
    const beat = (await (await heartbeat(device.deviceToken)).json()) as HeartbeatResponse;
    expect(beat).toMatchObject({ entitlementGeneration: 1, licenseState: "licensed" });
    const issued = await env.DB.prepare(
      "SELECT a.actor_type, a.source FROM audit_log a JOIN entitlements e ON e.id = a.entity_id WHERE a.event_type = 'LICENSE_ISSUED' AND e.device_id = ?1",
    )
      .bind(device.deviceId)
      .all();
    expect(issued.results).toEqual([{ actor_type: "system", source: "auto" }]);
  });

  for (const [label, sub] of [
    [
      "expired",
      {
        status: "active" as const,
        validFrom: new Date(Date.now() - 400 * 86_400_000).toISOString(),
        validUntil: new Date(Date.now() - 86_400_000).toISOString(),
      },
    ],
    ["suspended", { status: "suspended" as const }],
    ["cancelled", { status: "cancelled" as const }],
    ["trial (no trial on this path)", { status: "trial" as const }],
  ] as const) {
    it(`${label} subscription: no auto-issue, no_active_plan`, async () => {
      const { owner, tenantId } = await ownerWithTenant(
        `inactive-${label.split(" ")[0]}@example.test`,
      );
      const seeded = await seedSubscription(env.DB, { tenantId, ...sub });
      const device = await activate(owner.headers, tenantId);
      expect(device.licenseState).toBe("no_active_plan");
      const beat = (await (await heartbeat(device.deviceToken)).json()) as HeartbeatResponse;
      expect(beat).toMatchObject({ entitlementGeneration: null, licenseState: "no_active_plan" });
      expect(
        await count("SELECT count(*) AS n FROM entitlements WHERE device_id = ?1", device.deviceId),
      ).toBe(0);
      expect(await auditRows("SUBSCRIPTION_REDEEMED", seeded.subscriptionId)).toHaveLength(0);
    });
  }

  it("the Fleet detail and the portal show the plan state", async () => {
    const { owner, tenantId } = await ownerWithTenant("fleet-plan@example.test");
    const device = await activate(owner.headers, tenantId);
    const staff = await signInAs(testEnv, {
      email: "fleet-plan-staff@example.test",
      staffRole: "read_only",
    });
    const detail = (await (
      await get(`/api/v1/screens/fleet/${device.deviceId}`, staff.headers)
    ).json()) as { plan: { state: string; message: string | null } };
    expect(detail.plan).toMatchObject({ state: "no_active_plan", message: NO_ACTIVE_PLAN_MESSAGE });
    await assignPlan(tenantId);
    const overview = (await (
      await get("/api/v1/onboarding/overview", owner.headers)
    ).json()) as OnboardingOverview;
    expect(overview.tenants.find((t) => t.tenantId === tenantId)?.plan.state).toBe(
      "pending_activation",
    );
  });
});

// ─── E. Connect sign-in ───────────────────────────────────────────────────────────────────────

describe("Connect sign-in contract", () => {
  it("send-code answers identically for unknown tenant, unknown email, non-member and member", async () => {
    const { tenantCode } = await ownerWithTenant("connect-member@example.test");
    await ownerWithTenant("connect-outsider@example.test");
    const cases = [
      { tenantCode: "CBX-99999", email: "connect-member@example.test" },
      { tenantCode, email: "connect-nobody@example.test" },
      { tenantCode, email: "connect-outsider@example.test" },
      { tenantCode: "not a code", email: "connect-member@example.test" },
      { tenantCode, email: "connect-member@example.test" },
    ];
    const answers = [];
    for (const body of cases) {
      const res = await post("/api/auth/connect/send-code", body);
      answers.push({ status: res.status, body: await res.text() });
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(answers[0]).toEqual({ status: 200, body: JSON.stringify({ success: true }) });
    // Only the member was sent a code.
    expect(mailsTo("connect-member@example.test")).toBe(1);
    expect(mailsTo("connect-outsider@example.test")).toBe(0);
    expect(mailsTo("connect-nobody@example.test")).toBe(0);
  });

  it("verify: non-member fails exactly like a wrong code; a member signs in to that tenant", async () => {
    const { owner, tenantId, tenantCode } = await ownerWithTenant("connect-verify@example.test");
    const other = await ownerWithTenant("connect-verify-other@example.test");
    const device = await activate(owner.headers, tenantId);
    await activate(other.owner.headers, other.tenantId);

    const ip = nextIp();
    await post(
      "/api/auth/connect/send-code",
      { tenantCode, email: "connect-verify@example.test" },
      {},
      ip,
    );
    const code = codeFor("connect-verify@example.test");
    const wrong = code === "000000" ? "111111" : "000000";
    const wrongCode = await post(
      "/api/auth/connect/verify",
      { tenantCode, email: "connect-verify@example.test", code: wrong },
      {},
      ip,
    );
    const nonMember = await post(
      "/api/auth/connect/verify",
      { tenantCode: other.tenantCode, email: "connect-verify@example.test", code },
      {},
      ip,
    );
    const unknownTenant = await post(
      "/api/auth/connect/verify",
      { tenantCode: "CBX-99998", email: "connect-verify@example.test", code },
      {},
      ip,
    );
    expect(wrongCode.status).toBe(400);
    const wrongBody = await wrongCode.json();
    expect(wrongBody).toEqual(CONNECT_INVALID);
    for (const res of [nonMember, unknownTenant]) {
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(wrongBody);
    }

    const ok = await post(
      "/api/auth/connect/verify",
      { tenantCode, email: "connect-verify@example.test", code },
      {},
      nextIp(), // our per-client Connect limit (3 / 60 s) is spent by the three refusals above
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ tenantId, tenantCode, user: { id: owner.userId } });
    const cookie = cookieFrom(ok);
    const success = await auditRows("AUTH_LOGIN_SUCCEEDED", owner.userId);
    expect(success.at(-1)?.after).toMatchObject({ surface: "connect", tenantId });

    const session = (await (
      await get("/api/v1/auth/session?as=customer", { cookie })
    ).json()) as SessionResponse;
    expect(session.activeTenantId).toBe(tenantId);

    const devices = (await (
      await get("/api/v1/connect/devices", { cookie })
    ).json()) as ConnectDevicesResponse;
    expect(devices).toMatchObject({ tenantId, tenantCode, plan: { state: "no_active_plan" } });
    expect(devices.devices.map((d) => d.deviceId)).toEqual([device.deviceId]);
    expect(devices.devices[0]).toMatchObject({ online: false, licenseState: "none" });

    // Tenant boundary: the other tenant's list is forbidden to this session.
    expect(
      (await get(`/api/v1/connect/devices?tenantId=${other.tenantId}`, { cookie })).status,
    ).toBe(403);
    expect((await get("/api/v1/connect/devices")).status).toBe(401);
  });
});

// ─── plumbing ─────────────────────────────────────────────────────────────────────────────────

describe("Turnstile testing keys and the staff route for licence keys", () => {
  it("testing-key answers (hostname example.com) pass only outside production", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        success: true,
        hostname: "example.com",
        metadata: { result_with_testing_key: true },
      }),
    );
    const request = { host: "box.affinityminds.in", ip: null };
    expect(
      await verifyTurnstile(
        { TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA", ENVIRONMENT: "development" },
        "XXXX.DUMMY.TOKEN.XXXX",
        request,
      ),
    ).toBe(true);
    expect(
      await verifyTurnstile(
        { TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA", ENVIRONMENT: "production" },
        "XXXX.DUMMY.TOKEN.XXXX",
        request,
      ),
    ).toBe(false);
  });

  it("/ops/licences is a console route (ops shell), the customer /start is not", () => {
    expect(isOpsDocument("/ops/licences", "/ops")).toBe(true);
    expect(isOpsDocument("/start", "/ops")).toBe(false);
  });
});

// ─── WT-8 phase-2 review follow-ups (docs/reviews/phase-2-onboarding-security.md) ────────────

describe("review follow-ups", () => {
  it("P2-5: an address with no account gets at most 10 start codes a day, then the same 200", async () => {
    turnstileOk();
    const email = "p2-5-flood@example.test";
    const answers: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const res = await post(
        "/api/auth/start/send-code",
        { email },
        { "x-cloudbox-turnstile": `f${i}` },
      );
      answers.push(`${res.status} ${await res.text()}`);
    }
    expect(new Set(answers)).toEqual(new Set([`200 ${JSON.stringify({ success: true })}`]));
    expect(mailsTo(email)).toBe(10);
    expect(await auditRows("AUTH_START_CEILING", email)).toHaveLength(1);
  });

  it("P2-2: Connect verify answers the member path's refusals with our exact body", async () => {
    const { tenantCode } = await ownerWithTenant("p2-2-member@example.test");
    const ip = nextIp();
    const member = await post(
      "/api/auth/connect/verify",
      { tenantCode, email: "p2-2-member@example.test", code: "000000" },
      {},
      ip,
    );
    expect(member.status).toBe(400);
    expect(await member.text()).toBe(JSON.stringify(CONNECT_INVALID));
  });

  it("P2-4: owners of suspended, past_due, cancelled or archived tenants get 403 tenant_not_active", async () => {
    for (const status of ["suspended", "past_due", "cancelled", "archived"] as const) {
      const tenant = await seedTenant(env.DB, { status });
      const owner = await signInAs(testEnv, { email: `p2-4-${status}@example.test` });
      await seedMembership(env.DB, {
        tenantId: tenant.tenantId,
        userId: owner.userId,
        standing: "owner",
      });
      const res = await grant(owner.headers, tenant.tenantId);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "tenant_not_active" });
    }
  });

  it("P2-6: at most 5 self-created tenants without a plan per customer; a plan frees a slot", async () => {
    const owner = await signInAs(testEnv, { email: "p2-6-cap@example.test" });
    const create = (i: number) =>
      post(
        "/api/v1/onboarding/tenants",
        { displayName: `Cap ${i}`, timezone: "UTC" },
        owner.headers,
      );
    const created: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await create(i);
      expect(res.status).toBe(201);
      created.push(((await res.json()) as CreateOwnTenantResponse).tenantId);
    }
    const sixth = await create(5);
    expect(sixth.status).toBe(409);
    expect(await sixth.json()).toEqual({ error: "tenant_limit_reached" });
    await assignPlan(created[0] as string);
    expect((await create(6)).status).toBe(201);
  });
});
