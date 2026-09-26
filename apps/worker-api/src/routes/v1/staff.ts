// Owner: WT-1. Module `staff`, mounted at `/api/v1/staff` in routes/v1/index.ts.
// GET / (list), POST / (grant or change a role by email), DELETE /:userId (revoke). All gated by
// the `staff.manage` permission row and audited as STAFF_ROLE_GRANTED / STAFF_ROLE_REVOKED.
import { CreateStaffRequest, type StaffMember, type StaffRole } from "@cloudbox/contracts";
import { zValidator } from "@hono/zod-validator";
import { and, asc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { audit } from "../../audit";
import { authContextFor } from "../../auth";
import { ensureUserByEmail, setInitialStaffPassword } from "../../auth/users";
import { requirePermission } from "../../authz/permissions";
import { createDb, type Db } from "../../db/client";
import { staffMembers, user } from "../../db/schema";
import type { AppEnv } from "../../env";

const staff = new Hono<AppEnv>();

function listStaff(db: Db, userId?: string) {
  return db
    .select({
      userId: staffMembers.userId,
      email: user.email,
      name: user.name,
      role: staffMembers.role,
      createdBy: staffMembers.createdBy,
      createdAt: staffMembers.createdAt,
    })
    .from(staffMembers)
    .innerJoin(user, eq(user.id, staffMembers.userId))
    .where(userId === undefined ? undefined : eq(staffMembers.userId, userId))
    .orderBy(asc(user.email));
}

/**
 * SQL condition, true while changing `userId`'s row cannot remove the last super admin: the row is
 * not a super admin, or another super admin exists. Used inside the write itself (review L-8), so
 * two super admins demoting each other at the same moment cannot both succeed.
 */
const keepsASuperAdmin = (userId: string) =>
  sql`(${staffMembers.role} != 'super_admin' OR (SELECT count(*) FROM staff_members AS other
    WHERE other.role = 'super_admin' AND other.user_id != ${userId}) > 0)`;

const changed = (result: { meta?: { changes?: number } }) => (result.meta?.changes ?? 0) > 0;

staff.get("/", requirePermission("staff.manage"), async (c) => {
  const items: StaffMember[] = await listStaff(createDb(c.env.DB));
  return c.json({ items });
});

staff.post(
  "/",
  requirePermission("staff.manage"),
  zValidator("json", CreateStaffRequest, (result, c) => {
    if (!result.success) return c.json({ error: "invalid_request" }, 400);
  }),
  async (c) => {
    const { email, role, initialPassword } = c.req.valid("json");
    const db = createDb(c.env.DB);
    const actor = c.var.user;

    const [existing] = await db
      .select({ userId: staffMembers.userId, role: staffMembers.role })
      .from(staffMembers)
      .innerJoin(user, eq(user.id, staffMembers.userId))
      .where(eq(user.email, email));
    // A new staff member signs in with password + authenticator (ADR 0009): the admin sets the
    // initial password here and hands it over out of band.
    if (!existing && !initialPassword) {
      return c.json({ error: "invalid_request", detail: "initial_password_required" }, 400);
    }

    // The user may never have signed in: create the row (admin action). Sign-in itself never
    // creates users (ADR 0002/0009).
    const targetId = existing?.userId ?? (await ensureUserByEmail(c.env, email, authContextFor(c)));

    if (existing?.role !== role) {
      const result = await db
        .insert(staffMembers)
        .values({ userId: targetId, role, createdBy: actor.id })
        .onConflictDoUpdate({
          target: staffMembers.userId,
          set: { role },
          setWhere: keepsASuperAdmin(targetId),
        })
        .run();
      if (!changed(result)) return c.json({ error: "conflict", detail: "last_super_admin" }, 409);
      await audit(db, {
        eventType: "STAFF_ROLE_GRANTED",
        entityType: "staff_member",
        entityId: targetId,
        actor: { type: "user", id: actor.id },
        before: existing ? { role: existing.role } : null,
        after: { role, email },
        correlationId: c.var.correlationId,
        source: "api",
      });
    }
    if (initialPassword) {
      // Forces a password change and authenticator re-enrolment at next sign-in and ends the
      // member's sessions. The password itself is never audited or logged.
      await setInitialStaffPassword(c.env, targetId, initialPassword, authContextFor(c));
      await audit(db, {
        eventType: "STAFF_PASSWORD_SET",
        entityType: "staff_member",
        entityId: targetId,
        actor: { type: "user", id: actor.id },
        before: null,
        after: { reason: existing ? "admin_reset" : "new_staff", mustChangePassword: true },
        correlationId: c.var.correlationId,
        source: "api",
      });
    }
    const [member] = await listStaff(db, targetId);
    return c.json(member, existing ? 200 : 201);
  },
);

staff.delete("/:userId", requirePermission("staff.manage"), async (c) => {
  const userId = c.req.param("userId");
  const actor = c.var.user;
  const db = createDb(c.env.DB);
  if (userId === actor.id) return c.json({ error: "conflict", detail: "cannot_revoke_self" }, 409);

  const [existing] = await db
    .select({ role: staffMembers.role })
    .from(staffMembers)
    .where(eq(staffMembers.userId, userId));
  if (!existing) return c.json({ error: "not_found" }, 404);
  const result = await db
    .delete(staffMembers)
    .where(and(eq(staffMembers.userId, userId), keepsASuperAdmin(userId)))
    .run();
  if (!changed(result)) {
    return c.json({ error: "conflict", detail: "last_super_admin" }, 409);
  }
  await audit(db, {
    eventType: "STAFF_ROLE_REVOKED",
    entityType: "staff_member",
    entityId: userId,
    actor: { type: "user", id: actor.id },
    before: { role: existing.role as StaffRole },
    after: null,
    correlationId: c.var.correlationId,
    source: "api",
  });
  return c.body(null, 204);
});

export default staff;
