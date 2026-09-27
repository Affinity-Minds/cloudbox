import { z } from "zod";
import { AuditEntry } from "./common";
import { TenantPlan } from "./onboarding";

export const DeviceStatus = z.enum(["enrolled", "revoked", "transferred"]);
export type DeviceStatus = z.infer<typeof DeviceStatus>;

export const KeyProtection = z.enum(["tpm", "software"]);
export type KeyProtection = z.infer<typeof KeyProtection>;

/** RSA public key as sent by the Windows agent (TPM-backed where available). */
export const RsaPublicJwk = z.object({
  kty: z.literal("RSA"),
  n: z.string().min(1),
  e: z.string().min(1),
});
export type RsaPublicJwk = z.infer<typeof RsaPublicJwk>;

export const Device = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string(),
  status: DeviceStatus,
  deviceKeyThumbprint: z.string(),
  keyProtection: KeyProtection,
  hostname: z.string(),
  windowsBuild: z.string().nullable(),
  agentVersion: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  lastHealth: z.unknown().nullable(),
  enrolledAt: z.string(),
  revokedAt: z.string().nullable(),
});
export type Device = z.infer<typeof Device>;

/** Derived from `entitlements`: no row, a non-expired row, or the newest row past `valid_until`. */
export const LicenseState = z.enum(["none", "active", "expired"]);
export type LicenseState = z.infer<typeof LicenseState>;

/** Row on `GET /api/v1/screens/fleet`. Added by WT-3 beyond the foundation's original pick:
 * `windowsBuild` (already a `Device` column) and `licenseState` (derived, not stored) — both
 * additive-only and never consumed by the Agent API, so the Windows agent (WT-4) is unaffected. */
export const FleetListItem = Device.pick({
  id: true,
  tenantId: true,
  name: true,
  status: true,
  hostname: true,
  windowsBuild: true,
  agentVersion: true,
  keyProtection: true,
  lastSeenAt: true,
  enrolledAt: true,
}).extend({
  tenantCode: z.string(),
  tenantName: z.string(),
  online: z.boolean(),
  licenseState: LicenseState,
});
export type FleetListItem = z.infer<typeof FleetListItem>;

export const FleetFacets = z.object({
  total: z.number().int(),
  online: z.number().int(),
  offline: z.number().int(),
  degradedKey: z.number().int(),
});
export type FleetFacets = z.infer<typeof FleetFacets>;

/** Minimal tenant picker, embedded until WT-2 ships `GET /api/v1/tenants` (WT-5's subscriptions
 * screen does the same for the same reason). Scoped to the caller: every tenant for staff, only
 * their own for a tenant-standing caller — the Enrollment page's tenant picker reuses this list. */
export const FleetTenantOption = z.object({
  id: z.string(),
  publicCode: z.string(),
  displayName: z.string(),
});
export type FleetTenantOption = z.infer<typeof FleetTenantOption>;

/** `GET /api/v1/screens/fleet?tenant=&online=&q=`. */
export const FleetScreen = z.object({
  items: z.array(FleetListItem),
  facets: FleetFacets,
  tenants: z.array(FleetTenantOption),
});
export type FleetScreen = z.infer<typeof FleetScreen>;

/** `GET /api/v1/screens/fleet/:deviceId` — overview + license + health tabs come off this row;
 * the audit tab is a separate array of the same shape the audit screen uses. */
/** Licence hold placed by a staff licence revoke; cleared only by a staff Issue or Renew. */
export const LicenseHold = z.object({
  reason: z.string(),
  at: z.string().nullable(),
  by: z.string().nullable(),
});
export type LicenseHold = z.infer<typeof LicenseHold>;

export const FleetDeviceDetail = Device.extend({
  tenantCode: z.string(),
  tenantName: z.string(),
  licenseState: LicenseState,
  /** Null when the device is not on hold. */
  licenseHold: LicenseHold.nullable().optional(),
});
export type FleetDeviceDetail = z.infer<typeof FleetDeviceDetail>;

export const FleetEntitlementRow = z.object({
  id: z.string(),
  subscriptionId: z.string(),
  generation: z.number().int(),
  issuedAt: z.string(),
  validUntil: z.string(),
  revokedAt: z.string().nullable(),
});
export type FleetEntitlementRow = z.infer<typeof FleetEntitlementRow>;

export const FleetDetailScreen = z.object({
  device: FleetDeviceDetail,
  entitlements: z.array(FleetEntitlementRow),
  audit: z.array(AuditEntry),
  /** WT-14: the tenant's plan state (`no_active_plan` carries `NO_ACTIVE_PLAN_MESSAGE`). */
  plan: TenantPlan.optional(),
});
export type FleetDetailScreen = z.infer<typeof FleetDetailScreen>;
