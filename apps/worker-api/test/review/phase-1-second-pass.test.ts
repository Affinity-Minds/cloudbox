// WT-8 second pass (docs/reviews/phase-1-security.md, "Second pass"). Each test asserts the SECURE
// behaviour; a failing test is an open finding. Do not change the assertions to make them pass.
import { env } from "cloudflare:test";
import { betterAuth } from "better-auth";
import { beforeAll, describe, expect, it } from "vitest";
import { authOptions, createAuth } from "../../src/auth";
import { ensureUserByEmail } from "../../src/auth/users";
import type { Bindings } from "../../src/env";
import app from "../../src/index";
import v1 from "../../src/routes/v1";
import { type SignedIn, signInAs, TEST_ORIGIN } from "../auth-fixtures";

const INITIAL = "review-initial-password-01";
const CHOSEN = "review-chosen-password-0042";

let ipCounter = 0;
const nextIp = () => {
  ipCounter += 1;
  return `100.64.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
};

let root: SignedIn;
beforeAll(async () => {
  root = await signInAs(env, { email: "review-root@example.test", staffRole: "super_admin" });
});

function jar() {
  const cookies = new Map<string, string>();
  return {
    header: () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    names: () => [...cookies.keys()],
    take(response: Response) {
      for (const raw of response.headers.getSetCookie()) {
        const [pair = "", ...attrs] = raw.split(";");
        const [name = "", value = ""] = pair.split("=");
        const expired = !value || attrs.some((a) => /max-age=0\b/i.test(a.trim()));
        if (expired) cookies.delete(name.trim());
        else cookies.set(name.trim(), value);
      }
      return response;
    },
  };
}
type Jar = ReturnType<typeof jar>;

async function authPost(
  path: string,
  body: unknown,
  opts: { cookies?: Jar; ip?: string; e?: Bindings } = {},
) {
  const response = await app.request(
    path,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": opts.ip ?? nextIp(),
        origin: TEST_ORIGIN,
        ...(opts.cookies ? { cookie: opts.cookies.header() } : {}),
      },
      body: JSON.stringify(body),
    },
    opts.e ?? env,
  );
  return opts.cookies ? opts.cookies.take(response) : response;
}

async function staffPost(body: unknown, as: SignedIn = root) {
  return app.request(
    "/api/v1/staff",
    {
      method: "POST",
      headers: { ...as.headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

function base32Decode(input: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of input.replace(/=+$/, "").toUpperCase()) {
    bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  }
  let out = "";
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    out += String.fromCharCode(Number.parseInt(bits.slice(i, i + 8), 2));
  }
  return out;
}

async function totpFor(totpURI: string): Promise<string> {
  const secret = base32Decode(new URL(totpURI).searchParams.get("secret") ?? "");
  const { code } = await betterAuth(authOptions(env, { baseURL: TEST_ORIGIN })).api.generateTOTP({
    body: { secret },
  });
  return code;
}

/** New staff member through the real API, then the forced first sign-in to completion. */
async function enrol(email: string) {
  expect((await staffPost({ email, role: "read_only", initialPassword: INITIAL })).status).toBe(
    201,
  );
  const cookies = jar();
  expect(
    (await authPost("/api/ops/auth/sign-in/email", { email, password: INITIAL }, { cookies }))
      .status,
  ).toBe(200);
  expect(
    (
      await authPost(
        "/api/ops/auth/change-password",
        { currentPassword: INITIAL, newPassword: CHOSEN, revokeOtherSessions: true },
        { cookies },
      )
    ).status,
  ).toBe(200);
  const enabled = await authPost(
    "/api/ops/auth/two-factor/enable",
    { password: CHOSEN },
    { cookies },
  );
  const { totpURI, backupCodes } = (await enabled.json()) as {
    totpURI: string;
    backupCodes: string[];
  };
  expect(
    (
      await authPost(
        "/api/ops/auth/two-factor/verify-totp",
        { code: await totpFor(totpURI) },
        { cookies },
      )
    ).status,
  ).toBe(200);
  return { cookies, totpURI, backupCodes };
}

/** Password step of a sign-in for an enrolled staff member: a jar holding the pending challenge. */
async function challenge(email: string) {
  const cookies = jar();
  const res = await authPost(
    "/api/ops/auth/sign-in/email",
    { email, password: CHOSEN },
    { cookies },
  );
  expect(res.status).toBe(200);
  await expect(res.json()).resolves.toMatchObject({ twoFactorRedirect: true });
  return cookies;
}

describe("S-1 (High): the per-account password ceiling is a lockout anyone can trigger", () => {
  it("100 wrong passwords from 100 unrelated clients do not stop the owner's correct password", async () => {
    const email = "review-pw-dos@example.test";
    expect((await staffPost({ email, role: "read_only", initialPassword: INITIAL })).status).toBe(
      201,
    );
    for (let batch = 0; batch < 10; batch += 1) {
      await Promise.all(
        Array.from({ length: 10 }, () =>
          authPost("/api/ops/auth/sign-in/email", { email, password: "attacker-guess-000000" }),
        ),
      );
    }
    const owner = await authPost("/api/ops/auth/sign-in/email", { email, password: INITIAL });
    expect(owner.status).toBe(200);
  }, 120_000);
});

describe("S-2 (High): the per-email OTP ceiling silently drops the owner's code", () => {
  it("30 sends from 10 unrelated clients, then the owner still receives a code", async () => {
    const email = "review-otp-dos@example.test";
    await ensureUserByEmail(env, email); // a customer (admin-created user, not staff)
    const sent: { to: string; text: string }[] = [];
    const mailEnv = {
      ...env,
      EMAIL: {
        send: async (m: { to: string; text: string }) => {
          sent.push(m);
          return { messageId: `m-${sent.length}` };
        },
      } as unknown as SendEmail,
    } satisfies Bindings;
    for (let client = 0; client < 10; client += 1) {
      const ip = nextIp();
      for (let i = 0; i < 3; i += 1) {
        await authPost(
          "/api/auth/email-otp/send-verification-otp",
          { email, type: "sign-in" },
          { ip, e: mailEnv },
        );
      }
    }
    // Let the code the attacker's sends kept alive expire, as it would 5 minutes later.
    await env.DB.prepare("UPDATE customer_verifications SET expires_at = ? WHERE identifier = ?")
      .bind(Date.now() - 1000, `sign-in-otp-${email}`)
      .run();
    const before = sent.length;
    const owner = await authPost(
      "/api/auth/email-otp/send-verification-otp",
      { email, type: "sign-in" },
      { e: mailEnv },
    );
    expect(owner.status).toBe(200);
    expect(sent.length).toBeGreaterThan(before);
  });
});

describe("S-3 (Medium): a TOTP code is accepted more than once", () => {
  it("the same authenticator code cannot complete two sign-ins", async () => {
    const email = "review-totp-replay@example.test";
    const { totpURI } = await enrol(email);
    const code = await totpFor(totpURI);
    const first = await challenge(email);
    expect(
      (await authPost("/api/ops/auth/two-factor/verify-totp", { code }, { cookies: first })).status,
    ).toBe(200);
    const second = await challenge(email);
    const replay = await authPost(
      "/api/ops/auth/two-factor/verify-totp",
      { code },
      { cookies: second },
    );
    expect(replay.status).not.toBe(200);
  });
});

describe("S-4 (Medium): trusted devices bypass the authenticator and survive an admin reset", () => {
  it("the server does not issue a trust-device cookie (the product never offers one)", async () => {
    const email = "review-trust@example.test";
    const { totpURI } = await enrol(email);
    const cookies = await challenge(email);
    const res = await authPost(
      "/api/ops/auth/two-factor/verify-totp",
      { code: await totpFor(totpURI), trustDevice: true },
      { cookies },
    );
    expect(res.status).toBe(200);
    expect(cookies.names().some((n) => n.includes("trust_device"))).toBe(false);
  });

  it("an admin reset ends sessions, removes the authenticator and revokes trusted devices", async () => {
    const email = "review-trust-reset@example.test";
    const { totpURI, cookies: setupCookies } = await enrol(email);
    const cookies = await challenge(email);
    await authPost(
      "/api/ops/auth/two-factor/verify-totp",
      { code: await totpFor(totpURI), trustDevice: true },
      { cookies },
    );
    const userId = (
      await env.DB.prepare("SELECT id FROM staff_users WHERE email = ?")
        .bind(email)
        .first<{ id: string }>()
    )?.id;
    const reset = await staffPost({ email, role: "read_only", initialPassword: INITIAL });
    expect(reset.status).toBe(200);
    // Sessions end (this part holds today).
    for (const jarred of [cookies, setupCookies]) {
      const s = await app.request(
        "/api/v1/auth/session",
        { headers: { cookie: jarred.header() } },
        env,
      );
      expect(s.status).toBe(401);
    }
    const trust = await env.DB.prepare(
      "SELECT count(*) AS n FROM staff_verifications WHERE identifier LIKE 'trust-device-%' AND value = ?",
    )
      .bind(userId)
      .first<{ n: number }>();
    expect(trust?.n).toBe(0);
  });
});

describe("S-5 (Medium): the reset path hands the resetter a working credential for a peer", () => {
  it("a super admin cannot reset another super admin's password and sign in as them", async () => {
    const victim = "review-peer-super@example.test";
    expect(
      (await staffPost({ email: victim, role: "super_admin", initialPassword: INITIAL })).status,
    ).toBe(201);
    const takeover = await staffPost({
      email: victim,
      role: "super_admin",
      initialPassword: "chosen-by-the-other-admin-1",
    });
    expect(takeover.status).toBe(403);
  });

  it("with staff.manage granted to 'admin' (permissions are rows), an admin cannot promote itself", async () => {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO role_permissions (role, permission_key) VALUES ('admin', 'staff.manage')",
    ).run();
    try {
      const admin = await signInAs(env, { email: "review-admin@example.test", staffRole: "admin" });
      const res = await staffPost(
        { email: "review-admin@example.test", role: "super_admin" },
        admin,
      );
      expect(res.status).toBe(403);
    } finally {
      await env.DB.prepare(
        "DELETE FROM role_permissions WHERE role = 'admin' AND permission_key = 'staff.manage'",
      ).run();
    }
  });

  it("(holds) an admin without staff.manage cannot reset a super admin", async () => {
    const admin = await signInAs(env, { email: "review-admin2@example.test", staffRole: "admin" });
    const res = await staffPost(
      { email: "review-root@example.test", role: "super_admin", initialPassword: INITIAL },
      admin,
    );
    expect(res.status).toBe(403);
  });
});

describe("S-6 (holds): every /api/v1 route answers setup_required to staff mid-setup", () => {
  const OPEN_DURING_SETUP = new Set(["GET /api/v1/auth/session", "POST /api/v1/auth/logout"]);
  // WT-1 (owner decision, two identity systems): customer-only routes never read a staff session,
  // so a staff account mid-setup gets 401 there, not setup_required. Asserted in authz tests.
  // WT-14: self-service onboarding and the Connect device list are customer-only too.
  // WT-15: the customer portal's own screens (`requireTenantStanding`, customer session only) —
  // matched narrowly (not the whole `/api/v1/tenants` prefix, which is staff-gated CRUD).
  const CUSTOMER_ONLY = (path: string) =>
    ["/api/v1/me", "/api/v1/onboarding", "/api/v1/connect"].some((p) => path.startsWith(p)) ||
    /\/tenants\/:tenantId\/portal(\/|$)/.test(path);
  const PUBLIC = new Set([
    "GET /api/v1",
    "GET /api/v1/foundation",
    "PATCH /api/v1/foundation/release",
    "GET /api/v1/onboarding/config", // WT-14: public by design
  ]);
  const routes = [
    ...new Map(
      v1.routes
        .filter((r) => r.method !== "ALL")
        .map((r) => ({ method: r.method, path: `/api/v1${r.path}`.replace(/\/$/, "") }))
        .filter(
          (r) =>
            !PUBLIC.has(`${r.method} ${r.path}`) &&
            !OPEN_DURING_SETUP.has(`${r.method} ${r.path}`) &&
            !CUSTOMER_ONLY(r.path) &&
            !r.path.startsWith("/api/v1/agent"),
        )
        .map((r) => [`${r.method} ${r.path}`, r]),
    ).values(),
  ];
  for (const r of routes) {
    it(`${r.method} ${r.path}`, async () => {
      const pending = await signInAs(env, {
        email: "review-pending@example.test",
        staffRole: "super_admin",
        setupComplete: false,
      });
      const res = await app.request(
        r.path.replace(/:[A-Za-z]+/g, "x"),
        {
          method: r.method,
          headers: { ...pending.headers, "content-type": "application/json" },
          body: r.method === "GET" ? undefined : "{}",
        },
        env,
      );
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({ error: "setup_required" });
    });
  }
});

describe("S-7 (holds): the /api/auth allowlist covers every Better Auth endpoint", () => {
  const ALLOWED = new Set([
    "/email-otp/send-verification-otp",
    "/sign-in/email-otp",
    "/sign-in/email",
    "/two-factor/verify-totp",
    "/two-factor/verify-backup-code",
    "/change-password",
    "/two-factor/enable",
    "/two-factor/generate-backup-codes",
    "/two-factor/disable",
    "/sign-out",
    "/get-session",
  ]);
  const endpoints = Object.values(createAuth(env).api as Record<string, unknown>)
    .map((e) => (e as { path?: string }).path)
    .filter((p): p is string => typeof p === "string" && !ALLOWED.has(p));
  it("enumerates a non-trivial endpoint list", () => {
    expect(endpoints.length).toBeGreaterThan(20);
  });
  for (const path of new Set(endpoints)) {
    for (const method of ["GET", "POST"]) {
      it(`${method} /api/auth${path} → 404`, async () => {
        const res = await app.request(
          `/api/auth${path}`,
          {
            method,
            headers: { origin: TEST_ORIGIN, "content-type": "application/json" },
            body: method === "POST" ? "{}" : undefined,
          },
          env,
        );
        expect(res.status).toBe(404);
      });
    }
  }
});

describe("S-8 (holds): no secret material in audit rows after a full staff lifecycle", () => {
  it("passwords, TOTP secret and backup codes never appear in audit_log", async () => {
    const email = "review-secrets@example.test";
    const { totpURI, backupCodes } = await enrol(email);
    const cookies = await challenge(email);
    await authPost(
      "/api/ops/auth/two-factor/verify-backup-code",
      { code: backupCodes[0] },
      { cookies },
    );
    await authPost("/api/ops/auth/sign-in/email", { email, password: "wrong-password-xyz-1" });
    const { results } = await env.DB.prepare(
      "SELECT coalesce(before_json,'') || coalesce(after_json,'') AS j FROM audit_log",
    ).all<{ j: string }>();
    const all = results.map((r) => r.j).join("\n");
    const secret = new URL(totpURI).searchParams.get("secret") ?? "";
    for (const needle of [INITIAL, CHOSEN, "wrong-password-xyz-1", secret, ...backupCodes]) {
      expect(all).not.toContain(needle);
    }
  });
});

describe("S-9 (Low): bootstrap seeding forces the change it records", () => {
  it("seeding a password onto an existing super admin sets must_change_password", async () => {
    const email = "review-bootstrap@example.test";
    const s = await signInAs(env, { email, staffRole: "super_admin" }); // setup complete
    await env.DB.prepare("DELETE FROM settings WHERE key = 'auth.bootstrap_password_seeded'").run();
    const e = {
      ...env,
      BOOTSTRAP_SUPER_ADMIN_EMAIL: email,
      BOOTSTRAP_SUPER_ADMIN_PASSWORD: "bootstrap-secret-password-1",
    } satisfies Bindings;
    await app.request("/api/ops/auth/get-session", {}, e);
    const row = await env.DB.prepare(
      "SELECT must_change_password AS m FROM staff_members WHERE user_id = ?",
    )
      .bind(s.userId)
      .first<{ m: number }>();
    const audited = await env.DB.prepare(
      "SELECT count(*) AS n FROM audit_log WHERE event_type = 'STAFF_PASSWORD_SET' AND entity_id = ?",
    )
      .bind(s.userId)
      .first<{ n: number }>();
    expect(audited?.n).toBe(1); // the seed ran
    expect(row?.m).toBe(1);
  });
});
