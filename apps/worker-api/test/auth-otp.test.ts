import { env } from "cloudflare:test";
import type { SessionResponse } from "@cloudbox/contracts";
import { describe, expect, it, vi } from "vitest";
import { assertOtpEchoSafe, createAuth, HONEYPOT_HEADER } from "../src/auth";
import { ensureUserByEmail } from "../src/auth/users";
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
      headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...headers },
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
      { outcome: "sent", messageId: "msg-1" },
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
      { outcome: "unknown_email" },
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
      { reason: "INVALID_OTP" },
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
      { outcome: "send_failed", errorCode: "E_SENDER_NOT_VERIFIED" },
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
    expect(failures).toEqual([{ reason: "INVALID_OTP" }]);
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
      { reason: "OTP_EXPIRED" },
    ]);
  });

  it("a resend supersedes the previous code", async () => {
    await known("resend@example.test");
    const box = withMailbox();
    const ip = nextIp();
    await sendCode("resend@example.test", box.env, ip);
    const first = box.codeFor("resend@example.test");
    await sendCode("resend@example.test", box.env, ip);
    const second = box.codeFor("resend@example.test");
    if (first !== second) {
      expect((await verifyCode("resend@example.test", first, box.env, ip)).status).toBe(400);
    }
    expect((await verifyCode("resend@example.test", second, box.env, nextIp())).status).toBe(200);
  });

  it("three wrong codes burn the code, even the right one then fails", async () => {
    await known("attempts@example.test");
    const box = withMailbox();
    await sendCode("attempts@example.test", box.env, nextIp());
    const good = box.codeFor("attempts@example.test");
    const wrong = good === "000000" ? "111111" : "000000";
    // Separate IPs so the per-IP sign-in limit (3 / 10 s) is not what stops us.
    for (let i = 0; i < 3; i += 1) {
      expect((await verifyCode("attempts@example.test", wrong, box.env, nextIp())).status).toBe(
        400,
      );
    }
    const locked = await verifyCode("attempts@example.test", good, box.env, nextIp());
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

  it("rate-limits OTP sends per email across IPs", async () => {
    await known("email-limit@example.test");
    const box = withMailbox();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await sendCode("email-limit@example.test", box.env, nextIp())).status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    expect(box.sent.filter((m) => m.to === "email-limit@example.test")).toHaveLength(5);
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
    expect(() => assertOtpEchoSafe({ ENVIRONMENT: "production", OTP_DEV_ECHO: "1" })).toThrow();
    expect(() => createAuth({ ...env, ENVIRONMENT: "production", OTP_DEV_ECHO: "1" })).toThrow();
    expect(() =>
      assertOtpEchoSafe({ ENVIRONMENT: "development", OTP_DEV_ECHO: "1" }),
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
