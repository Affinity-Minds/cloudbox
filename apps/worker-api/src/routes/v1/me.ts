// Owner: WT-2. Module `me`, mounted at `/api/v1/me` in routes/v1/index.ts.
// Routes (docs/handoffs/foundation.md): GET /tenants, POST /active-tenant.
//
// The active tenant is never trusted from the client on later requests: it is stored here as a
// `settings`-style per-user row (`active_tenant:<userId>`) and every consumer must re-resolve the
// caller's live membership itself rather than trust a client-supplied tenant id.
import { SetActiveTenantRequest } from "@cloudbox/contracts";
import { zValidator } from "@hono/zod-validator";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { requireUser } from "../../auth/middleware";
import { createDb, type Db } from "../../db/client";
import { tenantMemberships, tenants } from "../../db/schema";
import type { AppEnv } from "../../env";
import { nowIso } from "../../ids";

const activeTenantKey = (userId: string) => `active_tenant:${userId}`;

/**
 * The signed-in user's active tenant, or null. Re-validates the stored id against a live active
 * membership on every read (never trust the settings row alone: the membership may have since
 * been revoked). Used by `GET /api/v1/auth/session` (WT-1) to fill `activeTenantId`.
 */
export async function getActiveTenantId(db: Db, userId: string): Promise<string | null> {
  const row = await db.get<{ tenantId: string | null }>(sql`
    select json_extract(value_json, '$.tenantId') as tenantId from settings where key = ${activeTenantKey(userId)}
  `);
  if (!row?.tenantId) return null;

  const membership = await db
    .select({ id: tenantMemberships.id })
    .from(tenantMemberships)
    .where(
      and(
        eq(tenantMemberships.tenantId, row.tenantId),
        eq(tenantMemberships.userId, userId),
        eq(tenantMemberships.status, "active"),
      ),
    )
    .get();
  return membership ? row.tenantId : null;
}

const router = new Hono<AppEnv>();

router.get("/tenants", requireUser(), async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db
    .select({
      tenantId: tenants.id,
      publicCode: tenants.publicCode,
      displayName: tenants.displayName,
      standing: tenantMemberships.standing,
    })
    .from(tenantMemberships)
    .innerJoin(tenants, eq(tenantMemberships.tenantId, tenants.id))
    .where(and(eq(tenantMemberships.userId, c.var.user.id), eq(tenantMemberships.status, "active")));

  return c.json(rows);
});

router.post(
  "/active-tenant",
  requireUser(),
  zValidator("json", SetActiveTenantRequest, (result, c) => {
    if (!result.success) return c.json({ error: "invalid_request" }, 400);
  }),
  async (c) => {
    const { tenantId } = c.req.valid("json");
    const db = createDb(c.env.DB);

    // Re-resolve membership server-side; a client-supplied tenant id is never trusted alone.
    const membership = await db
      .select({ standing: tenantMemberships.standing })
      .from(tenantMemberships)
      .where(
        and(
          eq(tenantMemberships.tenantId, tenantId),
          eq(tenantMemberships.userId, c.var.user.id),
          eq(tenantMemberships.status, "active"),
        ),
      )
      .get();
    if (!membership) return c.json({ error: "forbidden" }, 403);

    const now = nowIso();
    await db.run(sql`
      insert into settings (key, value_json, updated_at)
      values (${activeTenantKey(c.var.user.id)}, json_object('tenantId', ${tenantId}), ${now})
      on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at
    `);

    return c.json({ tenantId, standing: membership.standing });
  },
);

export default router;
