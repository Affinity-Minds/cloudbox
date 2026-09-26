import { z } from "zod";
import { Device } from "./devices";
import { Membership } from "./memberships";
import { Subscription } from "./subscriptions";
import { Tenant } from "./tenants";

/** `GET /api/v1/screens/overview`: real counts only, zero when empty. */
export const OverviewScreen = z.object({
  tenants: z.object({ total: z.number().int(), active: z.number().int() }),
  devices: z.object({ total: z.number().int(), enrolled: z.number().int() }),
  subscriptions: z.object({ total: z.number().int(), active: z.number().int() }),
  audit: z.object({ total: z.number().int(), lastEventAt: z.string().nullable() }),
});
export type OverviewScreen = z.infer<typeof OverviewScreen>;

export const AuditEntry = z.object({
  id: z.string(),
  eventType: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  actorType: z.string(),
  actorId: z.string(),
  actorTenantId: z.string().nullable(),
  action: z.string(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  correlationId: z.string().nullable(),
  source: z.string().nullable(),
  createdAt: z.string(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

/** `GET /api/v1/screens/audit?cursor&limit`: newest first, keyset-paginated. */
export const AuditScreen = z.object({
  items: z.array(AuditEntry),
  nextCursor: z.string().nullable(),
});
export type AuditScreen = z.infer<typeof AuditScreen>;

/** `GET /api/v1/screens/tenants/:tenantId`: everything the detail page's first paint needs. */
export const TenantDetailScreen = z.object({
  tenant: Tenant,
  memberships: z.array(Membership),
  devices: z.array(Device),
  subscriptions: z.array(Subscription),
  /** Last 20 audit events for this entity, newest first. */
  auditEvents: z.array(AuditEntry),
});
export type TenantDetailScreen = z.infer<typeof TenantDetailScreen>;
