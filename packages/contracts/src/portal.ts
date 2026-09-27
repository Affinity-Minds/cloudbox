// Owner: WT-15. The customer portal's own screens (`/api/v1/tenants/:tenantId/portal/*`), gated by
// `requireTenantStanding('user')` — any active member of the tenant may read them. Devices reuse
// `FleetScreen` (WT-3) directly rather than a parallel type; the rest are small, portal-specific
// projections that don't belong on the staff-only `TenantDetailScreen`.
import { z } from "zod";
import { MembershipStanding } from "./memberships";
import { TenantPlan } from "./onboarding";
import { SubscriptionExpiry, SubscriptionWithPricing } from "./subscriptions";
import { TenantPublicCode, TenantStatus } from "./tenants";

/** `GET /api/v1/tenants/:tenantId/portal`: the Home page's first paint. */
export const PortalHome = z.object({
  tenant: z.object({
    id: z.string(),
    publicCode: TenantPublicCode,
    displayName: z.string(),
    status: TenantStatus,
  }),
  /** The caller's own standing in this tenant (drives which actions the UI offers). */
  standing: MembershipStanding,
  plan: TenantPlan,
  counts: z.object({
    members: z.number().int(),
    devices: z.number().int(),
  }),
});
export type PortalHome = z.infer<typeof PortalHome>;

/** `GET /api/v1/tenants/:tenantId/portal/members`. */
export const PortalMember = z.object({
  id: z.string(),
  userId: z.string(),
  email: z.string(),
  name: z.string(),
  standing: MembershipStanding,
  status: z.enum(["active", "revoked"]),
  createdAt: z.string(),
});
export type PortalMember = z.infer<typeof PortalMember>;

export const PortalMembersScreen = z.object({
  items: z.array(PortalMember),
  /** The caller's own standing — which rows it may act on is a ranking rule enforced server-side. */
  standing: MembershipStanding,
});
export type PortalMembersScreen = z.infer<typeof PortalMembersScreen>;

/**
 * `GET /api/v1/tenants/:tenantId/portal/subscription`: the tenant's newest non-cancelled
 * subscription, read-only, with the plan-derived fields a member needs (validity, effective users,
 * price) — `null` when nothing has ever been assigned.
 */
export const PortalSubscription = SubscriptionWithPricing.extend({
  planName: z.string().nullable(),
  expiry: SubscriptionExpiry,
  daysRemaining: z.number().int(),
});
export type PortalSubscription = z.infer<typeof PortalSubscription>;

export const PortalSubscriptionScreen = z.object({
  subscription: PortalSubscription.nullable(),
});
export type PortalSubscriptionScreen = z.infer<typeof PortalSubscriptionScreen>;
