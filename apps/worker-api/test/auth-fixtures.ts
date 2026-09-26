// Owner: WT-1. Signs a user in for route tests with a real Better Auth session.
// The session is created by Better Auth's own test-utils plugin on a test-only instance that shares
// the runtime options (same secret, adapter and cookie names), so the cookie is exactly what the
// app issues after an OTP sign-in. Nothing here mints tokens or cookies by hand.
import type { StaffRole } from "@cloudbox/contracts";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { authOptions } from "../src/auth";
import type { Bindings } from "../src/env";

export type SignedIn = {
  /** `Cookie` request header value. */
  cookie: string;
  userId: string;
  /** Ready-made headers for `app.request`: the cookie plus a same-origin `Origin` for writes. */
  headers: Record<string, string>;
};

export const TEST_ORIGIN = "http://localhost";

function testAuth(env: Bindings) {
  const options = authOptions(env, { baseURL: TEST_ORIGIN });
  return betterAuth({ ...options, plugins: [...options.plugins, testUtils()] });
}

/**
 * Creates the user when missing (email verified, as after an OTP sign-in), upserts the
 * `staff_members` row when `staffRole` is given, and returns a real session cookie.
 */
export async function signInAs(
  env: Bindings,
  input: {
    email: string;
    name?: string;
    staffRole?: StaffRole;
    /**
     * Staff only: whether the first-sign-in gates (password change + authenticator, ADR 0009) are
     * done. Default true, so route tests exercise permissions; the gate itself has its own tests.
     */
    setupComplete?: boolean;
  },
): Promise<SignedIn> {
  const ctx = await testAuth(env).$context;
  const email = input.email.toLowerCase();
  const existing = await ctx.internalAdapter.findUserByEmail(email);
  const user =
    existing?.user ??
    (await ctx.test.saveUser(
      ctx.test.createUser({ email, name: input.name ?? "", emailVerified: true }),
    ));

  if (input.staffRole) {
    await env.DB.prepare(
      `INSERT INTO staff_members (user_id, role, created_by) VALUES (?1, ?2, 'test')
       ON CONFLICT (user_id) DO UPDATE SET role = excluded.role`,
    )
      .bind(user.id, input.staffRole)
      .run();
    const done = input.setupComplete ?? true;
    await env.DB.batch([
      env.DB.prepare("UPDATE staff_members SET must_change_password = ?1 WHERE user_id = ?2").bind(
        done ? 0 : 1,
        user.id,
      ),
      env.DB.prepare('UPDATE "user" SET two_factor_enabled = ?1 WHERE id = ?2').bind(
        done ? 1 : 0,
        user.id,
      ),
    ]);
  }

  const { headers } = await ctx.test.login({ userId: user.id });
  const cookie = headers.get("cookie") ?? "";
  return { cookie, userId: user.id, headers: { cookie, origin: TEST_ORIGIN } };
}
