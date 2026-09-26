import type { StaffRole } from "@cloudbox/contracts";

/** Every binding, var and secret the Worker sees. Secrets are optional until the deploy sets them. */
export type Bindings = {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  FLEET_PRESENCE: DurableObjectNamespace;
  ASSETS: Fetcher;
  EMAIL: SendEmail;

  BUILD_SHA?: string;
  BUILD_TIME?: string;
  ENVIRONMENT?: "development" | "production";
  EMAIL_FROM?: string;
  BOOTSTRAP_SUPER_ADMIN_EMAIL?: string;
  /** `"1"` only outside production: WT-1 echoes the OTP in the send response for local tests. */
  OTP_DEV_ECHO?: string;

  /** Better Auth secret of the staff identity system (/api/ops/auth). */
  STAFF_AUTH_SECRET?: string;
  /** Better Auth secret of the customer identity system (/api/auth). */
  CUSTOMER_AUTH_SECRET?: string;
  /** Turnstile widget for the customer sign-in step-up (review T-1). Public; a var. */
  TURNSTILE_SITE_KEY?: string;
  /** Turnstile siteverify secret. Without it the step-up falls back to a per-account cooldown. */
  TURNSTILE_SECRET_KEY?: string;
  /** Initial password of the bootstrap super admin (ADR 0009); seeded once, must be changed. */
  BOOTSTRAP_SUPER_ADMIN_PASSWORD?: string;
  ENTITLEMENT_SIGNING_JWK?: string;
  PHASE0_ADMIN_KEY?: string;
  /** 32 raw bytes, base64. AES-256-GCM key for `email_providers.secret_ciphertext` (WT-12). */
  PROVIDER_SECRETS_KEY?: string;
};

/** Signed-in principal, set by `requireUser()` (WT-1). */
export type AppUser = {
  /** Identity system (WT-1): staff (/api/ops/auth) or customer (/api/auth). */
  surface?: "staff" | "customer";
  id: string;
  email: string;
  name: string;
  staffRole: StaffRole | null;
};

/** Authenticated device, set by the agent Bearer middleware (WT-3). */
export type AppDevice = {
  id: string;
  tenantId: string;
};

export type Variables = {
  correlationId: string;
  user: AppUser;
  device: AppDevice;
};

export type AppEnv = { Bindings: Bindings; Variables: Variables };
