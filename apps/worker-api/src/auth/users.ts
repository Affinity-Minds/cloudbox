// Owner: WT-1. Users exist only because an admin action (or the bootstrap rule) created them:
// sign-in never creates a `user` row (ADR 0002/0009). Staff grants, tenant memberships (WT-2) and
// the bootstrap super admin all go through `ensureUserByEmail`. Staff passwords are hashed and
// stored by Better Auth's own hasher and internal adapter; plaintext is never stored or logged.
import { eq, sql } from "drizzle-orm";
import { audit } from "../audit";
import { createDb } from "../db/client";
import { staffMembers, twoFactor, user } from "../db/schema";
import type { Bindings } from "../env";
import { type AuthRequestContext, createAuth, PRODUCTION_ORIGIN } from "./index";

function authContext(env: Bindings, request: AuthRequestContext) {
  return createAuth(env, { ...request, baseURL: request.baseURL ?? PRODUCTION_ORIGIN }).$context;
}

/**
 * Returns the id of the `user` with this email, creating it through Better Auth's internal adapter
 * when missing (email unverified until their first sign-in). Idempotent and safe under
 * concurrency: a lost race on the unique email index re-reads the winner's row.
 */
export async function ensureUserByEmail(
  env: Bindings,
  email: string,
  request: AuthRequestContext = {},
): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const ctx = await authContext(env, request);
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
 * Sets an admin-chosen initial password for a staff member (ADR 0009): stores Better Auth's hash
 * on the credential account, forces a change at next sign-in (`must_change_password = 1`), drops
 * the authenticator so it is enrolled again, and ends every session of that user.
 */
export async function setInitialStaffPassword(
  env: Bindings,
  userId: string,
  password: string,
  request: AuthRequestContext = {},
): Promise<void> {
  const ctx = await authContext(env, request);
  const hash = await ctx.password.hash(password);
  if (await ctx.internalAdapter.findCredentialAccount(userId)) {
    await ctx.internalAdapter.updatePassword(userId, hash);
  } else {
    await ctx.internalAdapter.linkAccount({
      userId,
      providerId: "credential",
      accountId: userId,
      password: hash,
    });
  }
  const db = createDb(env.DB);
  await db.batch([
    db
      .update(staffMembers)
      .set({ mustChangePassword: true })
      .where(eq(staffMembers.userId, userId)),
    db.delete(twoFactor).where(eq(twoFactor.userId, userId)),
    db.update(user).set({ twoFactorEnabled: false }).where(eq(user.id, userId)),
  ]);
  await ctx.internalAdapter.deleteUserSessions(userId);
}

const BOOTSTRAP_SEEDED_KEY = "auth.bootstrap_password_seeded";

/**
 * Until the bootstrap super admin exists and its initial password is seeded, make sure
 * `BOOTSTRAP_SUPER_ADMIN_EMAIL` has a user row, the `super_admin` staff row and (from the
 * `BOOTSTRAP_SUPER_ADMIN_PASSWORD` secret) a password, so that address can sign in at all.
 * Runs on auth requests; once done it costs one read. The grant is one `INSERT … WHERE NOT EXISTS`
 * and the seed is claimed by one `settings` row, so concurrent first requests produce one staff
 * row, one password and one audit entry each. The password is seeded once, ever: later changes by
 * the owner are never overwritten.
 */
export async function ensureBootstrapSuperAdmin(
  env: Bindings,
  request: AuthRequestContext = {},
): Promise<void> {
  const email = env.BOOTSTRAP_SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  if (!email) return;
  const password = env.BOOTSTRAP_SUPER_ADMIN_PASSWORD || null;
  const db = createDb(env.DB);
  const state = await db.get<{ has_super: number | null; seeded: number | null }>(sql`
    SELECT (SELECT 1 FROM staff_members WHERE role = 'super_admin' LIMIT 1) AS has_super,
           (SELECT 1 FROM settings WHERE key = ${BOOTSTRAP_SEEDED_KEY}) AS seeded`);
  const hasSuper = Boolean(state?.has_super);
  if (hasSuper && (state?.seeded || !password)) return;

  const userId = await ensureUserByEmail(env, email, request);
  if (!hasSuper) {
    const result = await db.run(sql`
      INSERT INTO staff_members (user_id, role, created_by, must_change_password)
      SELECT ${userId}, 'super_admin', 'system', 1
      WHERE NOT EXISTS (SELECT 1 FROM staff_members WHERE role = 'super_admin')
      ON CONFLICT (user_id) DO NOTHING`);
    if ((result.meta?.changes ?? 0) > 0) {
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
  }
  if (!password || state?.seeded) return;

  // Seed only while the bootstrap address is the super admin it was meant to be.
  const [staff] = await db
    .select({ role: staffMembers.role })
    .from(staffMembers)
    .where(eq(staffMembers.userId, userId));
  if (staff?.role !== "super_admin") return;
  const claim = await db.run(sql`
    INSERT INTO settings (key, value_json, updated_at)
    VALUES (${BOOTSTRAP_SEEDED_KEY}, ${JSON.stringify({ userId })}, ${new Date().toISOString()})
    ON CONFLICT (key) DO NOTHING`);
  if ((claim.meta?.changes ?? 0) === 0) return;
  const ctx = await authContext(env, request);
  const hash = await ctx.password.hash(password);
  if (await ctx.internalAdapter.findCredentialAccount(userId)) {
    await ctx.internalAdapter.updatePassword(userId, hash);
  } else {
    await ctx.internalAdapter.linkAccount({
      userId,
      providerId: "credential",
      accountId: userId,
      password: hash,
    });
  }
  await audit(db, {
    eventType: "STAFF_PASSWORD_SET",
    entityType: "staff_member",
    entityId: userId,
    actor: { type: "system", id: "bootstrap" },
    before: null,
    after: { reason: "bootstrap", mustChangePassword: true },
    correlationId: request.correlationId ?? null,
    source: "api",
  });
}
