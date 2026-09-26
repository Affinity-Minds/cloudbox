// Owner: WT-14. Self-service onboarding on the customer surface (ADR 0011): the start path that
// creates a customer identity, tenant self-creation, licence-key redemption, and device
// self-activation grants for the Windows Setup app (WT-10).
import { z } from "zod";
import { Email } from "./auth";
import { TenantPublicCode } from "./tenants";

const Code = z.string().regex(/^\d{6}$/);

/** IANA time zone, e.g. `Asia/Kolkata`. */
export const TimeZone = z.string().trim().min(1).max(64);

/**
 * `POST /api/auth/start/send-code`. Always needs a Turnstile token in `x-cloudbox-turnstile`.
 * Unlike `/login`, an address without a customer identity is sent a code. → 200 `{success: true}`.
 */
export const StartSendCodeRequest = z.object({ email: Email });
export type StartSendCodeRequest = z.infer<typeof StartSendCodeRequest>;

/**
 * `POST /api/auth/start/verify`. Always needs a fresh Turnstile token. A right code signs the
 * address in, creating its customer identity first when it has none (audited `CUSTOMER_SIGNUP`).
 * → 200 `{token, user}` + the `cbx_session` cookie; a wrong code → 400 `{code: "INVALID_OTP"}`.
 */
export const StartVerifyRequest = z.object({ email: Email, code: Code });
export type StartVerifyRequest = z.infer<typeof StartVerifyRequest>;

/** `GET /api/v1/onboarding/config` (public): what `/start` needs before anyone signs in. */
export const OnboardingConfig = z.object({ turnstileSiteKey: z.string().nullable() });
export type OnboardingConfig = z.infer<typeof OnboardingConfig>;

/** `POST /api/v1/onboarding/tenants` (customer session). One tenant per call. */
export const CreateOwnTenantRequest = z.object({
  displayName: z.string().trim().min(1).max(120),
  timezone: TimeZone,
});
export type CreateOwnTenantRequest = z.infer<typeof CreateOwnTenantRequest>;

/** → 201. The tenant code is the "Tenant ID" people type into CloudBox Connect and Setup. */
export const CreateOwnTenantResponse = z.object({
  tenantId: z.string(),
  tenantCode: TenantPublicCode,
});
export type CreateOwnTenantResponse = z.infer<typeof CreateOwnTenantResponse>;

/** Server licence key as printed on a reseller's card: `CBX-LIC-XXXXX-XXXXX-XXXXX-XXXXX`. */
export const LicenseKeyCode = z
  .string()
  .trim()
  .toUpperCase()
  .max(64)
  .transform((value) => value.replace(/\s+/g, ""));

/** `POST /api/v1/onboarding/redeem` (customer session): licence key → tenant + pending plan. */
export const RedeemLicenseKeyRequest = z.object({
  code: LicenseKeyCode,
  displayName: z.string().trim().min(1).max(120),
  timezone: TimeZone,
});
export type RedeemLicenseKeyRequest = z.infer<typeof RedeemLicenseKeyRequest>;

/**
 * `POST /api/v1/onboarding/activation-grants` (customer session, Owner/Admin of `tenantId`):
 * a one-time enrollment token for `CloudBox.Agent.exe install --enroll-token`, valid 15 minutes.
 */
export const ActivationGrantRequest = z.object({
  tenantId: z.string().min(1).max(64),
  deviceLabel: z.string().trim().min(1).max(80).optional(),
});
export type ActivationGrantRequest = z.infer<typeof ActivationGrantRequest>;

/** → 201. `grant` is shown once and is exactly the `token` of `POST /api/v1/agent/enroll`. */
export const ActivationGrantResponse = z.object({
  grant: z.string(),
  enrollmentTokenId: z.string(),
  tenantId: z.string(),
  tenantCode: TenantPublicCode,
  expiresAt: z.string(),
});
export type ActivationGrantResponse = z.infer<typeof ActivationGrantResponse>;

/**
 * A tenant's plan as its members see it: `no_active_plan` (nothing assigned, or only
 * cancelled/suspended/expired), `pending_activation` (assigned; starts when the first server
 * activates), `active`.
 */
export const TenantPlanState = z.enum(["no_active_plan", "pending_activation", "active"]);
export type TenantPlanState = z.infer<typeof TenantPlanState>;

export const TenantPlan = z.object({
  state: TenantPlanState,
  planCode: z.string().nullable(),
  planName: z.string().nullable(),
  maxDevices: z.number().int().nullable(),
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  /** `NO_ACTIVE_PLAN_MESSAGE` when `state` is `no_active_plan`, else null. */
  message: z.string().nullable(),
});
export type TenantPlan = z.infer<typeof TenantPlan>;

/** `GET /api/v1/onboarding/overview` (customer session): the portal's tenant cards. */
export const OnboardingTenant = z.object({
  tenantId: z.string(),
  tenantCode: TenantPublicCode,
  displayName: z.string(),
  tenantStatus: z.string(),
  standing: z.enum(["owner", "admin", "user"]),
  enrolledDevices: z.number().int(),
  plan: TenantPlan,
});
export type OnboardingTenant = z.infer<typeof OnboardingTenant>;

export const OnboardingOverview = z.object({
  email: z.string(),
  activeTenantId: z.string().nullable(),
  tenants: z.array(OnboardingTenant),
});
export type OnboardingOverview = z.infer<typeof OnboardingOverview>;
