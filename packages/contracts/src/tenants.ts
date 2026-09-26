import { z } from "zod";
import { Email } from "./auth";

export const TenantStatus = z.enum([
  "trial",
  "provisioning",
  "active",
  "past_due",
  "suspended",
  "cancelled",
  "archived",
]);
export type TenantStatus = z.infer<typeof TenantStatus>;

/** `CBX-00001`, allocated from `settings.key = 'tenants.next_code'`. */
export const TenantPublicCode = z.string().regex(/^CBX-\d{5,}$/);

export const Tenant = z.object({
  id: z.string(),
  publicCode: TenantPublicCode,
  displayName: z.string(),
  legalName: z.string().nullable(),
  status: TenantStatus,
  primaryContactEmail: z.string().nullable(),
  supportContactEmail: z.string().nullable(),
  billingContactEmail: z.string().nullable(),
  timezone: z.string(),
  maintenanceWindow: z.unknown().nullable(),
  renewalWarningDays: z.number().int(),
  backupPolicy: z.unknown().nullable(),
  planCode: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});
export type Tenant = z.infer<typeof Tenant>;

/** Row on `GET /api/v1/screens/tenants`. */
export const TenantListItem = Tenant.pick({
  id: true,
  publicCode: true,
  displayName: true,
  status: true,
  planCode: true,
  primaryContactEmail: true,
  createdAt: true,
}).extend({
  deviceCount: z.number().int(),
  memberCount: z.number().int(),
});
export type TenantListItem = z.infer<typeof TenantListItem>;

export const CreateTenantRequest = z.object({
  displayName: z.string().trim().min(1).max(120),
  legalName: z.string().trim().max(200).optional(),
  primaryContactEmail: Email.optional(),
  supportContactEmail: Email.optional(),
  billingContactEmail: Email.optional(),
  timezone: z.string().min(1).max(64).optional(),
  renewalWarningDays: z.number().int().min(1).max(365).optional(),
  planCode: z.string().max(64).optional(),
  notes: z.string().max(4000).optional(),
});
export type CreateTenantRequest = z.infer<typeof CreateTenantRequest>;

export const UpdateTenantRequest = CreateTenantRequest.partial().extend({
  status: TenantStatus.exclude(["archived"]).optional(),
});
export type UpdateTenantRequest = z.infer<typeof UpdateTenantRequest>;
