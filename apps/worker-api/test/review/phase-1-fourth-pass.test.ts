// WT-8 fourth pass (docs/reviews/phase-1-security.md, "Fourth pass / merge verdict"). Asserts the
// SECURE behaviour; a failing test is an open finding.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { accountBudgetKey, OTP_ACCOUNT_BUDGET } from "../../src/auth/challenge";
import { bumpCounter } from "../../src/auth/counters";
import { ensureUserByEmail } from "../../src/auth/users";
import { createDb } from "../../src/db/client";
import type { Bindings } from "../../src/env";
import app from "../../src/index";
import { seedMembership, seedTenant, signInAs, TEST_ORIGIN } from "../fixtures";

let n = 0;
const nextIp = () => {
  n += 1;
  return `100.110.${Math.floor(n / 250)}.${(n % 250) + 1}`;
};
const KELVIN = "K"; // "K".toLowerCase() === "k"

function post(path: string, body: unknown, e: Bindings, ip = nextIp()) {
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

function mailbox() {
  const sent: { to: string; text: string }[] = [];
  const e = {
    ...env,
    EMAIL: {
      send: async (m: { to: string; text: string }) => {
        sent.push(m);
        return { messageId: `m-${sent.length}` };
      },
    } as unknown as SendEmail,
  } satisfies Bindings;
  const code = () => sent.at(-1)?.text.match(/\b(\d{6})\b/)?.[1] ?? "";
  return { e, code };
}

describe("U-1 (High): a Unicode case variant of the email skips every CloudBox code limit", () => {
  it("wrong guesses for 'Kate' (Kelvin sign) do not consume the owner's attempts", async () => {
    const email = "kate-u1@example.test";
    await ensureUserByEmail(env, email);
    const box = mailbox();
    const ownerIp = nextIp();
    await post(
      "/api/auth/email-otp/send-verification-otp",
      { email, type: "sign-in" },
      box.e,
      ownerIp,
    );
    const code = box.code();
    const wrong = code === "000000" ? "111111" : "000000";
    const variant = `${KELVIN}ate-u1@example.test`;
    for (let i = 0; i < 5; i += 1) {
      await post("/api/auth/sign-in/email-otp", { email: variant, otp: wrong }, box.e);
    }
    const owner = await post("/api/auth/sign-in/email-otp", { email, otp: code }, box.e, ownerIp);
    expect(owner.status).toBe(200);
  });

  it("the variant does not sign in past the account cooldown / step-up", async () => {
    const email = "kate-u1b@example.test";
    await ensureUserByEmail(env, email);
    const box = mailbox();
    await post("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" }, box.e);
    const code = box.code();
    const db = createDb(env.DB);
    const key = await accountBudgetKey(email);
    for (let i = 0; i < OTP_ACCOUNT_BUDGET.max; i += 1) {
      await bumpCounter(db, key, OTP_ACCOUNT_BUDGET.windowSeconds);
    }
    // The real address is now refused (cooldown without Turnstile)...
    const direct = await post("/api/auth/sign-in/email-otp", { email, otp: code }, box.e);
    expect(direct.status).toBe(429);
    // ...and so must the variant be, from a client that never requested the code.
    const variant = await post(
      "/api/auth/sign-in/email-otp",
      { email: `${KELVIN}ate-u1b@example.test`, otp: code },
      box.e,
    );
    expect(variant.status).not.toBe(200);
  });
});

describe("U-2 (Medium): tenant standing is not ranked", () => {
  it("a tenant admin cannot make itself owner", async () => {
    const t = await seedTenant(env.DB);
    const admin = await signInAs(env, { email: "u2-admin@example.test" });
    const m = await seedMembership(env.DB, {
      tenantId: t.tenantId,
      userId: admin.userId,
      standing: "admin",
    });
    const res = await app.request(
      `/api/v1/tenants/${t.tenantId}/memberships/${m.membershipId}`,
      {
        method: "PATCH",
        headers: { ...admin.headers, "content-type": "application/json" },
        body: JSON.stringify({ standing: "owner" }),
      },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("a tenant admin cannot revoke the tenant's only owner", async () => {
    const t = await seedTenant(env.DB);
    const owner = await signInAs(env, { email: "u2-owner@example.test" });
    const admin = await signInAs(env, { email: "u2-admin2@example.test" });
    const om = await seedMembership(env.DB, {
      tenantId: t.tenantId,
      userId: owner.userId,
      standing: "owner",
    });
    await seedMembership(env.DB, { tenantId: t.tenantId, userId: admin.userId, standing: "admin" });
    const res = await app.request(
      `/api/v1/tenants/${t.tenantId}/memberships/${om.membershipId}`,
      {
        method: "DELETE",
        headers: { ...admin.headers, "content-type": "application/json" },
        body: JSON.stringify({ reasonCode: "role_change" }),
      },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("(holds) a tenant user cannot change its own standing", async () => {
    const t = await seedTenant(env.DB);
    const u = await signInAs(env, { email: "u2-user@example.test" });
    const m = await seedMembership(env.DB, {
      tenantId: t.tenantId,
      userId: u.userId,
      standing: "user",
    });
    const res = await app.request(
      `/api/v1/tenants/${t.tenantId}/memberships/${m.membershipId}`,
      {
        method: "PATCH",
        headers: { ...u.headers, "content-type": "application/json" },
        body: JSON.stringify({ standing: "owner" }),
      },
      env,
    );
    expect(res.status).toBe(403);
  });
});

describe("U-3 (holds): tenant boundary for members", () => {
  it("a member of A cannot read B's tenant screen or make B active", async () => {
    const a = await seedTenant(env.DB);
    const b = await seedTenant(env.DB);
    const u = await signInAs(env, { email: "u3-member@example.test" });
    await seedMembership(env.DB, { tenantId: a.tenantId, userId: u.userId, standing: "owner" });
    const screen = await app.request(
      `/api/v1/screens/tenants/${b.tenantId}`,
      { headers: u.headers },
      env,
    );
    // WT-1: a customer session is not read on this staff screen at all (two identity systems): 401.
    expect([401, 403, 404]).toContain(screen.status);
    const active = await app.request(
      "/api/v1/me/active-tenant",
      {
        method: "POST",
        headers: { ...u.headers, "content-type": "application/json" },
        body: JSON.stringify({ tenantId: b.tenantId }),
      },
      env,
    );
    expect(active.status).toBe(403);
    const invite = await app.request(
      `/api/v1/tenants/${b.tenantId}/memberships`,
      {
        method: "POST",
        headers: { ...u.headers, "content-type": "application/json" },
        body: JSON.stringify({ email: "u3-x@example.test", standing: "owner" }),
      },
      env,
    );
    expect(invite.status).toBe(403);
  });
});
