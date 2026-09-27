// WT-8 Phase 2 verdict pass (docs/reviews/phase-2-onboarding-security.md, "Phase 2 verdict").
// Asserts the SECURE behaviour; a failing test is an open finding.
import { env } from "cloudflare:test";
import { generateServerSigningKey } from "@cloudbox/licensing-contracts";
import { calculateJwkThumbprint, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb } from "../../src/db/client";
import { devices, subscriptions } from "../../src/db/schema";
import type { Bindings } from "../../src/env";
import app from "../../src/index";
import { activateLicense } from "../../src/onboarding/activation";
import { generateLicenseKeys } from "../../src/onboarding/license-keys";
import { seedMembership, seedTenant, signInAs, TEST_ORIGIN } from "../fixtures";

let signingEnv: Bindings;
beforeAll(async () => {
  const server = await generateServerSigningKey();
  signingEnv = { ...env, ENTITLEMENT_SIGNING_JWK: JSON.stringify(server.privateJwk) };
  await env.DB.prepare(
    `INSERT OR IGNORE INTO plans (code, name, max_devices, max_managed_users, features_json,
       offline_grace_days, renewal_warning_days) VALUES ('review-3', 'Review 3', 3, 6, '["fleet"]', 7, 30)`,
  ).run();
});
afterEach(() => vi.restoreAllMocks());

let n = 0;
const nextIp = () => {
  n += 1;
  return `100.130.${Math.floor(n / 250)}.${(n % 250) + 1}`;
};

async function realDevice(tenantId: string) {
  const { publicKey } = await generateKeyPair("RSA-OAEP-256", {
    modulusLength: 2048,
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  const id = `dev_${crypto.randomUUID()}`;
  await createDb(env.DB)
    .insert(devices)
    .values({
      id,
      tenantId,
      name: `V-${id.slice(4, 9)}`,
      status: "enrolled",
      devicePublicKeyJwk: JSON.stringify(jwk),
      deviceKeyThumbprint: await calculateJwkThumbprint(jwk, "sha256"),
      keyProtection: "software",
      hostname: "h",
    });
  return id;
}

async function pendingPlan(tenantId: string, planCode: string, maxManagedUsers = 6) {
  const now = new Date().toISOString();
  await createDb(env.DB)
    .insert(subscriptions)
    .values({
      id: `sub_${crypto.randomUUID()}`,
      tenantId,
      planCode,
      status: "pending",
      validFrom: null,
      validUntil: null,
      maxManagedUsers,
      featuresJson: '["fleet"]',
      offlineGraceDays: 7,
      renewalWarningDays: 30,
      createdAt: now,
      updatedAt: now,
    });
}

describe("V2-1: P2-1 closed at higher concurrency", () => {
  for (const [plan, max] of [
    ["cloudbox-6", 1],
    ["review-3", 3],
  ] as const) {
    it(`8 servers at once on a ${max}-device plan: exactly ${max} licences, every other device_limit_reached`, async () => {
      const t = await seedTenant(env.DB);
      await pendingPlan(t.tenantId, plan);
      const ids = await Promise.all(Array.from({ length: 8 }, () => realDevice(t.tenantId)));
      const db = createDb(env.DB);
      const outcomes = await Promise.all(
        ids.map((id) =>
          activateLicense(signingEnv, db, { id, tenantId: t.tenantId }, { source: "auto" }),
        ),
      );
      const licensed = outcomes.filter((o) => o.licenseState === "licensed");
      const limited = outcomes.filter((o) => o.licenseState === "device_limit_reached");
      expect(licensed).toHaveLength(max);
      expect(limited).toHaveLength(8 - max);
      const row = await env.DB.prepare(
        `SELECT count(DISTINCT e.device_id) AS n FROM entitlements e JOIN devices d ON d.id = e.device_id
         WHERE e.revoked_at IS NULL AND d.tenant_id = ?`,
      )
        .bind(t.tenantId)
        .first<{ n: number }>();
      expect(row?.n).toBe(max);
      const issued = await env.DB.prepare(
        `SELECT count(*) AS n FROM audit_log WHERE event_type = 'LICENSE_ISSUED'
         AND json_extract(after_json, '$.claims.tenant_id') = ?`,
      )
        .bind(t.tenantId)
        .first<{ n: number }>();
      expect(issued?.n).toBe(max);
    });
  }
});

function post(
  path: string,
  body: unknown,
  ip: string,
  e: Bindings = env,
  headers: Record<string, string> = {},
) {
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
    e,
  );
}

describe("V2-2: P2-2 Connect parity, byte-exact, across the 429 boundary", () => {
  const mailEnv = () =>
    ({
      ...env,
      EMAIL: { send: async () => ({ messageId: "m" }) } as unknown as SendEmail,
    }) satisfies Bindings;

  for (const path of ["/api/auth/connect/send-code", "/api/auth/connect/verify"]) {
    it(`${path}: member and stranger get identical status+headers-free bodies for 5 calls, incl. a pre-drained Better Auth bucket`, async () => {
      const t = await seedTenant(env.DB);
      const member = await signInAs(env, { email: `v22-m-${n}@example.test` });
      const memberEmail = `v22-m-${n}@example.test`;
      await seedMembership(env.DB, {
        tenantId: t.tenantId,
        userId: member.userId,
        standing: "user",
      });
      const e = mailEnv();
      const run = async (email: string) => {
        const ip = nextIp();
        // Drain Better Auth's own per-IP buckets for this client first (the old oracle).
        for (let i = 0; i < 3; i += 1) {
          await post(
            "/api/auth/email-otp/send-verification-otp",
            { email: "drain@example.test", type: "sign-in" },
            ip,
            e,
          );
          await post(
            "/api/auth/sign-in/email-otp",
            { email: "drain@example.test", otp: "000000" },
            ip,
            e,
          );
        }
        const out: string[] = [];
        for (let i = 0; i < 5; i += 1) {
          const body = path.endsWith("verify")
            ? { tenantCode: t.publicCode, email, code: "000000" }
            : { tenantCode: t.publicCode, email };
          const r = await post(path, body, ip, e);
          out.push(`${r.status} ${await r.text()}`);
        }
        return out;
      };
      expect(await run(memberEmail)).toEqual(await run(`v22-stranger-${n}@example.test`));
    });
  }
});

describe("V2-3: P2-5 start ceiling for a new address", () => {
  it("11 sends from 11 clients with valid tokens deliver at most 10 mails and audit the ceiling once", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ success: true, hostname: "localhost" }),
    );
    const sent: string[] = [];
    const e = {
      ...env,
      TURNSTILE_SECRET_KEY: "review-secret",
      EMAIL: {
        send: async (m: { to: string }) => {
          sent.push(m.to);
          return { messageId: `m${sent.length}` };
        },
      } as unknown as SendEmail,
    } satisfies Bindings;
    const email = "v23-new@example.test";
    for (let i = 0; i < 12; i += 1) {
      const r = await post("/api/auth/start/send-code", { email }, nextIp(), e, {
        "x-cloudbox-turnstile": `token-${i}`,
      });
      expect(r.status).toBe(200);
    }
    expect(sent.filter((to) => to === email).length).toBeLessThanOrEqual(10);
    const row = await env.DB.prepare(
      "SELECT count(*) AS n FROM audit_log WHERE event_type = 'AUTH_START_CEILING' AND entity_id = ?",
    )
      .bind(email)
      .first<{ n: number }>();
    expect(row?.n).toBe(1);
  });
});

describe("V2-4: P2-6 / P2-8 as claimed", () => {
  const as = async (email: string) => signInAs(env, { email });
  const call = (who: { headers: Record<string, string> }, path: string, body: unknown) =>
    app.request(
      path,
      {
        method: "POST",
        headers: {
          ...who.headers,
          "content-type": "application/json",
          "cf-connecting-ip": nextIp(),
        },
        body: JSON.stringify(body),
      },
      env,
    );

  it("a sixth plan-less self-created tenant is refused", async () => {
    const u = await as("v24-sprawl@example.test");
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push(
        (await call(u, "/api/v1/onboarding/tenants", { displayName: `T${i}`, timezone: "UTC" }))
          .status,
      );
    }
    expect(statuses).toEqual([201, 201, 201, 201, 201, 409]);
  });

  it("a key typed in lower case with spaces redeems", async () => {
    const batch = await generateLicenseKeys(createDb(env.DB), {
      planCode: "cloudbox-6",
      quantity: 1,
      batchLabel: "v24",
      createdBy: "staff",
      correlationId: null,
    } as Parameters<typeof generateLicenseKeys>[1]);
    const typed = ` ${(batch.keys[0]?.code ?? "").toLowerCase().replace(/-/g, " ")} `;
    const u = await as("v24-redeem@example.test");
    const r = await call(u, "/api/v1/onboarding/redeem", {
      code: typed,
      displayName: "Lower",
      timezone: "UTC",
    });
    expect(r.status).toBe(201);
  });

  it("(Low) a self-created tenant with a non-IANA timezone is refused", async () => {
    const u = await as("v24-tz@example.test");
    const r = await call(u, "/api/v1/onboarding/tenants", {
      displayName: "TZ",
      timezone: "Not/AZone",
    });
    expect(r.status).toBe(400);
  });
});

describe("V2-5: WT-13 plan routes", () => {
  const staffCall = (
    who: { headers: Record<string, string> },
    method: string,
    path: string,
    body?: unknown,
  ) =>
    app.request(
      `/api/v1${path}`,
      {
        method,
        headers: { ...who.headers, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      signingEnv,
    );
  const planBody = (code: string, termDays = 365) => ({
    code,
    name: code,
    maxDevices: 2,
    maxManagedUsers: 6,
    features: ["fleet"],
    offlineGraceDays: 7,
    renewalWarningDays: 30,
    termDays,
  });

  it("read_only → 403; term_days bounds; code immutable; retired refused for new, kept for existing", async () => {
    const ro = await signInAs(env, { email: "v25-ro@example.test", staffRole: "read_only" });
    const sa = await signInAs(env, { email: "v25-sa@example.test", staffRole: "super_admin" });
    expect((await staffCall(ro, "POST", "/plans", planBody("v25-ro"))).status).toBe(403);
    expect((await staffCall(sa, "POST", "/plans", planBody("v25-zero", 0))).status).toBe(400);
    expect((await staffCall(sa, "POST", "/plans", planBody("v25-big", 3651))).status).toBe(400);
    expect((await staffCall(sa, "POST", "/plans", planBody("v25-plan"))).status).toBe(201);
    const renamed = await staffCall(sa, "PATCH", "/plans/v25-plan", {
      code: "v25-other",
      name: "Renamed",
    });
    const stillThere = await env.DB.prepare(
      "SELECT count(*) AS n FROM plans WHERE code = 'v25-plan'",
    ).first<{ n: number }>();
    expect(stillThere?.n).toBe(1);
    expect([200, 400]).toContain(renamed.status);

    // An existing tenant on the plan, then retire it.
    const existing = await seedTenant(env.DB);
    await pendingPlan(existing.tenantId, "v25-plan");
    expect(
      (await staffCall(sa, "POST", "/plans/v25-plan/retire", { reasonCode: "discontinued" }))
        .status,
    ).toBe(200);
    const fresh = await seedTenant(env.DB);
    const refused = await staffCall(sa, "POST", `/tenants/${fresh.tenantId}/subscriptions`, {
      planCode: "v25-plan",
    });
    expect(refused.status).toBe(409);
    // The existing tenant's server still activates on the retired plan.
    const dev = await realDevice(existing.tenantId);
    const out = await activateLicense(
      signingEnv,
      createDb(env.DB),
      { id: dev, tenantId: existing.tenantId },
      { source: "auto" },
    );
    expect(out.licenseState).toBe("licensed");
  });
});
