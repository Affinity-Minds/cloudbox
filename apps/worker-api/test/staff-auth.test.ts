// Staff sign-in (ADR 0009): email + password + authenticator (TOTP), forced first-sign-in setup,
// no email codes for staff, no passwords for anyone else.
import { env } from "cloudflare:test";
import type { SessionResponse } from "@cloudbox/contracts";
import { betterAuth } from "better-auth";
import { beforeAll, describe, expect, it } from "vitest";
import { authOptions, PASSWORD_FAILURE_CAP } from "../src/auth";
import { bumpCounter, counterKey } from "../src/auth/counters";
import { ensureUserByEmail } from "../src/auth/users";
import { createDb } from "../src/db/client";
import type { Bindings } from "../src/env";
import app from "../src/index";
import { type SignedIn, signInAs, TEST_ORIGIN } from "./auth-fixtures";

const INITIAL = "initial-password-0001";
const CHOSEN = "my-own-long-password-42";

let ipCounter = 0;
/** Better Auth limits /sign-in and /two-factor/* per IP; each step uses its own address. */
const nextIp = () => `198.18.0.${++ipCounter}`;

let root: SignedIn;
beforeAll(async () => {
  root = await signInAs(env, { email: "staff-root@example.test", staffRole: "super_admin" });
});

/** A tiny cookie jar: Better Auth sets and expires several cookies across the flow. */
function jar() {
  const cookies = new Map<string, string>();
  return {
    header: () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
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

async function authPost(path: string, body: unknown, cookies?: Jar, e: Bindings = env) {
  const response = await app.request(
    path,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": nextIp(),
        origin: TEST_ORIGIN,
        ...(cookies ? { cookie: cookies.header() } : {}),
      },
      body: JSON.stringify(body),
    },
    e,
  );
  return cookies ? cookies.take(response) : response;
}

const get = (path: string, cookies: Jar) =>
  app.request(path, { headers: { cookie: cookies.header() } }, env);

async function createStaff(email: string, role = "read_only") {
  const response = await app.request(
    "/api/v1/staff",
    {
      method: "POST",
      headers: { ...root.headers, "content-type": "application/json" },
      body: JSON.stringify({ email, role, initialPassword: INITIAL }),
    },
    env,
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { userId: string }).userId;
}

/** Base32 (RFC 4648) → the raw secret Better Auth's TOTP generator takes. */
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

/** The current code for an otpauth:// URI, computed by Better Auth's own server-only endpoint. */
async function totpFor(totpURI: string): Promise<string> {
  const secret = base32Decode(new URL(totpURI).searchParams.get("secret") ?? "");
  const options = authOptions(env, { baseURL: TEST_ORIGIN });
  const { code } = await betterAuth(options).api.generateTOTP({ body: { secret } });
  return code;
}

const wrongCode = (code: string) => (code === "000000" ? "111111" : "000000");

/** Runs the whole forced first sign-in; returns the enrolled authenticator and backup codes. */
async function enrol(email: string) {
  await createStaff(email);
  const cookies = jar();
  const first = await authPost("/api/auth/sign-in/email", { email, password: INITIAL }, cookies);
  expect(first.status).toBe(200);
  const changed = await authPost(
    "/api/auth/change-password",
    { currentPassword: INITIAL, newPassword: CHOSEN, revokeOtherSessions: true },
    cookies,
  );
  expect(changed.status).toBe(200);
  const enabled = await authPost("/api/auth/two-factor/enable", { password: CHOSEN }, cookies);
  expect(enabled.status).toBe(200);
  const { totpURI, backupCodes } = (await enabled.json()) as {
    totpURI: string;
    backupCodes: string[];
  };
  const confirmed = await authPost(
    "/api/auth/two-factor/verify-totp",
    { code: await totpFor(totpURI) },
    cookies,
  );
  expect(confirmed.status).toBe(200);
  return { cookies, totpURI, backupCodes };
}

async function auditEvents(entityId: string) {
  const { results } = await env.DB.prepare(
    "SELECT event_type, after_json FROM audit_log WHERE entity_id = ? ORDER BY rowid",
  )
    .bind(entityId)
    .all<{ event_type: string; after_json: string | null }>();
  return results;
}

describe("staff never use email codes; nobody else uses passwords", () => {
  it("a staff email gets the customer answer to a code request, but no code", async () => {
    await createStaff("no-codes@example.test");
    await ensureUserByEmail(env, "customer-a@example.test");
    const sent: string[] = [];
    const mailEnv = {
      ...env,
      EMAIL: {
        send: async (m: { to: string }) => {
          sent.push(m.to);
          return { messageId: "m" };
        },
      } as unknown as SendEmail,
    };
    const staff = await authPost(
      "/api/auth/email-otp/send-verification-otp",
      { email: "no-codes@example.test", type: "sign-in" },
      undefined,
      mailEnv,
    );
    const customer = await authPost(
      "/api/auth/email-otp/send-verification-otp",
      { email: "customer-a@example.test", type: "sign-in" },
      undefined,
      mailEnv,
    );
    expect(staff.status).toBe(200);
    expect(await staff.text()).toBe(await customer.text());
    expect(sent).toEqual(["customer-a@example.test"]);

    // A code submitted for a staff email fails exactly like a wrong code for a customer.
    const staffVerify = await authPost("/api/auth/sign-in/email-otp", {
      email: "no-codes@example.test",
      otp: "123456",
    });
    const customerVerify = await authPost("/api/auth/sign-in/email-otp", {
      email: "customer-a@example.test",
      otp: "000000",
    });
    expect(staffVerify.status).toBe(customerVerify.status);
    expect(await staffVerify.text()).toBe(await customerVerify.text());
    expect(staffVerify.headers.get("set-cookie")).toBeNull();
  });

  it("password sign-in: a non-staff user (even one with a password) and an unknown email fail like a wrong password", async () => {
    const staffId = await createStaff("pw-owner@example.test");
    const wrong = await authPost("/api/auth/sign-in/email", {
      email: "pw-owner@example.test",
      password: "not-the-password-1",
    });
    expect(wrong.status).toBe(401);
    const body = await wrong.text();

    // A former staff member keeps a credential row, but is no longer staff.
    const formerId = await createStaff("former-staff@example.test");
    await env.DB.prepare("DELETE FROM staff_members WHERE user_id = ?").bind(formerId).run();
    const former = await authPost("/api/auth/sign-in/email", {
      email: "former-staff@example.test",
      password: INITIAL,
    });
    await ensureUserByEmail(env, "customer-b@example.test");
    const customer = await authPost("/api/auth/sign-in/email", {
      email: "customer-b@example.test",
      password: INITIAL,
    });
    const unknown = await authPost("/api/auth/sign-in/email", {
      email: "nobody-at-all@example.test",
      password: INITIAL,
    });
    for (const response of [former, customer, unknown]) {
      expect(response.status).toBe(401);
      expect(await response.text()).toBe(body);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    const failures = await auditEvents("pw-owner@example.test");
    expect(failures.map((r) => r.event_type)).toEqual(["AUTH_LOGIN_FAILED"]);
    expect(failures[0]?.after_json).not.toContain("not-the-password-1");
    expect(staffId).toBeTruthy();
  });
});

describe("forced first sign-in: password change, then authenticator", () => {
  it("blocks every staff route until both steps are done, in order", async () => {
    const userId = await createStaff("first-login@example.test");
    const cookies = jar();
    const signIn = await authPost(
      "/api/auth/sign-in/email",
      { email: "first-login@example.test", password: INITIAL },
      cookies,
    );
    expect(signIn.status).toBe(200);

    const session = (await (await get("/api/v1/auth/session", cookies)).json()) as SessionResponse;
    expect(session.setup).toEqual({ passwordChangeRequired: true, authenticatorRequired: true });
    const blocked = await get("/api/v1/screens/audit", cookies);
    expect(blocked.status).toBe(403);
    await expect(blocked.json()).resolves.toMatchObject({ error: "setup_required" });

    // Authenticator before the password change is refused.
    const early = await authPost("/api/auth/two-factor/enable", { password: INITIAL }, cookies);
    expect(early.status).toBe(403);
    // The new password must differ from the initial one.
    const same = await authPost(
      "/api/auth/change-password",
      { currentPassword: INITIAL, newPassword: INITIAL },
      cookies,
    );
    expect(same.status).toBe(400);
    const changed = await authPost(
      "/api/auth/change-password",
      { currentPassword: INITIAL, newPassword: CHOSEN, revokeOtherSessions: true },
      cookies,
    );
    expect(changed.status).toBe(200);
    const midway = (await (await get("/api/v1/auth/session", cookies)).json()) as SessionResponse;
    expect(midway.setup).toEqual({ passwordChangeRequired: false, authenticatorRequired: true });
    expect((await get("/api/v1/screens/audit", cookies)).status).toBe(403);

    const enabled = await authPost("/api/auth/two-factor/enable", { password: CHOSEN }, cookies);
    expect(enabled.status).toBe(200);
    const { totpURI, backupCodes } = (await enabled.json()) as {
      totpURI: string;
      backupCodes: string[];
    };
    expect(totpURI).toMatch(/^otpauth:\/\/totp\/CloudBox:/);
    expect(totpURI).toContain("issuer=CloudBox");
    expect(backupCodes).toHaveLength(10);
    // Enrolment is not complete until a code from the app is verified.
    expect((await get("/api/v1/screens/audit", cookies)).status).toBe(403);
    const confirmed = await authPost(
      "/api/auth/two-factor/verify-totp",
      { code: await totpFor(totpURI) },
      cookies,
    );
    expect(confirmed.status).toBe(200);
    expect((await get("/api/v1/screens/audit", cookies)).status).toBe(200);

    const events = (await auditEvents(userId)).map((r) => r.event_type);
    expect(events).toEqual(
      expect.arrayContaining([
        "AUTH_LOGIN_SUCCEEDED",
        "AUTH_PASSWORD_CHANGED",
        "AUTH_2FA_ENROLLMENT_STARTED",
        "AUTH_2FA_ENABLED",
      ]),
    );
    const everything = JSON.stringify(await auditEvents(userId));
    expect(everything).not.toContain(INITIAL);
    expect(everything).not.toContain(CHOSEN);
  });
});

describe("signing in with password + authenticator", () => {
  it("asks for the authenticator; a wrong code is audited and refused; the right one signs in", async () => {
    const { totpURI } = await enrol("two-step@example.test");
    const [row] = (
      await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
        .bind("two-step@example.test")
        .all<{ id: string }>()
    ).results;
    const cookies = jar();
    const step1 = await authPost(
      "/api/auth/sign-in/email",
      { email: "two-step@example.test", password: CHOSEN },
      cookies,
    );
    expect(step1.status).toBe(200);
    await expect(step1.json()).resolves.toMatchObject({ twoFactorRedirect: true });
    // No session yet: only the two-factor challenge cookie.
    expect((await get("/api/v1/auth/session", cookies)).status).toBe(401);

    const code = await totpFor(totpURI);
    const wrong = await authPost(
      "/api/auth/two-factor/verify-totp",
      { code: wrongCode(code) },
      cookies,
    );
    expect(wrong.status).toBe(401);
    const ok = await authPost("/api/auth/two-factor/verify-totp", { code }, cookies);
    expect(ok.status).toBe(200);
    expect((await get("/api/v1/screens/audit", cookies)).status).toBe(200);

    const events = await auditEvents(row?.id ?? "");
    const failed = events.filter((e) => e.event_type === "AUTH_LOGIN_FAILED");
    expect(failed).toHaveLength(1);
    expect(JSON.parse(failed[0]?.after_json ?? "{}")).toMatchObject({ method: "totp" });
    expect(
      events.some(
        (e) =>
          e.event_type === "AUTH_LOGIN_SUCCEEDED" &&
          JSON.parse(e.after_json ?? "{}").method === "password+totp",
      ),
    ).toBe(true);
  });

  it("limits wrong authenticator codes: five on one challenge burn it", async () => {
    const { totpURI } = await enrol("totp-limit@example.test");
    const cookies = jar();
    await authPost(
      "/api/auth/sign-in/email",
      { email: "totp-limit@example.test", password: CHOSEN },
      cookies,
    );
    const code = await totpFor(totpURI);
    for (let i = 0; i < 5; i += 1) {
      const r = await authPost(
        "/api/auth/two-factor/verify-totp",
        { code: wrongCode(code) },
        cookies,
      );
      expect(r.status).toBe(401);
    }
    const burned = await authPost("/api/auth/two-factor/verify-totp", { code }, cookies);
    expect(burned.status).toBeGreaterThanOrEqual(400);
    expect((await get("/api/v1/auth/session", cookies)).status).toBe(401);
  });

  it("a backup code works once", async () => {
    const { backupCodes } = await enrol("backup@example.test");
    const code = backupCodes[0] ?? "";
    const first = jar();
    await authPost(
      "/api/auth/sign-in/email",
      { email: "backup@example.test", password: CHOSEN },
      first,
    );
    const used = await authPost("/api/auth/two-factor/verify-backup-code", { code }, first);
    expect(used.status).toBe(200);
    expect((await get("/api/v1/screens/audit", first)).status).toBe(200);

    const second = jar();
    await authPost(
      "/api/auth/sign-in/email",
      { email: "backup@example.test", password: CHOSEN },
      second,
    );
    const again = await authPost("/api/auth/two-factor/verify-backup-code", { code }, second);
    expect(again.status).toBe(401);
    expect((await get("/api/v1/auth/session", second)).status).toBe(401);
  });

  it("turning the authenticator off needs the password and a fresh code", async () => {
    const { cookies, totpURI } = await enrol("disable@example.test");
    const noCode = await authPost("/api/auth/two-factor/disable", { password: CHOSEN }, cookies);
    expect(noCode.status).toBe(401);
    const code = await totpFor(totpURI);
    const badCode = await authPost(
      "/api/auth/two-factor/disable",
      { password: CHOSEN, code: wrongCode(code) },
      cookies,
    );
    expect(badCode.status).toBe(401);
    const ok = await authPost("/api/auth/two-factor/disable", { password: CHOSEN, code }, cookies);
    expect(ok.status).toBe(200);
    // Without an authenticator, staff are back in the forced setup.
    const session = (await (await get("/api/v1/auth/session", cookies)).json()) as SessionResponse;
    expect(session.setup?.authenticatorRequired).toBe(true);
  });
});

describe("password lockout (H-1 applied to passwords)", () => {
  it("five failures for (email, client) lock that client with the wrong-password body; others are unaffected", async () => {
    await enrol("locked@example.test");
    const attacker = "198.18.200.1";
    const db = createDb(env.DB);
    const key = await counterKey("pw-fail", "locked@example.test", attacker);
    for (let i = 0; i < 5; i += 1) await bumpCounter(db, key, PASSWORD_FAILURE_CAP.windowSeconds);
    const wrong = await authPost("/api/auth/sign-in/email", {
      email: "locked@example.test",
      password: "wrong-password-000",
    });
    const wrongBody = await wrong.text();

    const locked = await app.request(
      "/api/auth/sign-in/email",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": attacker,
          origin: TEST_ORIGIN,
        },
        body: JSON.stringify({ email: "locked@example.test", password: CHOSEN }),
      },
      env,
    );
    expect(locked.status).toBe(429);
    expect(await locked.text()).toBe(wrongBody);

    // The owner, elsewhere, still signs in.
    const owner = await authPost("/api/auth/sign-in/email", {
      email: "locked@example.test",
      password: CHOSEN,
    });
    expect(owner.status).toBe(200);
    await expect(owner.json()).resolves.toMatchObject({ twoFactorRedirect: true });
  });
});

describe("second-pass review (S-1, S-8, M-3)", () => {
  it("non-staff password failures: one audit row per window, and the same per-client lockout as staff", async () => {
    for (let i = 0; i < 3; i += 1) {
      const r = await authPost("/api/auth/sign-in/email", {
        email: "not-staff-pw@example.test",
        password: `guess-number-${i}-xyz`,
      });
      expect(r.status).toBe(401);
    }
    expect(await auditEvents("not-staff-pw@example.test")).toHaveLength(1);

    // Lockout is uniform: a locked (email, client) answers 429 whether or not the address is staff.
    const db = createDb(env.DB);
    await createStaff("staff-pw-lock@example.test");
    const client = "198.18.201.1";
    const bodies: string[] = [];
    for (const email of ["not-staff-pw@example.test", "staff-pw-lock@example.test"]) {
      const key = await counterKey("pw-fail", email, client);
      for (let i = 0; i < 5; i += 1) await bumpCounter(db, key, PASSWORD_FAILURE_CAP.windowSeconds);
      const r = await app.request(
        "/api/auth/sign-in/email",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "cf-connecting-ip": client,
            origin: TEST_ORIGIN,
          },
          body: JSON.stringify({ email, password: INITIAL }),
        },
        env,
      );
      expect(r.status).toBe(429);
      bodies.push(await r.text());
    }
    expect(bodies[0]).toBe(bodies[1]);
  });

  it("a password change ends every other session even when the client asks to keep them", async () => {
    await createStaff("revoke-others@example.test");
    const a = jar();
    const b = jar();
    for (const cookies of [a, b]) {
      await authPost(
        "/api/auth/sign-in/email",
        { email: "revoke-others@example.test", password: INITIAL },
        cookies,
      );
    }
    expect((await get("/api/v1/auth/session", b)).status).toBe(200);
    const changed = await authPost(
      "/api/auth/change-password",
      { currentPassword: INITIAL, newPassword: CHOSEN, revokeOtherSessions: false },
      a,
    );
    expect(changed.status).toBe(200);
    expect((await get("/api/v1/auth/session", b)).status).toBe(401);
    expect((await get("/api/v1/auth/session", a)).status).toBe(200);
  });

  it("the fresh code for turning the authenticator off cannot be replayed at sign-in", async () => {
    const { cookies, totpURI } = await enrol("disable-replay@example.test");
    const code = await totpFor(totpURI);
    // First sign-in use of the current code…
    const other = jar();
    await authPost(
      "/api/auth/sign-in/email",
      { email: "disable-replay@example.test", password: CHOSEN },
      other,
    );
    expect((await authPost("/api/auth/two-factor/verify-totp", { code }, other)).status).toBe(200);
    // …then the same code to disable is refused.
    const replay = await authPost(
      "/api/auth/two-factor/disable",
      { password: CHOSEN, code },
      cookies,
    );
    expect(replay.status).toBe(401);
  });
});
