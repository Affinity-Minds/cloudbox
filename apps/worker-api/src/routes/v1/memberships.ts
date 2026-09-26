// Owner: WT-2. Module `memberships`, mounted at `/api/v1/tenants/:tenantId/memberships` in
// routes/v1/index.ts. Routes (docs/handoffs/foundation.md): POST /, PATCH /:id, DELETE /:id.
//
// Tenant Owner/Admin manage their own tenant's memberships; staff manage any tenant's via
// `tenant.manage`. `requireTenantManageOrAdmin` uses WT-1's exported `guard()` directly (its
// handoff: a route open to both staff and tenant members needs `guard()`, since
// `requireTenantStanding` alone does not let staff through).
//
// The Hono generic's third parameter declares this router's *mount* path, not its own routes, so
// `c.req.param("tenantId")` resolves against the parent `:tenantId` segment (Hono does not
// propagate a parent router's path params into a sub-router's own param-key typing otherwise).
import {
  CreateMembershipRequest,
  type MembershipStanding,
  UpdateMembershipRequest,
} from "@cloudbox/contracts";
import { zValidator } from "@hono/zod-validator";
import { and, eq, sql } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { audit } from "../../audit";
import { getPrincipal, guard, type Principal } from "../../auth/middleware";
import { ensureCustomerByEmail } from "../../auth/users";
import { getTenantStanding } from "../../authz/permissions";
import { createDb } from "../../db/client";
import { customerUsers, tenantMemberships, tenants } from "../../db/schema";
import type { AppEnv } from "../../env";
import { newId, nowIso } from "../../ids";

// biome-ignore lint/complexity/noBannedTypes: Hono's Schema generic default, not our shape.
const router = new Hono<AppEnv, {}, "/tenants/:tenantId/memberships">();

/** Staff with `tenant.manage`, OR a member of this tenant standing at `admin` or above. */
function requireTenantManageOrAdmin(): MiddlewareHandler<AppEnv> {
  return guard(async (principal, c) => {
    if (principal.permissions.has("tenant.manage")) return true;
    const tenantId = c.req.param("tenantId");
    if (!tenantId) return false;
    const standing = await getTenantStanding(c, tenantId);
    return standing === "admin" || standing === "owner";
  });
}

const STANDING_RANK: Record<MembershipStanding, number> = { user: 1, admin: 2, owner: 3 };

/**
 * Ranking (review U-2, mirrors staff S-5): staff with `tenant.manage` bypass this entirely — there
 * is no tenant standing to rank them against. A tenant member may only grant a standing at or
 * below its own, and may only change or revoke a membership whose *current* standing is strictly
 * below its own (which also rules out touching its own membership, since its own standing is never
 * strictly below itself). Returns a ready-to-return 403 response, or null when allowed.
 */
async function assertStandingRank(
  c: Context<AppEnv>,
  principal: Principal,
  tenantId: string,
  target: { currentStanding?: MembershipStanding; newStanding?: MembershipStanding },
): Promise<Response | null> {
  if (principal.permissions.has("tenant.manage")) return null;
  const actorStanding = await getTenantStanding(c, tenantId);
  const actorRank = actorStanding ? STANDING_RANK[actorStanding] : 0;
  if (target.currentStanding !== undefined && STANDING_RANK[target.currentStanding] >= actorRank) {
    return c.json({ error: "forbidden" }, 403);
  }
  if (target.newStanding !== undefined && STANDING_RANK[target.newStanding] > actorRank) {
    return c.json({ error: "forbidden" }, 403);
  }
  return null;
}

/**
 * SQL condition, true while writing this membership cannot remove the tenant's last active owner:
 * the row is not currently an active owner, the write keeps it an owner, or another active owner
 * exists for the same tenant. Used inside the write itself (review L-8 pattern, mirrored from
 * `staff.ts`'s `keepsASuperAdmin`), so two concurrent writes against the same membership cannot
 * both succeed in removing the last owner. `newStanding` is always a bound parameter (never raw
 * text), including when omitted (DELETE): `null = 'owner'` is simply never true in SQLite.
 */
const keepsAnOwner = (tenantId: string, membershipId: string, newStanding?: MembershipStanding) =>
  sql`(
    ${tenantMemberships.standing} != 'owner'
    OR ${tenantMemberships.status} != 'active'
    OR ${newStanding ?? null} = 'owner'
    OR (SELECT count(*) FROM tenant_memberships AS other
        WHERE other.tenant_id = ${tenantId} AND other.standing = 'owner' AND other.status = 'active'
          AND other.id != ${membershipId}) > 0
  )`;

const changed = (result: { meta?: { changes?: number } }) => (result.meta?.changes ?? 0) > 0;

router.post(
  "/",
  requireTenantManageOrAdmin(),
  zValidator("json", CreateMembershipRequest, (result, c) => {
    if (!result.success) return c.json({ error: "invalid_request" }, 400);
  }),
  async (c) => {
    const tenantId = c.req.param("tenantId");
    const input = c.req.valid("json");
    const db = createDb(c.env.DB);

    const tenant = await db.select().from(tenants).where(eq(tenants.id, tenantId)).get();
    if (!tenant) return c.json({ error: "not_found" }, 404);

    const principal = await getPrincipal(c);
    if (!principal) return c.json({ error: "unauthenticated" }, 401);
    const rankDenied = await assertStandingRank(c, principal, tenantId, {
      newStanding: input.standing,
    });
    if (rankDenied) return rankDenied;

    // Server API, never a raw insert into `customer_users` (agent-notes / brief, and per WT-1's
    // ADR 0002/0009: sign-in never creates an identity, so this invite is the only way a tenant
    // member's customer identity comes to exist).
    const userId = await ensureCustomerByEmail(c.env, input.email, {
      correlationId: c.var.correlationId,
    });

    const before = await db
      .select()
      .from(tenantMemberships)
      .where(and(eq(tenantMemberships.tenantId, tenantId), eq(tenantMemberships.userId, userId)))
      .get();

    if (before?.status === "active") {
      return c.json(
        { error: "conflict", detail: "This person is already a member of this tenant." },
        409,
      );
    }

    const now = nowIso();
    const membershipId = before?.id ?? newId("membership");
    const values = {
      standing: input.standing,
      status: "active" as const,
      invitedBy: c.var.user.id,
    };

    const mutation = before
      ? db
          .update(tenantMemberships)
          .set(values)
          .where(eq(tenantMemberships.id, membershipId))
          .returning()
      : db
          .insert(tenantMemberships)
          .values({ id: membershipId, tenantId, userId, createdAt: now, ...values })
          .returning();
    const auditWrite = audit(db, {
      eventType: "USER_INVITED",
      entityType: "membership",
      entityId: membershipId,
      actor: { type: "user", id: c.var.user.id, tenantId },
      before: before ?? null,
      after: {
        id: membershipId,
        tenantId,
        userId,
        createdAt: before?.createdAt ?? now,
        ...values,
      },
      correlationId: c.var.correlationId,
      source: "api",
    });
    const userRow = db
      .select({ email: customerUsers.email, name: customerUsers.name })
      .from(customerUsers)
      .where(eq(customerUsers.id, userId));

    const [[row], , [invitedUser]] = await db.batch([mutation, auditWrite, userRow]);

    return c.json({ ...row, email: invitedUser?.email, name: invitedUser?.name }, 201);
  },
);

router.patch(
  "/:id",
  requireTenantManageOrAdmin(),
  zValidator("json", UpdateMembershipRequest, (result, c) => {
    if (!result.success) return c.json({ error: "invalid_request" }, 400);
  }),
  async (c) => {
    const tenantId = c.req.param("tenantId");
    const membershipId = c.req.param("id");
    const input = c.req.valid("json");
    const db = createDb(c.env.DB);

    const before = await db
      .select()
      .from(tenantMemberships)
      .where(and(eq(tenantMemberships.id, membershipId), eq(tenantMemberships.tenantId, tenantId)))
      .get();
    if (!before) return c.json({ error: "not_found" }, 404);

    const principal = await getPrincipal(c);
    if (!principal) return c.json({ error: "unauthenticated" }, 401);
    const rankDenied = await assertStandingRank(c, principal, tenantId, {
      currentStanding: before.standing,
      newStanding: input.standing,
    });
    if (rankDenied) return rankDenied;

    const result = await db
      .update(tenantMemberships)
      .set({ standing: input.standing })
      .where(
        and(
          eq(tenantMemberships.id, membershipId),
          keepsAnOwner(tenantId, membershipId, input.standing),
        ),
      )
      .run();
    if (!changed(result)) {
      return c.json(
        {
          error: "last_owner",
          detail: "Promote another member to owner before changing this one.",
        },
        409,
      );
    }

    const after = { ...before, standing: input.standing };
    await audit(db, {
      eventType: "USER_STANDING_CHANGED",
      entityType: "membership",
      entityId: membershipId,
      actor: { type: "user", id: c.var.user.id, tenantId },
      before,
      after,
      correlationId: c.var.correlationId,
      source: "api",
    });

    return c.json(after);
  },
);

router.delete("/:id", requireTenantManageOrAdmin(), async (c) => {
  const tenantId = c.req.param("tenantId");
  const membershipId = c.req.param("id");
  const db = createDb(c.env.DB);

  const before = await db
    .select()
    .from(tenantMemberships)
    .where(and(eq(tenantMemberships.id, membershipId), eq(tenantMemberships.tenantId, tenantId)))
    .get();
  if (!before) return c.json({ error: "not_found" }, 404);
  if (before.status === "revoked") return c.json(before);

  const principal = await getPrincipal(c);
  if (!principal) return c.json({ error: "unauthenticated" }, 401);
  const rankDenied = await assertStandingRank(c, principal, tenantId, {
    currentStanding: before.standing,
  });
  if (rankDenied) return rankDenied;

  const result = await db
    .update(tenantMemberships)
    .set({ status: "revoked" })
    .where(and(eq(tenantMemberships.id, membershipId), keepsAnOwner(tenantId, membershipId)))
    .run();
  if (!changed(result)) {
    return c.json(
      { error: "last_owner", detail: "Promote another member to owner before revoking this one." },
      409,
    );
  }

  const after = { ...before, status: "revoked" as const };
  await audit(db, {
    eventType: "USER_REMOVED",
    entityType: "membership",
    entityId: membershipId,
    actor: { type: "user", id: c.var.user.id, tenantId },
    before,
    after,
    correlationId: c.var.correlationId,
    source: "api",
  });

  return c.json(after);
});

export default router;
