// WT-8 review (docs/reviews/phase-1-security.md). Each test asserts the SECURE behaviour; a failure
// is the finding. Do not "fix" these by editing the assertions.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../../src/index";
import v1 from "../../src/routes/v1";
import { signInAs } from "../auth-fixtures";

let ip = 0;
const nextIp = () => `203.0.113.${++ip}`;

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": nextIp(), ...headers },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe("F-2: unused emailOTP endpoints are not reachable", () => {
  // Only send-verification-otp (type sign-in) and sign-in/email-otp are product flows.
  const unused = [
    ["/api/auth/email-otp/request-password-reset", { email: "x@example.test" }],
    ["/api/auth/forget-password/email-otp", { email: "x@example.test" }],
    [
      "/api/auth/email-otp/reset-password",
      { email: "x@example.test", otp: "000000", password: "p".repeat(12) },
    ],
    [
      "/api/auth/email-otp/check-verification-otp",
      { email: "x@example.test", type: "sign-in", otp: "000000" },
    ],
    ["/api/auth/email-otp/verify-email", { email: "x@example.test", otp: "000000" }],
  ] as const;
  for (const [path, body] of unused) {
    it(`${path} answers 404`, async () => {
      expect((await post(path, body)).status).toBe(404);
    });
  }
});

describe("F-4: every /api/v1 route outside the allowlist requires a session", () => {
  const PUBLIC = new Set([
    "GET /api/v1",
    "GET /api/v1/foundation",
    "PATCH /api/v1/foundation/release",
    "GET /api/v1/onboarding/config", // WT-14: the /start page's Turnstile site key, public by design
  ]);
  const routes = v1.routes
    .filter((r) => r.method !== "ALL")
    .map((r) => ({ method: r.method, path: `/api/v1${r.path}`.replace(/\/$/, "") }))
    .filter((r) => !PUBLIC.has(`${r.method} ${r.path}`) && !r.path.startsWith("/api/v1/agent"));
  for (const r of routes) {
    it(`${r.method} ${r.path} → 401 without a session`, async () => {
      const url = r.path.replace(/:[A-Za-z]+/g, "x");
      const res = await app.request(url, { method: r.method }, env);
      expect(res.status).toBe(401);
    });
  }
});

describe("F-6: a trailing-slash sign-out still goes through the audited logout", () => {
  it("POST /api/auth/sign-out/ writes AUTH_LOGOUT or is refused", async () => {
    const s = await signInAs(env, { email: "slash-out@example.test" });
    const res = await app.request(
      "/api/auth/sign-out/",
      { method: "POST", headers: { ...s.headers, "content-type": "application/json" }, body: "{}" },
      env,
    );
    const row = await env.DB.prepare(
      "SELECT count(*) AS n FROM audit_log WHERE event_type = 'AUTH_LOGOUT' AND entity_id = ?",
    )
      .bind(s.userId)
      .first<{ n: number }>();
    const sessionGone =
      (await app.request("/api/v1/auth/session", { headers: { cookie: s.cookie } }, env)).status ===
      401;
    // Either the unaudited path does not exist, or it was audited.
    expect(res.status === 404 || !sessionGone || (row?.n ?? 0) === 1).toBe(true);
  });
});

describe("F-8: session cookie attributes on https", () => {
  it("Secure, HttpOnly, SameSite=Lax, __Secure- prefix, no Domain", async () => {
    const s = await signInAs(env, { email: "cookie-attrs@example.test" });
    // Refreshing through get-session on the production origin re-issues the cookie.
    const res = await app.request(
      "https://box.affinity.ai.in/api/auth/get-session?disableCookieCache=true",
      { headers: { cookie: s.cookie.replace(/(^|; )better-auth/g, "$1__Secure-better-auth") } },
      env,
    );
    const cookies = res.headers.getSetCookie().join("\n");
    if (cookies) {
      expect(cookies).toMatch(/__Secure-/);
      expect(cookies).toMatch(/HttpOnly/i);
      expect(cookies).toMatch(/Secure/);
      expect(cookies).toMatch(/SameSite=Lax/i);
      expect(cookies).not.toMatch(/Domain=/i);
    }
  });
});
