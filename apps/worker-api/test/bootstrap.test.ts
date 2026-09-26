// A file of its own: these tests need a database with no super admin yet.
import { env } from "cloudflare:test";
import type { SessionResponse } from "@cloudbox/contracts";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../src/env";
import app from "../src/index";

const EMAIL = "owner@example.test";
const PASSWORD = "bootstrap-initial-password-1";

function mailbox(overrides: Partial<Bindings> = {}) {
  const sent: { to: string; text: string }[] = [];
  const e: Bindings = {
    ...env,
    BOOTSTRAP_SUPER_ADMIN_EMAIL: "Owner@Example.test",
    BOOTSTRAP_SUPER_ADMIN_PASSWORD: PASSWORD,
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

const post = (path: string, body: unknown, e: Bindings, ip: string) =>
  app.request(
    path,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": ip,
        origin: "http://localhost",
      },
      body: JSON.stringify(body),
    },
    e,
  );

async function count(query: string, ...binds: unknown[]) {
  const row = await env.DB.prepare(query)
    .bind(...binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

describe("bootstrap super admin", () => {
  it("seeds user, super_admin row and initial password once, even for two concurrent first requests", async () => {
    expect(await count("SELECT count(*) AS n FROM staff_members WHERE role = 'super_admin'")).toBe(
      0,
    );
    const box = mailbox();
    const [a, b] = await Promise.all([
      app.request(
        "/api/auth/get-session",
        { headers: { "cf-connecting-ip": "192.0.2.10" } },
        box.env,
      ),
      app.request(
        "/api/auth/get-session",
        { headers: { "cf-connecting-ip": "192.0.2.11" } },
        box.env,
      ),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);

    expect(await count('SELECT count(*) AS n FROM "user" WHERE email = ?', EMAIL)).toBe(1);
    expect(await count("SELECT count(*) AS n FROM staff_members WHERE role = 'super_admin'")).toBe(
      1,
    );
    expect(
      await count(
        `SELECT count(*) AS n FROM account a JOIN "user" u ON u.id = a.user_id
         WHERE u.email = ? AND a.provider_id = 'credential'`,
        EMAIL,
      ),
    ).toBe(1);
    for (const event of ["STAFF_ROLE_GRANTED", "STAFF_PASSWORD_SET"]) {
      expect(
        await count(
          "SELECT count(*) AS n FROM audit_log WHERE event_type = ? AND actor_type = 'system' AND actor_id = 'bootstrap'",
          event,
        ),
      ).toBe(1);
    }
    const rows = await env.DB.prepare("SELECT after_json FROM audit_log").all<{
      after_json: string | null;
    }>();
    expect(JSON.stringify(rows.results)).not.toContain(PASSWORD);

    // The owner signs in with the seeded password and lands in the forced setup.
    const signIn = await post(
      "/api/auth/sign-in/email",
      { email: EMAIL, password: PASSWORD },
      box.env,
      "192.0.2.12",
    );
    expect(signIn.status).toBe(200);
    const session = (await (
      await app.request("/api/v1/auth/session", { headers: { cookie: cookieOf(signIn) } }, env)
    ).json()) as SessionResponse;
    expect(session.user.staffRole).toBe("super_admin");
    expect(session.setup).toEqual({ passwordChangeRequired: true, authenticatorRequired: true });

    // Staff never receive email codes.
    const otp = await post(
      "/api/auth/email-otp/send-verification-otp",
      { email: EMAIL, type: "sign-in" },
      box.env,
      "192.0.2.13",
    );
    expect(otp.status).toBe(200);
    expect(box.sent).toHaveLength(0);
  });

  it("never re-seeds: a changed secret does not overwrite the password, and nothing else is created", async () => {
    const box = mailbox({ BOOTSTRAP_SUPER_ADMIN_PASSWORD: "a-different-password-2" });
    const withNew = await post(
      "/api/auth/sign-in/email",
      { email: EMAIL, password: "a-different-password-2" },
      box.env,
      "192.0.2.20",
    );
    expect(withNew.status).toBe(401);
    const withOriginal = await post(
      "/api/auth/sign-in/email",
      { email: EMAIL, password: PASSWORD },
      box.env,
      "192.0.2.21",
    );
    expect(withOriginal.status).toBe(200);

    const late = mailbox({ BOOTSTRAP_SUPER_ADMIN_EMAIL: "late-owner@example.test" });
    await app.request("/api/auth/get-session", {}, late.env);
    expect(
      await count('SELECT count(*) AS n FROM "user" WHERE email = ?', "late-owner@example.test"),
    ).toBe(0);
    expect(await count("SELECT count(*) AS n FROM staff_members WHERE role = 'super_admin'")).toBe(
      1,
    );
  });
});
