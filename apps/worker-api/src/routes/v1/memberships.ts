// Owner: WT-2. Module `memberships`, mounted at `/api/v1/tenants/:tenantId/memberships` in
// routes/v1/index.ts. Routes (docs/handoffs/foundation.md): POST /, PATCH /:id, DELETE /:id.
//
// Tenant Owner/Admin manage their own tenant's memberships (`requireTenantStanding('admin')`);
// staff manage any tenant's via `tenant.manage`. Until WT-1 implements both middlewares they are
// 501 stubs, so `eitherAuthorized` below simply forwards the first denial — once real logic
// lands, either path granting access is enough (see docs/handoffs/wt-p1-tenants.md).
import { CreateMembershipRequest, UpdateMembershipRequest } from "@cloudbox/contracts";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createAuth } from "../../auth";
import { requirePermission, requireTenantStanding } from "../../authz/permissions";
import { audit } from "../../audit";
import { createDb } from "../../db/client";
import { tenantMemberships, tenants } from "../../db/schema";
import type { AppEnv } from "../../env";
import { newId, nowIso } from "../../ids";

const router = new Hono<AppEnv>();

/** Runs `mw` against `c` without letting it fall through to the real downstream handler. */
async function probe(mw: MiddlewareHandler<AppEnv>, c: Context<AppEnv>): Promise<Response | null> {
  let passed = false;
  const response = await mw(c, async () => {
    passed = true;
  });
  return passed ? null : response instanceof Response ? response : c.json({ error: "forbidden" }, 403);
}

/** Staff with `tenant.manage`, OR a member of this tenant standing at `admin` or above. */
function requireTenantManageOrAdmin(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const staffDenied = await probe(requirePermission("tenant.manage"), c);
    if (staffDenied === null) return next();
    const memberDenied = await probe(requireTenantStanding("admin"), c);
    if (memberDenied === null) return next();
    return staffDenied;
  };
}

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

    // Server API, never a raw insert into `user` (agent-notes / brief): resolve-or-create
    // through Better Auth's own internal adapter so hooks and id generation stay in one place.
    const ctx = await createAuth(c.env).$context;
    const existing = await ctx.internalAdapter.findUserByEmail(input.email);
    const authUser =
      existing?.user ??
      (await ctx.internalAdapter.createUser({
        email: input.email,
        name: input.email.split("@")[0] ?? input.email,
        emailVerified: false,
      }));

    const before = await db
      .select()
      .from(tenantMemberships)
      .where(and(eq(tenantMemberships.tenantId, tenantId), eq(tenantMemberships.userId, authUser.id)))
      .get();

    if (before?.status === "active") {
      return c.json({ error: "conflict", detail: "This person is already a member of this tenant." }, 409);
    }

    const now = nowIso();
    const membershipId = before?.id ?? newId("membership");
    const values = {
      standing: input.standing,
      status: "active" as const,
      invitedBy: c.var.user.id,
    };

    const [[row]] = await db.batch([
      before
        ? db
            .update(tenantMemberships)
            .set(values)
            .where(eq(tenantMemberships.id, membershipId))
            .returning()
        : db
            .insert(tenantMemberships)
            .values({ id: membershipId, tenantId, userId: authUser.id, createdAt: now, ...values })
            .returning(),
      audit(db, {
        eventType: "USER_INVITED",
        entityType: "membership",
        entityId: membershipId,
        actor: { type: "user", id: c.var.user.id, tenantId },
        before: before ?? null,
        after: { id: membershipId, tenantId, userId: authUser.id, createdAt: before?.createdAt ?? now, ...values },
        correlationId: c.var.correlationId,
        source: "api",
      }),
    ]);

    return c.json({ ...row, email: authUser.email, name: authUser.name }, 201);
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

    const [[updated]] = await db.batch([
      db
        .update(tenantMemberships)
        .set({ standing: input.standing })
        .where(eq(tenantMemberships.id, membershipId))
        .returning(),
      audit(db, {
        eventType: "USER_STANDING_CHANGED",
        entityType: "membership",
        entityId: membershipId,
        actor: { type: "user", id: c.var.user.id, tenantId },
        before,
        after: { ...before, standing: input.standing },
        correlationId: c.var.correlationId,
        source: "api",
      }),
    ]);

    return c.json(updated);
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

  const [[updated]] = await db.batch([
    db
      .update(tenantMemberships)
      .set({ status: "revoked" })
      .where(eq(tenantMemberships.id, membershipId))
      .returning(),
    audit(db, {
      eventType: "USER_REMOVED",
      entityType: "membership",
      entityId: membershipId,
      actor: { type: "user", id: c.var.user.id, tenantId },
      before,
      after: { ...before, status: "revoked" },
      correlationId: c.var.correlationId,
      source: "api",
    }),
  ]);

  return c.json(updated);
});

export default router;
