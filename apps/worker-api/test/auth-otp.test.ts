import { env } from "cloudflare:test";
import type { SessionResponse } from "@cloudbox/contracts";
import { describe, expect, it, vi } from "vitest";
import { audit } from "../src/audit";
import { assertAuthConfig, createAuth, HONEYPOT_HEADER, OTP_FAILURE_CAP } from "../src/auth";
import { bumpCounter, counterKey } from "../src/auth/counters";
import { ensureUserByEmail } from "../src/auth/users";
import { createDb } from "../src/db/client";
import { sendOtpEmail } from "../src/email";
import type { Bindings } from "../src/env";
import app from "../src/index";

type Sent = { to: string; from: string; subject: string; text: string; html: string };

/** An env whose `EMAIL` binding records messages instead of sending them. */
function withMailbox(overrides: Partial<Bindings> = {}) {
  const sent: Sent[] = [];
  const mailEnv = {
    ...env,
    EMAIL: {
      send: async (message: Sent) => {
        sent.push(message);
        return { messageId: `msg-${sent.length}` };
      },
    } as unknown as SendEmail,
    ...overrides,
  } satisfies Bindings;
  const codeFor = (email: string) => {
    const message = sent.filter((m) => m.to === email.toLowerCase()).at(-1);
    const code = message?.text.match(/\b(\d{6})\b/)?.[1];
    if (!code) throw new Error(`no code sent to ${email}`);
    return code;
  };
  return { env: mailEnv, sent, codeFor };
}

let ipCounter = 0;
/** Each test gets its own client IP so Better Auth's per-IP buckets do not leak between tests. */
const nextIp = () => `198.51.100.${++ipCounter}`;

function post(
  path: string,
  body: unknown,
  e: Bindings,
  { ip, headers = {} }: { ip: string; headers?: Record<string, string> },
) {
  return app.request(
    path,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": ip,
        origin: "http://localhost",
        ...headers,
      },
      body: JSON.stringify(body),
    },
    e,
  );
}

const sendCode = (email: string, e: Bindings, ip: string, headers?: Record<string, string>) =>
  post("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" }, e, { ip, headers });
const verifyCode = (email: string, otp: string, e: Bindings, ip: string) =>
  post("/api/auth/sign-in/email-otp", { email, otp }, e, { ip });

const cookieFrom = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

async function auditRows(eventType: string, entityId: string) {
  const { results } = await env.DB.prepare(
    "SELECT after_json FROM audit_log WHERE event_type = ? AND entity_id = ? ORDER BY rowid",
  )
    .bind(eventType, entityId)
    .all<{ after_json: string }>();
  return results.map((r) => JSON.parse(r.after_json) as Record<string, unknown>);
}

/** Sign-in is closed: an address can sign in only once an admin action created its user row. */
const known = (email: string) => ensureUserByEmail(env, email);

async function countRows(table: "user" | "verification", where: string, value: string) {
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM "${table}" WHERE ${where} = ?`)
    .bind(value)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** An earlier send for `email` from `client`, as the audit log records it. */
const seedSend = (email: string, client: string) =>
  audit(createDb(env.DB), {
    eventType: "AUTH_OTP_SENT",
    entityType: "auth_email",
    entityId: email,
    actor: { type: "system", id: "email-otp" },
    before: null,
    after: { outcome: "sent", messageId: "seed", client },
  });

describe("email OTP sign-in", () => {
  it("send → verify → session → logout, with a stubbed mailer and audit rows", async () => {
    await known("flow@example.test");
    const box = withMailbox();
    const ip = nextIp();
    const sent = await sendCode("Flow@Example.test", box.env, ip);
    expect(sent.status).toBe(200);
    await expect(sent.json()).resolves.toEqual({ success: true });
    expect(box.sent).toHaveLength(1);
    expect(box.sent[0]).toMatchObject({
      to: "flow@example.test",
      from: env.EMAIL_FROM,
      subject: "Your CloudBox sign-in code",
    });
    expect(box.sent[0]?.text).toMatch(/expires in 5 minutes/);
    expect(box.sent[0]?.text).toMatch(/did not request/);
    expect(await auditRows("AUTH_OTP_SENT", "flow@example.test")).toEqual([
      { outcome: "sent", messageId: "msg-1", client: expect.any(String) },
    ]);

    const verified = await verifyCode(
      "flow@example.test",
      box.codeFor("flow@example.test"),
      box.env,
      ip,
    );
    expect(verified.status).toBe(200);
    const cookie = cookieFrom(verified);
    expect(cookie).toMatch(/session_token=/);
    // Host-only: no Domain attribute on the session cookie.
    expect(verified.headers.get("set-cookie")).not.toMatch(/domain=/i);

    const session = await app.request("/api/v1/auth/session", { headers: { cookie } }, env);
    expect(session.status).toBe(200);
    const body = (await session.json()) as SessionResponse;
    expect(body.user.email).toBe("flow@example.test");
    expect(await auditRows("AUTH_LOGIN_SUCCEEDED", body.user.id)).toHaveLength(1);

    const out = await app.request(
      "/api/v1/auth/logout",
      { method: "POST", headers: { cookie, origin: "http://localhost" } },
      env,
    );
    expect(out.status).toBe(204);
    expect((await app.request("/api/v1/auth/session", { headers: { cookie } }, env)).status).toBe(
      401,
    );
  });

  it("closed sign-in: an unknown email gets the identical 200, but no code, row or mail", async () => {
    await known("known@example.test");
    const box = withMailbox();
    const users = await env.DB.prepare('SELECT count(*) AS n FROM "user"').first<{ n: number }>();

    const ip = nextIp();
    const knownResponse = await sendCode("known@example.test", box.env, ip);
    const unknownResponse = await sendCode("Nobody-Here@Example.test", box.env, ip);
    expect(unknownResponse.status).toBe(knownResponse.status);
    expect(await unknownResponse.text()).toBe(await knownResponse.text());
    expect(unknownResponse.headers.get("content-type")).toBe(
      knownResponse.headers.get("content-type"),
    );
    expect(unknownResponse.headers.get("set-cookie")).toBe(knownResponse.headers.get("set-cookie"));

    expect(box.sent.map((m) => m.to)).toEqual(["known@example.test"]);
    const after = await env.DB.prepare('SELECT count(*) AS n FROM "user"').first<{ n: number }>();
    expect(after?.n).toBe(users?.n);
    expect(await countRows("user", "email", "nobody-here@example.test")).toBe(0);
    expect(
      await countRows("verification", "identifier", "sign-in-otp-nobody-here@example.test"),
    ).toBe(0);
    expect(await auditRows("AUTH_OTP_SENT", "nobody-here@example.test")).toEqual([
      { outcome: "unknown_email", client: expect.any(String) },
    ]);
  });

  it("closed sign-in: a fabricated code for an unknown email fails exactly like a wrong code", async () => {
    await known("wrong-code@example.test");
    const box = withMailbox();
    await sendCode("wrong-code@example.test", box.env, nextIp());
    await sendCode("ghost@example.test", box.env, nextIp());
    const good = box.codeFor("wrong-code@example.test");
    const fabricated = good === "000000" ? "111111" : "000000";

    const wrong = await verifyCode("wrong-code@example.test", fabricated, box.env, nextIp());
    const ghost = await verifyCode("ghost@example.test", fabricated, box.env, nextIp());
    expect(ghost.status).toBe(wrong.status);
    expect(ghost.status).toBe(400);
    expect(await ghost.text()).toBe(await wrong.text());
    expect(ghost.headers.get("set-cookie")).toBeNull();
    expect(await countRows("user", "email", "ghost@example.test")).toBe(0);
    expect(await auditRows("AUTH_LOGIN_FAILED", "ghost@example.test")).toEqual([
      { method: "email_otp", reason: "INVALID_OTP", client: expect.any(String) },
    ]);
  });

  it("a mail failure still answers 200 and records the error code", async () => {
    await known("bounce@example.test");
    const failing = {
      ...env,
      EMAIL: {
        send: async () => {
          throw Object.assign(new Error("nope"), { code: "E_SENDER_NOT_VERIFIED" });
        },
      } as unknown as SendEmail,
    };
    const response = await sendCode("bounce@example.test", failing, nextIp());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(await auditRows("AUTH_OTP_SENT", "bounce@example.test")).toEqual([
      { outcome: "send_failed", errorCode: "E_SENDER_NOT_VERIFIED", client: expect.any(String) },
    ]);
  });

  it("an invalid code fails, is audited without the code, and names nothing", async () => {
    await known("invalid@example.test");
    const box = withMailbox();
    const ip = nextIp();
    await sendCode("invalid@example.test", box.env, ip);
    const good = box.codeFor("invalid@example.test");
    const wrong = good === "000000" ? "111111" : "000000";
    const response = await verifyCode("invalid@example.test", wrong, box.env, ip);
    expect(response.status).toBe(400);
    expect(response.headers.get("set-cookie")).toBeNull();
    const failures = await auditRows("AUTH_LOGIN_FAILED", "invalid@example.test");
    expect(failures).toEqual([
      { method: "email_otp", reason: "INVALID_OTP", client: expect.any(String) },
    ]);
    expect(JSON.stringify(failures)).not.toContain(wrong);
  });

  it("a reused code is refused", async () => {
    await known("reuse@example.test");
    const box = withMailbox();
    const ip = nextIp();
    await sendCode("reuse@example.test", box.env, ip);
    const code = box.codeFor("reuse@example.test");
    expect((await verifyCode("reuse@example.test", code, box.env, ip)).status).toBe(200);
    const again = await verifyCode("reuse@example.test", code, box.env, nextIp());
    expect(again.status).toBe(400);
    expect(again.headers.get("set-cookie")).toBeNull();
  });

  it("an expired code is refused", async () => {
    await known("expired@example.test");
    const box = withMailbox();
    const ip = nextIp();
    await sendCode("expired@example.test", box.env, ip);
    const code = box.codeFor("expired@example.test");
    await env.DB.prepare("UPDATE verification SET expires_at = ? WHERE identifier = ?")
      .bind(Date.now() - 1000, "sign-in-otp-expired@example.test")
      .run();
    const response = await verifyCode("expired@example.test", code, box.env, ip);
    expect(response.status).toBe(400);
    expect(await auditRows("AUTH_LOGIN_FAILED", "expired@example.test")).toEqual([
      { method: "email_otp", reason: "OTP_EXPIRED", client: expect.any(String) },
    ]);
  });

  it("a resend re-sends the still-valid code, so a third party's request cannot invalidate it", async () => {
    await known("resend@example.test");
    const box = withMailbox();
    await sendCode("resend@example.test", box.env, nextIp());
    const first = box.codeFor("resend@example.test");
    await sendCode("resend@example.test", box.env, nextIp());
    const second = box.codeFor("resend@example.test");
    expect(second).toBe(first);
    expect(box.sent.filter((m) => m.to === "resend@example.test")).toHaveLength(2);
    expect((await verifyCode("resend@example.test", first, box.env, nextIp())).status).toBe(200);
  });

  it("five wrong codes from clients that requested it burn the code; foreign guesses do not (T-2)", async () => {
    await known("attempts@example.test");
    const box = withMailbox();
    // Five requesting clients (the per-IP sign-in limit is 3 / 60 s, so one guess each).
    const requesters = Array.from({ length: 5 }, () => nextIp());
    for (const ip of requesters) await sendCode("attempts@example.test", box.env, ip);
    const good = box.codeFor("attempts@example.test");
    const wrong = good === "000000" ? "111111" : "000000";
    // Guesses from clients that never asked for the code do not spend its attempts…
    for (let i = 0; i < 6; i += 1) {
      expect((await verifyCode("attempts@example.test", wrong, box.env, nextIp())).status).toBe(
        400,
      );
    }
    // …the requesters' own wrong entries do, five of them burn it.
    for (const ip of requesters) {
      expect((await verifyCode("attempts@example.test", wrong, box.env, ip)).status).toBe(400);
    }
    const locked = await verifyCode("attempts@example.test", good, box.env, requesters[0] ?? "");
    expect(locked.status).toBe(403);
  });

  it("rate-limits OTP sends per IP (Better Auth, D1 storage)", async () => {
    const box = withMailbox();
    const ip = nextIp();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push((await sendCode(`ip-limit-${i}@example.test`, box.env, ip)).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    const stored = await env.DB.prepare("SELECT count(*) AS n FROM rate_limit").first<{
      n: number;
    }>();
    expect(stored?.n).toBeGreaterThan(0);
  });

  it("H-1: a caller at another IP cannot lock the owner out; the owner still gets a code", async () => {
    await known("victim@example.test");
    const attacker = nextIp();
    // Five earlier sends for the victim from the attacker's IP (the per-(email, client) cap).
    for (let i = 0; i < 5; i += 1) await seedSend("victim@example.test", attacker);
    const box = withMailbox();

    const fromAttacker = await sendCode("victim@example.test", box.env, attacker);
    expect(fromAttacker.status).toBe(200);
    await expect(fromAttacker.json()).resolves.toEqual({ success: true });
    expect(box.sent).toHaveLength(0);

    const owner = nextIp();
    const fromOwner = await sendCode("victim@example.test", box.env, owner);
    expect(fromOwner.status).toBe(200);
    expect(box.sent).toHaveLength(1);
    const verified = await verifyCode(
      "victim@example.test",
      box.codeFor("victim@example.test"),
      box.env,
      owner,
    );
    expect(verified.status).toBe(200);
  });

  it("S-2: no per-email ceiling: after many sends from other clients the owner still gets a code", async () => {
    await known("bombed@example.test");
    for (let i = 0; i < 40; i += 1) await seedSend("bombed@example.test", `10.1.0.${i}`);
    const box = withMailbox();
    const response = await sendCode("bombed@example.test", box.env, nextIp());
    expect(response.status).toBe(200);
    expect(box.sent.map((m) => m.to)).toEqual(["bombed@example.test"]);
  });

  it("S-6: ten failed codes from one client for an address fail every further code from it", async () => {
    await known("guessed@example.test");
    const box = withMailbox();
    const guesser = nextIp();
    const db = createDb(env.DB);
    const key = await counterKey("otp-fail", "guessed@example.test", guesser);
    for (let i = 0; i < 10; i += 1) await bumpCounter(db, key, OTP_FAILURE_CAP.windowSeconds);

    await sendCode("guessed@example.test", box.env, nextIp());
    const code = box.codeFor("guessed@example.test");
    // From the guessing client even the right code fails like a wrong one, and is not consumed…
    const blocked = await verifyCode("guessed@example.test", code, box.env, guesser);
    expect(blocked.status).toBe(400);
    await expect(blocked.json()).resolves.toMatchObject({ code: "INVALID_OTP" });
    // …so the owner, elsewhere, still signs in with it.
    expect((await verifyCode("guessed@example.test", code, box.env, nextIp())).status).toBe(200);
  });

  it("M-3: anonymous callers cannot write audit rows without bound", async () => {
    const box = withMailbox();
    // Sends to unknown addresses from one IP: Better Auth's per-IP limit (3 / 60 s) bounds rows.
    const ip = nextIp();
    for (let i = 0; i < 6; i += 1) await sendCode(`spray-${i}@example.test`, box.env, ip);
    const { results } = await env.DB.prepare(
      "SELECT count(*) AS n FROM audit_log WHERE entity_id LIKE 'spray-%@example.test'",
    ).all<{ n: number }>();
    expect(results[0]?.n).toBe(3);

    // Failed verifies for an address with no user row: one audit row per window, not per attempt.
    for (let i = 0; i < 5; i += 1) {
      expect(
        (await verifyCode("nobody-verify@example.test", "123456", box.env, nextIp())).status,
      ).toBe(400);
    }
    expect(await auditRows("AUTH_LOGIN_FAILED", "nobody-verify@example.test")).toHaveLength(1);
  });

  it("L-2: a cross-site or origin-less POST to the auth endpoints is refused, cookie or not", async () => {
    await known("csrf-login@example.test");
    const box = withMailbox();
    const evil = await app.request(
      "/api/auth/sign-in/email-otp",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://evil.example",
          "sec-fetch-site": "cross-site",
          "cf-connecting-ip": nextIp(),
        },
        body: "email=csrf-login%40example.test&otp=123456",
      },
      box.env,
    );
    expect(evil.status).toBe(403);
    expect(evil.headers.get("set-cookie")).toBeNull();
    const bare = await app.request(
      "/api/auth/email-otp/send-verification-otp",
      {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": nextIp() },
        body: JSON.stringify({ email: "csrf-login@example.test", type: "sign-in" }),
      },
      box.env,
    );
    expect(bare.status).toBe(403);
    expect(box.sent).toHaveLength(0);
    const sameOrigin = await app.request(
      "/api/auth/email-otp/send-verification-otp",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost",
          "sec-fetch-site": "same-origin",
          "cf-connecting-ip": nextIp(),
        },
        body: JSON.stringify({ email: "csrf-login@example.test", type: "sign-in" }),
      },
      box.env,
    );
    expect(sameOrigin.status).toBe(200);
  });

  it("H-2: only the product's auth endpoints answer; everything else is 404", async () => {
    const paths = [
      "/api/auth/sign-up/email",
      "/api/auth/sign-up/email/",
      "/api/auth/forget-password",
      "/api/auth/request-password-reset",
      "/api/auth/two-factor/get-totp-uri",
      "/api/auth/two-factor/send-otp",
      "/api/auth/update-user",
      "/api/auth/revoke-session",
      "/api/auth/revoke-sessions",
      "/api/auth/revoke-other-sessions",
      "/api/auth/change-email",
      "/api/auth/email-otp/send-verification-otp/",
    ];
    for (const path of paths) {
      const response = await post(path, {}, env, { ip: nextIp() });
      expect(response.status, path).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "not_found" });
    }
    const listSessions = await app.request("/api/auth/list-sessions", {}, env);
    expect(listSessions.status).toBe(404);
  });

  it("rate-limits OTP verification per IP", async () => {
    const box = withMailbox();
    const ip = nextIp();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push(
        (await verifyCode(`verify-limit-${i}@example.test`, "123456", box.env, ip)).status,
      );
    }
    expect(statuses.slice(0, 3)).toEqual([400, 400, 400]);
    expect(statuses[3]).toBe(429);
  });

  it("rejects a filled honeypot with a plain 400 and sends nothing", async () => {
    const box = withMailbox();
    const response = await sendCode("bot@example.test", box.env, nextIp(), {
      [HONEYPOT_HEADER]: "http://spam.example",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    expect(box.sent).toHaveLength(0);
  });

  it("only issues sign-in codes", async () => {
    const box = withMailbox();
    const response = await post(
      "/api/auth/email-otp/send-verification-otp",
      { email: "reset@example.test", type: "forget-password" },
      box.env,
      { ip: nextIp() },
    );
    expect(response.status).toBe(400);
    expect(box.sent).toHaveLength(0);
  });
});

describe("OTP dev echo", () => {
  it("never echoes in production and refuses to start with OTP_DEV_ECHO there", async () => {
    expect(() =>
      assertAuthConfig({ ENVIRONMENT: "production", OTP_DEV_ECHO: "1", BETTER_AUTH_SECRET: "x" }),
    ).toThrow();
    expect(() => createAuth({ ...env, ENVIRONMENT: "production", OTP_DEV_ECHO: "1" })).toThrow();
    // L-10: no secret, no auth.
    expect(() => createAuth({ ...env, BETTER_AUTH_SECRET: undefined })).toThrow(
      /BETTER_AUTH_SECRET/,
    );
    expect(() =>
      assertAuthConfig({ ENVIRONMENT: "development", OTP_DEV_ECHO: "1", BETTER_AUTH_SECRET: "x" }),
    ).not.toThrow();

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const noBinding = { ...env, EMAIL: undefined as unknown as SendEmail };
      await sendOtpEmail(
        { ...noBinding, ENVIRONMENT: "production", OTP_DEV_ECHO: "1" },
        { to: "p@example.test", code: "123456" },
      );
      expect(log).not.toHaveBeenCalled();
      const outcome = await sendOtpEmail(
        { ...noBinding, ENVIRONMENT: "development", OTP_DEV_ECHO: "1" },
        { to: "d@example.test", code: "654321" },
      );
      expect(log).toHaveBeenCalledWith("[otp-dev-echo]", "d@example.test", "654321");
      expect(outcome).toEqual({
        outcome: "send_failed",
        errorCode: "E_NO_EMAIL_BINDING",
        echoed: true,
      });
    } finally {
      log.mockRestore();
    }
  });
});
