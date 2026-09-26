import { z } from "zod";

export const Feature = z.enum(["remote_access", "managed_backup", "fleet"]);
export type Feature = z.infer<typeof Feature>;

/**
 * `pending` (WT-14, ADR 0011): a plan is assigned to the tenant but not yet redeemed. It has no
 * dates; the first server activation sets `validFrom = now`, `validUntil = now + plan term` and
 * makes it `active`.
 */
export const SubscriptionStatus = z.enum([
  "pending",
  "trial",
  "active",
  "past_due",
  "suspended",
  "cancelled",
]);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatus>;

/** Plan lifecycle (WT-13, migration 0009). A plan is never deleted, only retired. */
export const PlanStatus = z.enum(["active", "retired"]);
export type PlanStatus = z.infer<typeof PlanStatus>;

/** Immutable once created; a lowercase slug. */
export const PlanCode = z.string().regex(/^[a-z0-9-]{3,32}$/);

export const Plan = z.object({
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  maxDevices: z.number().int(),
  maxManagedUsers: z.number().int(),
  features: z.array(Feature),
  offlineGraceDays: z.number().int(),
  renewalWarningDays: z.number().int(),
  status: PlanStatus,
  /**
   * Days a redeemed subscription runs (owner addition, mid-slice). Redemption semantics — a
   * subscription is `pending` until the tenant's server is activated, at which point
   * `valid_from = now`, `valid_until = now + term_days`, and the device licence is issued — are
   * WT-14's, in a sibling worktree. This slice only carries the column and its UI.
   */
  termDays: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Plan = z.infer<typeof Plan>;

const PlanFields = {
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  maxDevices: z.number().int().min(1),
  maxManagedUsers: z.number().int().min(1),
  features: z.array(Feature),
  offlineGraceDays: z.number().int().min(0).max(90),
  renewalWarningDays: z.number().int().min(1).max(365),
  termDays: z.number().int().min(1).max(3650),
};

/** `POST /api/v1/plans`. `code` is immutable — never accepted again after create. */
export const CreatePlanRequest = z.object({
  code: PlanCode,
  ...PlanFields,
});
export type CreatePlanRequest = z.infer<typeof CreatePlanRequest>;

/** `PATCH /api/v1/plans/:code`. Every field but `code` and `status` (retire/reactivate own that). */
export const UpdatePlanRequest = z
  .object({
    name: PlanFields.name.optional(),
    description: PlanFields.description,
    maxDevices: PlanFields.maxDevices.optional(),
    maxManagedUsers: PlanFields.maxManagedUsers.optional(),
    features: PlanFields.features.optional(),
    offlineGraceDays: PlanFields.offlineGraceDays.optional(),
    renewalWarningDays: PlanFields.renewalWarningDays.optional(),
    termDays: PlanFields.termDays.optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: "at least one field",
  });
export type UpdatePlanRequest = z.infer<typeof UpdatePlanRequest>;

/** Row on `GET /api/v1/screens/plans`. */
export const PlanListItem = Plan.extend({
  /** Subscriptions (any status) currently on this plan. */
  subscriptionCount: z.number().int(),
});
export type PlanListItem = z.infer<typeof PlanListItem>;

/** `GET /api/v1/screens/plans`. */
export const PlansScreen = z.object({
  serverTime: z.string(),
  items: z.array(PlanListItem),
});
export type PlansScreen = z.infer<typeof PlansScreen>;

export const Subscription = z.object({
  id: z.string(),
  tenantId: z.string(),
  planCode: z.string(),
  status: SubscriptionStatus,
  /** Null while `pending` (set when the tenant's first server activates). */
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  maxManagedUsers: z.number().int(),
  features: z.array(Feature),
  offlineGraceDays: z.number().int(),
  renewalWarningDays: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Subscription = z.infer<typeof Subscription>;

const SubscriptionOverrides = {
  maxManagedUsers: z.number().int().min(1).max(1000).optional(),
  features: z.array(Feature).optional(),
  offlineGraceDays: z.number().int().min(0).max(90).optional(),
  renewalWarningDays: z.number().int().min(1).max(365).optional(),
};

/**
 * `POST /api/v1/tenants/:tenantId/subscriptions`. Omitted limits default from the plan.
 * Without dates the subscription is a plan assignment: `pending`, redeemed (dates set, `active`)
 * when the tenant's first server activates (ADR 0011). With both dates it is a staff override that
 * starts `trial` or `active` (default `active`) immediately; `validUntil` must be after `validFrom`.
 */
export const CreateSubscriptionRequest = z
  .object({
    planCode: z.string().min(1).max(64),
    status: z.enum(["pending", "trial", "active"]).optional(),
    validFrom: z.iso.datetime().optional(),
    validUntil: z.iso.datetime().optional(),
    ...SubscriptionOverrides,
  })
  .refine((body) => (body.validFrom === undefined) === (body.validUntil === undefined), {
    message: "validFrom and validUntil go together",
  })
  .refine(
    (body) =>
      body.validFrom === undefined
        ? body.status === undefined || body.status === "pending"
        : body.status !== "pending",
    { message: "a pending subscription has no dates; a dated one is trial or active" },
  );
export type CreateSubscriptionRequest = z.infer<typeof CreateSubscriptionRequest>;

/**
 * `PATCH /api/v1/subscriptions/:id`. Spelled out rather than `.partial()` of the create schema:
 * `partial()` keeps the `status` default, so an empty PATCH would silently re-activate.
 */
export const UpdateSubscriptionRequest = z
  .object({
    status: SubscriptionStatus.optional(),
    validFrom: z.iso.datetime().optional(),
    validUntil: z.iso.datetime().optional(),
    ...SubscriptionOverrides,
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: "at least one field",
  });
export type UpdateSubscriptionRequest = z.infer<typeof UpdateSubscriptionRequest>;

/**
 * Read-time lifecycle of a subscription against "now". Derived, never stored (the stored `status`
 * is the commercial state; this adds the calendar): `scheduled` before `validFrom`, `expired` after
 * `validUntil`, `expiring` within `renewalWarningDays`, `inactive` when the status is not
 * trial/active (past_due, suspended, cancelled), `pending` for an assigned plan not yet redeemed
 * (no dates), otherwise `active`.
 */
export const SubscriptionExpiry = z.enum([
  "pending",
  "active",
  "expiring",
  "expired",
  "scheduled",
  "inactive",
]);
export type SubscriptionExpiry = z.infer<typeof SubscriptionExpiry>;

const Derived = {
  expiry: SubscriptionExpiry,
  /** Whole days until `validUntil` (negative once expired). */
  daysRemaining: z.number().int(),
  /** Entitlements can be issued only when true (status trial/active and inside the dates). */
  issuable: z.boolean(),
};

/** Device on a subscription screen with its current (highest) entitlement generation. */
export const SubscriptionDevice = z.object({
  id: z.string(),
  name: z.string(),
  hostname: z.string(),
  status: z.enum(["enrolled", "revoked", "transferred"]),
  keyProtection: z.enum(["tpm", "software"]),
  lastSeenAt: z.string().nullable(),
  /** Highest generation issued to this device, or null when none. */
  currentGeneration: z.number().int().nullable(),
  currentValidUntil: z.string().nullable(),
  /** Whether the highest generation is revoked. */
  currentRevoked: z.boolean(),
});
export type SubscriptionDevice = z.infer<typeof SubscriptionDevice>;

/** Row on `GET /api/v1/screens/subscriptions`. */
export const SubscriptionListItem = Subscription.extend({
  tenantCode: z.string(),
  tenantName: z.string(),
  planName: z.string(),
  ...Derived,
  devices: z.array(SubscriptionDevice),
});
export type SubscriptionListItem = z.infer<typeof SubscriptionListItem>;

/** `GET /api/v1/screens/subscriptions`: every subscription plus the pickers for "New". */
export const SubscriptionsScreen = z.object({
  serverTime: z.string(),
  items: z.array(SubscriptionListItem),
  plans: z.array(Plan),
  tenants: z.array(z.object({ id: z.string(), publicCode: z.string(), displayName: z.string() })),
});
export type SubscriptionsScreen = z.infer<typeof SubscriptionsScreen>;
