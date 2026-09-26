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

  BETTER_AUTH_SECRET?: string;
  ENTITLEMENT_SIGNING_JWK?: string;
  PHASE0_ADMIN_KEY?: string;
};

/** Signed-in principal, set by `requireUser()` (WT-1). */
export type AppUser = {
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
