// Owner: WT-1. Users exist only because an admin action (or the bootstrap rule) created them:
// sign-in never creates a `user` row (ADR 0002). Staff grants, tenant memberships (WT-2) and the
// bootstrap super admin all go through `ensureUserByEmail`.
import { sql } from "drizzle-orm";
import { audit } from "../audit";
import { createDb } from "../db/client";
import type { Bindings } from "../env";
import { type AuthRequestContext, createAuth, PRODUCTION_ORIGIN } from "./index";

/**
 * Returns the id of the `user` with this email, creating it through Better Auth's internal adapter
 * when missing (email unverified until their first code is verified). Idempotent and safe under
 * concurrency: a lost race on the unique email index re-reads the winner's row.
 */
export async function ensureUserByEmail(
  env: Bindings,
  email: string,
  request: AuthRequestContext = {},
): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const ctx = await createAuth(env, { ...request, baseURL: request.baseURL ?? PRODUCTION_ORIGIN })
    .$context;
  const found = await ctx.internalAdapter.findUserByEmail(normalized);
  if (found) return found.user.id;
  try {
    const created = await ctx.internalAdapter.createUser(
      { email: normalized, name: "", emailVerified: false },
      { method: "admin" },
    );
    return created.id;
  } catch (error) {
    const winner = await ctx.internalAdapter.findUserByEmail(normalized);
    if (winner) return winner.user.id;
    throw error;
  }
}

/**
 * While no super admin exists, make sure `BOOTSTRAP_SUPER_ADMIN_EMAIL` has a user row and the
 * `super_admin` staff row, so that address can sign in at all. Runs on auth requests; after the
 * first super admin exists it costs one indexed read. The grant is one `INSERT … WHERE NOT EXISTS`
 * statement, so concurrent first requests produce one row and one audit entry.
 */
export async function ensureBootstrapSuperAdmin(
  env: Bindings,
  request: AuthRequestContext = {},
): Promise<void> {
  const email = env.BOOTSTRAP_SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  if (!email) return;
  const db = createDb(env.DB);
  const existing = await db.get<{ one: number } | undefined>(
    sql`SELECT 1 AS one FROM staff_members WHERE role = 'super_admin' LIMIT 1`,
  );
  if (existing) return;

  const userId = await ensureUserByEmail(env, email, request);
  const result = await db.run(sql`
    INSERT INTO staff_members (user_id, role, created_by)
    SELECT ${userId}, 'super_admin', 'system'
    WHERE NOT EXISTS (SELECT 1 FROM staff_members WHERE role = 'super_admin')
    ON CONFLICT (user_id) DO NOTHING`);
  if ((result.meta?.changes ?? 0) === 0) return;
  await audit(db, {
    eventType: "STAFF_ROLE_GRANTED",
    entityType: "staff_member",
    entityId: userId,
    actor: { type: "system", id: "bootstrap" },
    before: null,
    after: { role: "super_admin", email, reason: "bootstrap" },
    correlationId: request.correlationId ?? null,
    source: "api",
  });
}
