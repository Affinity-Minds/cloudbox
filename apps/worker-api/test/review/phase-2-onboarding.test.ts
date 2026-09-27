// WT-8 review of phase-2 onboarding (docs/reviews/phase-2-onboarding-security.md). Each test asserts
// the SECURE behaviour; a failing test is an open finding.
import { env } from "cloudflare:test";
import { generateServerSigningKey } from "@cloudbox/licensing-contracts";
import { calculateJwkThumbprint, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { verifyTurnstile } from "../../src/auth/challenge";
import { createDb } from "../../src/db/client";
import { devices, subscriptions } from "../../src/db/schema";
import type { Bindings } from "../../src/env";
import app from "../../src/index";
import { activateLicense } from "../../src/onboarding/activation";
import { generateLicenseKeys, redeemLicenseKey } from "../../src/onboarding/license-keys";
import { seedMembership, seedTenant, signInAs, TEST_ORIGIN } from "../fixtures";

let signingEnv: Bindings;
beforeAll(async () => {
  const server = await generateServerSigningKey();
  signingEnv = { ...env, ENTITLEMENT_SIGNING_JWK: JSON.stringify(server.privateJwk) };
});
afterEach(() => vi.restoreAllMocks());

let n = 0;
const nextIp = () => {
  n += 1;
  return `100.120.${Math.floor(n / 250)}.${(n % 250) + 1}`;
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
      name: `R-${id.slice(4, 9)}`,
      status: "enrolled",
      devicePublicKeyJwk: JSON.stringify(jwk),
      deviceKeyThumbprint: await calculateJwkThumbprint(jwk, "sha256"),
      keyProtection: "software",
      hostname: "h",
    });
  return id;
}

describe("P2-1 (High): concurrent activations exceed the plan's max_devices", () => {
  it("three servers activating at once on a 1-device plan get at most one licence", async () => {
    const t = await seedTenant(env.DB);
    const now = new Date().toISOString();
    await createDb(env.DB)
      .insert(subscriptions)
      .values({
        id: `sub_${crypto.randomUUID()}`,
        tenantId: t.tenantId,
        planCode: "cloudbox-6", // max_devices = 1
        status: "pending",
        validFrom: null,
        validUntil: null,
        maxManagedUsers: 6,
        featuresJson: '["remote_access"]',
        offlineGraceDays: 7,
        renewalWarningDays: 30,
        createdAt: now,
        updatedAt: now,
      });
    const ids = await Promise.all([
      realDevice(t.tenantId),
      realDevice(t.tenantId),
      realDevice(t.tenantId),
    ]);
    const db = createDb(env.DB);
    await Promise.all(
      ids.map((id) =>
        activateLicense(signingEnv, db, { id, tenantId: t.tenantId }, { source: "auto" }),
      ),
    );
    const row = await env.DB.prepare(
      `SELECT count(DISTINCT device_id) AS n FROM entitlements WHERE revoked_at IS NULL AND device_id IN (?, ?, ?)`,
    )
      .bind(...ids)
      .first<{ n: number }>();
    expect(row?.n).toBeLessThanOrEqual(1);
  });
});

function post(path: string, body: unknown, ip: string, e: Bindings = env) {
  return app.request(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip, origin: TEST_ORIGIN },
      body: JSON.stringify(body),
    },
    e,
  );
}

describe("P2-2 (Medium): Connect answers differ for a member and a non-member", () => {
  it("send-code: the same four requests from one client look identical", async () => {
    const t = await seedTenant(env.DB);
    const member = await signInAs(env, { email: "p2-member@example.test" });
    await seedMembership(env.DB, { tenantId: t.tenantId, userId: member.userId, standing: "user" });
    const mailEnv = {
      ...env,
      EMAIL: { send: async () => ({ messageId: "m" }) } as unknown as SendEmail,
    } satisfies Bindings;
    const run = async (email: string) => {
      const ip = nextIp();
      const statuses: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        const r = await post(
          "/api/auth/connect/send-code",
          { tenantCode: t.publicCode, email },
          ip,
          mailEnv,
        );
        statuses.push(r.status);
      }
      return statuses;
    };
    expect(await run("p2-member@example.test")).toEqual(await run("p2-stranger@example.test"));
  });

  it("verify: the same four wrong codes from one client look identical", async () => {
    const t = await seedTenant(env.DB);
    const member = await signInAs(env, { email: "p2-member-v@example.test" });
    await seedMembership(env.DB, { tenantId: t.tenantId, userId: member.userId, standing: "user" });
    const run = async (email: string) => {
      const ip = nextIp();
      const out: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const r = await post(
          "/api/auth/connect/verify",
          { tenantCode: t.publicCode, email, code: "000000" },
          ip,
        );
        out.push(`${r.status} ${await r.text()}`);
      }
      return out;
    };
    expect(await run("p2-member-v@example.test")).toEqual(await run("p2-stranger-v@example.test"));
  });
});

describe("P2-3 (Low): Cloudflare testing keys are accepted whenever ENVIRONMENT is not 'production'", () => {
  it("an unset ENVIRONMENT does not accept a testing-key answer", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        success: true,
        hostname: "example.com",
        metadata: { result_with_testing_key: true },
      }),
    );
    const ok = await verifyTurnstile(
      { TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA", ENVIRONMENT: undefined },
      "XXXX.DUMMY.TOKEN.XXXX",
      { host: "box.affinityminds.in", ip: null },
    );
    expect(ok).toBe(false);
  });
});

describe("P2-4 (Low): activation grants for a suspended tenant", () => {
  it("an owner of a suspended tenant cannot mint an enrollment grant", async () => {
    const t = await seedTenant(env.DB, { status: "suspended" });
    const owner = await signInAs(env, { email: "p2-susp@example.test" });
    await seedMembership(env.DB, { tenantId: t.tenantId, userId: owner.userId, standing: "owner" });
    const r = await app.request(
      "/api/v1/onboarding/activation-grants",
      {
        method: "POST",
        headers: { ...owner.headers, "content-type": "application/json" },
        body: JSON.stringify({ tenantId: t.tenantId }),
      },
      env,
    );
    expect(r.status).not.toBe(201);
  });
});

describe("P2 (holds): grants, redemption, audit", () => {
  const grant = (as: { headers: Record<string, string> }, tenantId: string) =>
    app.request(
      "/api/v1/onboarding/activation-grants",
      {
        method: "POST",
        headers: { ...as.headers, "content-type": "application/json" },
        body: JSON.stringify({ tenantId }),
      },
      env,
    );

  it("a 'user' member and a member of another tenant cannot mint grants; staff cannot either", async () => {
    const a = await seedTenant(env.DB);
    const b = await seedTenant(env.DB);
    const user = await signInAs(env, { email: "p2-user@example.test" });
    await seedMembership(env.DB, { tenantId: a.tenantId, userId: user.userId, standing: "user" });
    const ownerA = await signInAs(env, { email: "p2-owner-a@example.test" });
    await seedMembership(env.DB, {
      tenantId: a.tenantId,
      userId: ownerA.userId,
      standing: "owner",
    });
    const staff = await signInAs(env, { email: "p2-staff@example.test", staffRole: "super_admin" });
    expect((await grant(user, a.tenantId)).status).toBe(403);
    expect((await grant(ownerA, b.tenantId)).status).toBe(403);
    expect((await grant(staff, a.tenantId)).status).toBe(401);
    const ok = await grant(ownerA, a.tenantId);
    expect(ok.status).toBe(201);
    const { grant: token } = (await ok.json()) as { grant: string };
    const { results } = await env.DB.prepare(
      "SELECT coalesce(before_json,'') || coalesce(after_json,'') AS j FROM audit_log",
    ).all<{ j: string }>();
    expect(results.map((r) => r.j).join("\n")).not.toContain(token);
  });

  it("the same licence key redeemed twice concurrently creates one tenant; the key never reaches audit", async () => {
    const db = createDb(env.DB);
    const batch = await generateLicenseKeys(db, {
      planCode: "cloudbox-6",
      quantity: 1,
      batchLabel: "review",
      createdBy: "staff-review",
      correlationId: null,
    } as Parameters<typeof generateLicenseKeys>[1]);
    const code = batch.keys[0]?.code ?? "";
    const u1 = await signInAs(env, { email: "p2-redeem1@example.test" });
    const u2 = await signInAs(env, { email: "p2-redeem2@example.test" });
    const attempt = (userId: string, email: string) =>
      redeemLicenseKey(db, {
        code,
        displayName: "X",
        timezone: "UTC",
        userId,
        email,
        correlationId: null,
      }).then(
        () => "ok",
        () => "refused",
      );
    const outcomes = await Promise.all([
      attempt(u1.userId, "p2-redeem1@example.test"),
      attempt(u2.userId, "p2-redeem2@example.test"),
    ]);
    expect(outcomes.filter((o) => o === "ok")).toHaveLength(1);
    const { results } = await env.DB.prepare(
      "SELECT coalesce(before_json,'') || coalesce(after_json,'') AS j FROM audit_log",
    ).all<{ j: string }>();
    expect(results.map((r) => r.j).join("\n")).not.toContain(code.slice(8));
  });
});
