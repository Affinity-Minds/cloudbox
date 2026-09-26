// A file of its own: these tests need a database with no super admin yet.
import { env } from "cloudflare:test";
import type { SessionResponse } from "@cloudbox/contracts";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../src/env";
import app from "../src/index";

const BOOTSTRAP = "Owner@Example.test";

function mailbox() {
  const sent: { to: string; text: string }[] = [];
  const e: Bindings = {
    ...env,
    BOOTSTRAP_SUPER_ADMIN_EMAIL: BOOTSTRAP,
    EMAIL: {
      send: async (m: { to: string; text: string }) => {
        sent.push(m);
        return { messageId: `m${sent.length}` };
      },
    } as unknown as SendEmail,
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

async function count(sql: string, ...binds: unknown[]) {
  const row = await env.DB.prepare(sql)
    .bind(...binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("bootstrap super admin", () => {
  it("creates the bootstrap user + super_admin row once, even for two concurrent first requests", async () => {
    expect(await count("SELECT count(*) AS n FROM staff_members WHERE role = 'super_admin'")).toBe(
      0,
    );
    const box = mailbox();
    const [a, b] = await Promise.all([
      post(
        "/api/auth/email-otp/send-verification-otp",
        { email: "owner@example.test", type: "sign-in" },
        box.env,
        "192.0.2.10",
      ),
      post(
        "/api/auth/email-otp/send-verification-otp",
        { email: "owner@example.test", type: "sign-in" },
        box.env,
        "192.0.2.11",
      ),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);

    expect(
      await count('SELECT count(*) AS n FROM "user" WHERE email = ?', "owner@example.test"),
    ).toBe(1);
    expect(await count("SELECT count(*) AS n FROM staff_members WHERE role = 'super_admin'")).toBe(
      1,
    );
    expect(
      await count(
        "SELECT count(*) AS n FROM audit_log WHERE event_type = 'STAFF_ROLE_GRANTED' AND actor_type = 'system' AND actor_id = 'bootstrap'",
      ),
    ).toBe(1);

    // The address can now sign in and is super admin. (Two concurrent sends can each store a code;
    // a later resend re-sends the one that verifies.)
    await post(
      "/api/auth/email-otp/send-verification-otp",
      { email: "owner@example.test", type: "sign-in" },
      box.env,
      "192.0.2.13",
    );
    const code = box.sent.at(-1)?.text.match(/\b(\d{6})\b/)?.[1] ?? "";
    const verified = await post(
      "/api/auth/sign-in/email-otp",
      { email: "owner@example.test", otp: code },
      box.env,
      "192.0.2.12",
    );
    expect(verified.status).toBe(200);
    const cookie = verified.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const session = (await (
      await app.request("/api/v1/auth/session", { headers: { cookie } }, env)
    ).json()) as SessionResponse;
    expect(session.user.staffRole).toBe("super_admin");
  });

  it("is idempotent once a super admin exists, whatever the bootstrap email says", async () => {
    const box = mailbox();
    box.env.BOOTSTRAP_SUPER_ADMIN_EMAIL = "late-owner@example.test";
    const response = await post(
      "/api/auth/email-otp/send-verification-otp",
      { email: "late-owner@example.test", type: "sign-in" },
      box.env,
      "192.0.2.20",
    );
    expect(response.status).toBe(200);
    // A super admin already exists (previous test): no new user, no grant, nothing sent.
    expect(
      await count('SELECT count(*) AS n FROM "user" WHERE email = ?', "late-owner@example.test"),
    ).toBe(0);
    expect(await count("SELECT count(*) AS n FROM staff_members WHERE role = 'super_admin'")).toBe(
      1,
    );
    expect(box.sent).toHaveLength(0);
  });
});
