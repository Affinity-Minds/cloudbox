// Owner: WT-1. Module `staff`, mounted at `/api/v1/staff` in routes/v1/index.ts.
// GET / (list), POST / (grant or change a role by email), DELETE /:userId (revoke). All gated by
// the `staff.manage` permission row and audited as STAFF_ROLE_GRANTED / STAFF_ROLE_REVOKED.
import { CreateStaffRequest, type StaffMember, type StaffRole } from "@cloudbox/contracts";
import { zValidator } from "@hono/zod-validator";
import { asc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { audit } from "../../audit";
import { authContextFor } from "../../auth";
import { ensureUserByEmail } from "../../auth/users";
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

/** True when `userId` is the only super admin, so removing or demoting them would lock everyone out. */
async function isLastSuperAdmin(db: Db, userId: string): Promise<boolean> {
  const [row] = await db
    .select({
      isSuper: sql<number>`max(case when ${staffMembers.userId} = ${userId} then 1 else 0 end)`,
      others: sql<number>`sum(case when ${staffMembers.userId} != ${userId} then 1 else 0 end)`,
    })
    .from(staffMembers)
    .where(eq(staffMembers.role, "super_admin"));
  return Number(row?.isSuper ?? 0) === 1 && Number(row?.others ?? 0) === 0;
}

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
    const { email, role } = c.req.valid("json");
    const db = createDb(c.env.DB);
    const actor = c.var.user;

    // The user may never have signed in: create the row (admin action) so the grant is waiting
    // when they first verify a code. Sign-in itself never creates users (ADR 0002).
    const targetId = await ensureUserByEmail(c.env, email, authContextFor(c));

    const [existing] = await db
      .select({ role: staffMembers.role })
      .from(staffMembers)
      .where(eq(staffMembers.userId, targetId));
    if (existing?.role === role) {
      const [member] = await listStaff(db, targetId);
      return c.json(member, 200);
    }
    if (existing?.role === "super_admin" && (await isLastSuperAdmin(db, targetId))) {
      return c.json({ error: "conflict", detail: "last_super_admin" }, 409);
    }

    await db.batch([
      db
        .insert(staffMembers)
        .values({ userId: targetId, role, createdBy: actor.id })
        .onConflictDoUpdate({ target: staffMembers.userId, set: { role } }),
      audit(db, {
        eventType: "STAFF_ROLE_GRANTED",
        entityType: "staff_member",
        entityId: targetId,
        actor: { type: "user", id: actor.id },
        before: existing ? { role: existing.role } : null,
        after: { role, email },
        correlationId: c.var.correlationId,
        source: "api",
      }),
    ]);
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
  if (existing.role === "super_admin" && (await isLastSuperAdmin(db, userId))) {
    return c.json({ error: "conflict", detail: "last_super_admin" }, 409);
  }

  await db.batch([
    db.delete(staffMembers).where(eq(staffMembers.userId, userId)),
    audit(db, {
      eventType: "STAFF_ROLE_REVOKED",
      entityType: "staff_member",
      entityId: userId,
      actor: { type: "user", id: actor.id },
      before: { role: existing.role as StaffRole },
      after: null,
      correlationId: c.var.correlationId,
      source: "api",
    }),
  ]);
  return c.body(null, 204);
});

export default staff;
