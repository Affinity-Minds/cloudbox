// Signatures: WT-0. Implementation: WT-1. Staff grants resolve staff_members → role_permissions and
// tenant standing resolves tenant_memberships for the `:tenantId` path param, both per request from
// D1 (one query each, cached for the request only). A super admin's powers are rows too: remove a
// `role_permissions` row and the super admin loses that permission on the next request.
import { and, eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { guard } from "../auth/middleware";
import { createDb } from "../db/client";
import { tenantMemberships } from "../db/schema";
import type { AppEnv } from "../env";

/** The permission catalogue seeded by migration 0003. Grants are rows in `role_permissions`. */
export const PERMISSIONS = [
  "tenant.view",
  "tenant.manage",
  "subscription.view",
  "subscription.manage",
  "device.view",
  "device.manage",
  "device.command",
  "device.break_glass",
  "license.issue",
  "license.renew",
  "license.revoke",
  "network.view",
  "network.manage",
  "backup.view",
  "backup.restore",
  "update.view",
  "update.release",
  "update.deploy",
  "audit.view",
  "staff.manage",
  "settings.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export type TenantStanding = "owner" | "admin" | "user";

const STANDING_RANK: Record<TenantStanding, number> = { user: 1, admin: 2, owner: 3 };

/** Staff permission gate: 401 without a session, 403 unless the user's staff role holds `key`. */
export function requirePermission(key: Permission): MiddlewareHandler<AppEnv> {
  return guard((principal) => principal.permissions.has(key));
}

const standings = new WeakMap<Request, Map<string, Promise<TenantStanding | null>>>();

/**
 * The signed-in user's active standing in `tenantId`, or null. One indexed query per tenant per
 * request. Callers pass the `:tenantId` path param, never a body field.
 */
export function getTenantStanding(
  c: Context<AppEnv>,
  tenantId: string,
): Promise<TenantStanding | null> {
  let perRequest = standings.get(c.req.raw);
  if (!perRequest) {
    perRequest = new Map();
    standings.set(c.req.raw, perRequest);
  }
  let standing = perRequest.get(tenantId);
  if (!standing) {
    const userId = c.var.user.id;
    standing = createDb(c.env.DB)
      .select({ standing: tenantMemberships.standing })
      .from(tenantMemberships)
      .where(
        and(
          eq(tenantMemberships.tenantId, tenantId),
          eq(tenantMemberships.userId, userId),
          eq(tenantMemberships.status, "active"),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]?.standing ?? null);
    perRequest.set(tenantId, standing);
  }
  return standing;
}

/** Tenant membership gate on `:tenantId`, at least `min` standing (owner > admin > user). */
export function requireTenantStanding(min: TenantStanding): MiddlewareHandler<AppEnv> {
  return guard(async (_principal, c) => {
    const tenantId = c.req.param("tenantId");
    if (!tenantId) return false;
    const standing = await getTenantStanding(c, tenantId);
    return standing !== null && STANDING_RANK[standing] >= STANDING_RANK[min];
  });
}
