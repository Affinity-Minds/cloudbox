// Review T-1: a client is an IPv4 address or an IPv6 /48, and every address has a failure budget
// for customer codes above which a Turnstile token is required (or, without Turnstile configured,
// a 15-minute per-account cooldown).
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_COOLDOWN_SECONDS,
  accountBudgetKey,
  OTP_ACCOUNT_BUDGET,
  TURNSTILE_HEADER,
} from "../src/auth/challenge";
import { bumpCounter } from "../src/auth/counters";
import { ensureUserByEmail } from "../src/auth/users";
import { createDb } from "../src/db/client";
import type { Bindings } from "../src/env";
import app from "../src/index";
import { TEST_ORIGIN } from "./auth-fixtures";

let n = 0;
const nextIp = () => `203.0.113.${++n}`;

function mailbox(overrides: Partial<Bindings> = {}) {
  const sent: { to: string; text: string }[] = [];
  const e: Bindings = {
    ...env,
    EMAIL: {
      send: async (m: { to: string; text: string }) => {
        sent.push(m);
        return { messageId: `m${sent.length}` };
      },
    } as unknown as SendEmail,
    ...overrides,
  };
  return { env: e, sent };
}

const post = (
  path: string,
  body: unknown,
  e: Bindings,
  ip = nextIp(),
  headers: Record<string, string> = {},
) =>
  app.request(
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

const send = (email: string, e: Bindings, ip?: string, headers?: Record<string, string>) =>
  post("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" }, e, ip, headers);

async function exhaustBudget(email: string) {
  const db = createDb(env.DB);
  const key = await accountBudgetKey(email);
  for (let i = 0; i < OTP_ACCOUNT_BUDGET.max; i += 1) {
    await bumpCounter(db, key, OTP_ACCOUNT_BUDGET.windowSeconds);
  }
}

afterEach(() => vi.restoreAllMocks());

describe("clients are IPv6 /48s (T-1)", () => {
  it("four /64s of one /48 share Better Auth's per-IP limit and our per-client counters", async () => {
    await ensureUserByEmail(env, "v6@example.test");
    const box = mailbox();
    const statuses: number[] = [];
    for (let i = 1; i <= 4; i += 1) {
      statuses.push((await send("v6@example.test", box.env, `2001:db8:77:${i}::1`)).status);
    }
    // Better Auth's send limit is 3 / 60 s per client: the fourth /64 is the same client.
    expect(statuses).toEqual([200, 200, 200, 429]);
    const { results } = await env.DB.prepare(
      "SELECT DISTINCT json_extract(after_json, '$.client') AS client FROM audit_log WHERE event_type = 'AUTH_OTP_SENT' AND entity_id = ?",
    )
      .bind("v6@example.test")
      .all<{ client: string }>();
    expect(results).toHaveLength(1);
    // A different /48 is a different client.
    expect((await send("v6@example.test", box.env, "2001:db8:78:1::1")).status).toBe(200);
  });

  it("every failed code check counts toward the account budget, from any client", async () => {
    await ensureUserByEmail(env, "budget-count@example.test");
    const box = mailbox();
    for (let i = 0; i < 3; i += 1) {
      await post(
        "/api/auth/sign-in/email-otp",
        { email: "budget-count@example.test", otp: "000000" },
        box.env,
      );
    }
    const row = await env.DB.prepare("SELECT count FROM customer_rate_limit WHERE key = ?")
      .bind(await accountBudgetKey("budget-count@example.test"))
      .first<{ count: number }>();
    expect(row?.count).toBe(3);
  });
});

describe("above the account budget: Turnstile step-up, never a lockout (T-1)", () => {
  const withTurnstile = {
    TURNSTILE_SECRET_KEY: "test-secret",
    TURNSTILE_SITE_KEY: "test-site-key",
  };

  function siteverify(outcome: { success: boolean; hostname?: string }) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      expect(String(input)).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
      return new Response(JSON.stringify(outcome), {
        headers: { "content-type": "application/json" },
      });
    });
  }

  it("asks for a challenge (same answer for known and unknown addresses) and accepts a valid token", async () => {
    await ensureUserByEmail(env, "stepup@example.test");
    await exhaustBudget("stepup@example.test");
    await exhaustBudget("stepup-unknown@example.test");
    const box = mailbox(withTurnstile);

    const known = await send("stepup@example.test", box.env);
    const unknown = await send("stepup-unknown@example.test", box.env);
    expect(known.status).toBe(403);
    await expect(known.json()).resolves.toEqual({
      error: "challenge_required",
      detail: { siteKey: "test-site-key" },
    });
    expect(await unknown.text()).toBe(
      JSON.stringify({ error: "challenge_required", detail: { siteKey: "test-site-key" } }),
    );
    expect(box.sent).toHaveLength(0);

    const verified = siteverify({ success: true, hostname: "localhost" });
    const ownerIp = nextIp();
    const withToken = await send("stepup@example.test", box.env, ownerIp, {
      [TURNSTILE_HEADER]: "tok-1",
    });
    expect(withToken.status).toBe(200);
    expect(box.sent).toHaveLength(1);
    const code = box.sent[0]?.text.match(/\b(\d{6})\b/)?.[1] ?? "";

    // The code step needs a token too while over budget.
    const noToken = await post(
      "/api/auth/sign-in/email-otp",
      { email: "stepup@example.test", otp: code },
      box.env,
      ownerIp,
    );
    expect(noToken.status).toBe(403);
    const signedIn = await post(
      "/api/auth/sign-in/email-otp",
      { email: "stepup@example.test", otp: code },
      box.env,
      ownerIp,
      { [TURNSTILE_HEADER]: "tok-2" },
    );
    expect(signedIn.status).toBe(200);
    expect(verified).toHaveBeenCalledTimes(2);
  });

  it("refuses a token solved on another hostname or rejected by siteverify", async () => {
    await ensureUserByEmail(env, "stepup-host@example.test");
    await exhaustBudget("stepup-host@example.test");
    const box = mailbox(withTurnstile);
    siteverify({ success: true, hostname: "other.example" });
    expect(
      (await send("stepup-host@example.test", box.env, undefined, { [TURNSTILE_HEADER]: "t" }))
        .status,
    ).toBe(403);
    vi.restoreAllMocks();
    siteverify({ success: false });
    expect(
      (await send("stepup-host@example.test", box.env, undefined, { [TURNSTILE_HEADER]: "t" }))
        .status,
    ).toBe(403);
    expect(box.sent).toHaveLength(0);
  });
});

describe("without Turnstile configured: a 15-minute per-account cooldown (the only per-account denial)", () => {
  it("cools the account down once, audits it, and starts a fresh budget afterwards", async () => {
    await ensureUserByEmail(env, "cooldown@example.test");
    await exhaustBudget("cooldown@example.test");
    const box = mailbox({ TURNSTILE_SECRET_KEY: undefined });
    const first = await send("cooldown@example.test", box.env);
    expect(first.status).toBe(429);
    await expect(first.json()).resolves.toEqual({
      error: "account_cooldown",
      detail: { retryAfterSeconds: ACCOUNT_COOLDOWN_SECONDS },
    });
    expect(
      (
        await post(
          "/api/auth/sign-in/email-otp",
          { email: "cooldown@example.test", otp: "123456" },
          box.env,
        )
      ).status,
    ).toBe(429);
    expect(box.sent).toHaveLength(0);
    const audited = await env.DB.prepare(
      "SELECT count(*) AS n FROM audit_log WHERE event_type = 'AUTH_ACCOUNT_COOLDOWN' AND entity_id = ?",
    )
      .bind("cooldown@example.test")
      .first<{ n: number }>();
    expect(audited?.n).toBe(1);

    // After the cooldown the budget starts from zero.
    await env.DB.prepare(
      "UPDATE customer_rate_limit SET last_request = ? WHERE key LIKE 'cb:otp-cooldown:%'",
    )
      .bind(Date.now() - (ACCOUNT_COOLDOWN_SECONDS + 1) * 1000)
      .run();
    expect((await send("cooldown@example.test", box.env)).status).toBe(200);
    expect(box.sent).toHaveLength(1);
  });
});
