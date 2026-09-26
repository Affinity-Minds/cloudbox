// Signatures: WT-0. Implementation: WT-1 (resolve staff_members → role_permissions per request,
// and tenant_memberships for the `:tenantId` path param). Until then every guarded route answers
// 501 so nothing is accidentally left open.
import type { MiddlewareHandler } from "hono";
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

/** Staff permission gate. Responds 401/403 once WT-1 implements it. */
export function requirePermission(key: Permission): MiddlewareHandler<AppEnv> {
  return async (c) =>
    c.json({ error: "not_implemented", detail: `requirePermission(${key}): WT-1` }, 501);
}

/** Tenant membership gate on `:tenantId`, at least `min` standing (owner > admin > user). */
export function requireTenantStanding(min: TenantStanding): MiddlewareHandler<AppEnv> {
  return async (c) =>
    c.json({ error: "not_implemented", detail: `requireTenantStanding(${min}): WT-1` }, 501);
}
