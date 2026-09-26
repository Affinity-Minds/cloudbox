import { z } from "zod";

export const Feature = z.enum(["remote_access", "managed_backup", "fleet"]);
export type Feature = z.infer<typeof Feature>;

export const SubscriptionStatus = z.enum(["trial", "active", "past_due", "suspended", "cancelled"]);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatus>;

export const Plan = z.object({
  code: z.string(),
  name: z.string(),
  maxDevices: z.number().int(),
  maxManagedUsers: z.number().int(),
  features: z.array(Feature),
  offlineGraceDays: z.number().int(),
  renewalWarningDays: z.number().int(),
});
export type Plan = z.infer<typeof Plan>;

export const Subscription = z.object({
  id: z.string(),
  tenantId: z.string(),
  planCode: z.string(),
  status: SubscriptionStatus,
  validFrom: z.string(),
  validUntil: z.string(),
  maxManagedUsers: z.number().int(),
  features: z.array(Feature),
  offlineGraceDays: z.number().int(),
  renewalWarningDays: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Subscription = z.infer<typeof Subscription>;

/** `POST /api/v1/tenants/:tenantId/subscriptions`. Omitted limits default from the plan. */
export const CreateSubscriptionRequest = z.object({
  planCode: z.string().min(1).max(64),
  status: SubscriptionStatus.default("active"),
  validFrom: z.iso.datetime(),
  validUntil: z.iso.datetime(),
  maxManagedUsers: z.number().int().min(1).max(1000).optional(),
  features: z.array(Feature).optional(),
  offlineGraceDays: z.number().int().min(0).max(90).optional(),
  renewalWarningDays: z.number().int().min(1).max(365).optional(),
});
export type CreateSubscriptionRequest = z.infer<typeof CreateSubscriptionRequest>;

/** `PATCH /api/v1/subscriptions/:id`. */
export const UpdateSubscriptionRequest = CreateSubscriptionRequest.omit({
  planCode: true,
}).partial();
export type UpdateSubscriptionRequest = z.infer<typeof UpdateSubscriptionRequest>;
