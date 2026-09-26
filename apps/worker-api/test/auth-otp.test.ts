import { env } from "cloudflare:test";
import type { SessionResponse } from "@cloudbox/contracts";
import { describe, expect, it, vi } from "vitest";
import { assertOtpEchoSafe, createAuth, HONEYPOT_HEADER } from "../src/auth";
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

describe("email OTP sign-in", () => {
  it("send → verify → session → logout, with a stubbed mailer and audit rows", async () => {
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
    expect(await auditRows("AUTH_OTP_SENT", "flow@example.test")).toEqual([{ messageId: "msg-1" }]);

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

  it("anti-enumeration: an unknown and a known email get the identical response", async () => {
    const box = withMailbox();
    const ip = nextIp();
    // Make the "known" user exist first.
    await sendCode("known@example.test", box.env, ip);
    await verifyCode("known@example.test", box.codeFor("known@example.test"), box.env, ip);

    const ip2 = nextIp();
    const known = await sendCode("known@example.test", box.env, ip2);
    const unknown = await sendCode("nobody-here@example.test", box.env, ip2);
    expect(known.status).toBe(unknown.status);
    expect(await known.text()).toBe(await unknown.text());
  });

  it("a mail failure still answers 200 and records the error code", async () => {
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
      { errorCode: "E_SENDER_NOT_VERIFIED" },
    ]);
  });

  it("an invalid code fails, is audited without the code, and names nothing", async () => {
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

describe("bootstrap super admin", () => {
  it("grants super_admin to the bootstrap email on first verify, once, audited as system", async () => {
    const box = withMailbox({ BOOTSTRAP_SUPER_ADMIN_EMAIL: "Owner@Example.test" });
    const existing = await env.DB.prepare(
      "SELECT count(*) AS n FROM staff_members WHERE role = 'super_admin'",
    ).first<{ n: number }>();
    expect(existing?.n).toBe(0);

    const ip = nextIp();
    await sendCode("owner@example.test", box.env, ip);
    const verified = await verifyCode(
      "owner@example.test",
      box.codeFor("owner@example.test"),
      box.env,
      ip,
    );
    expect(verified.status).toBe(200);
    const cookie = cookieFrom(verified);
    const body = (await (
      await app.request("/api/v1/auth/session", { headers: { cookie } }, env)
    ).json()) as SessionResponse;
    expect(body.user.staffRole).toBe("super_admin");
    expect(body.permissions).toContain("staff.manage");

    const grants = await env.DB.prepare(
      "SELECT actor_type, actor_id FROM audit_log WHERE event_type = 'STAFF_ROLE_GRANTED' AND entity_id = ?",
    )
      .bind(body.user.id)
      .all();
    expect(grants.results).toEqual([{ actor_type: "system", actor_id: "bootstrap" }]);

    // A second sign-in does not grant again.
    const ip2 = nextIp();
    await sendCode("owner@example.test", box.env, ip2);
    await verifyCode("owner@example.test", box.codeFor("owner@example.test"), box.env, ip2);
    const again = await env.DB.prepare(
      "SELECT count(*) AS n FROM audit_log WHERE event_type = 'STAFF_ROLE_GRANTED' AND entity_id = ?",
    )
      .bind(body.user.id)
      .first<{ n: number }>();
    expect(again?.n).toBe(1);
  });

  it("does nothing for other emails, or once a super admin exists", async () => {
    const box = withMailbox({ BOOTSTRAP_SUPER_ADMIN_EMAIL: "late-owner@example.test" });
    const ip = nextIp();
    await sendCode("late-owner@example.test", box.env, ip);
    const verified = await verifyCode(
      "late-owner@example.test",
      box.codeFor("late-owner@example.test"),
      box.env,
      ip,
    );
    const body = (await (
      await app.request("/api/v1/auth/session", { headers: { cookie: cookieFrom(verified) } }, env)
    ).json()) as SessionResponse;
    // The previous test's owner is already super admin in this file's database.
    expect(body.user.staffRole).toBeNull();
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
      expect(outcome).toEqual({ errorCode: "E_NO_EMAIL_BINDING", echoed: true });
    } finally {
      log.mockRestore();
    }
  });
});
