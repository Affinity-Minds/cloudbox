// Owner: WT-14. CloudBox Connect sign-in contract, cloud side (the Windows client is WT-11).
// Connect signs a tenant member in with Tenant ID + email + emailed code (ADR 0009/0011), on the
// customer identity system (`/api/auth/*`, cookie `cbx_session`, or the `token` as a Bearer-less
// session cookie value held by the client).
//
//   1. POST /api/auth/connect/send-code {tenantCode, email} → 200 {success: true}, always the same
//      answer (unknown tenant, unknown email, not an active member: nothing is sent).
//   2. POST /api/auth/connect/verify {tenantCode, email, code} → 200 {token, user, tenantId,
//      tenantCode} + `cbx_session` cookie; the session's active tenant is that tenant. Anything
//      wrong (code, tenant, membership) → 400 {code: "INVALID_OTP", message: "Invalid OTP"},
//      identical to a wrong code at /login.
//   3. GET /api/v1/connect/devices (same session) → ConnectDevicesResponse.
//
// Both auth writes need a same-origin `Origin` header (login-CSRF rule, as /login); the desktop
// client sends `Origin: https://box.affinity.ai.in`.
import { z } from "zod";
import { Email } from "./auth";
import { LicenseState } from "./devices";
import { TenantPlan } from "./onboarding";

/** Tenant ID as the user types it; normalised (trimmed, upper-cased) server-side. */
export const ConnectTenantCode = z.string().trim().toUpperCase().min(1).max(32);

export const ConnectSendCodeRequest = z.object({ tenantCode: ConnectTenantCode, email: Email });
export type ConnectSendCodeRequest = z.infer<typeof ConnectSendCodeRequest>;

export const ConnectSendCodeResponse = z.object({ success: z.literal(true) });
export type ConnectSendCodeResponse = z.infer<typeof ConnectSendCodeResponse>;

export const ConnectVerifyRequest = z.object({
  tenantCode: ConnectTenantCode,
  email: Email,
  code: z.string().regex(/^\d{6}$/),
});
export type ConnectVerifyRequest = z.infer<typeof ConnectVerifyRequest>;

export const ConnectVerifyResponse = z.object({
  /** Better Auth session token (the value of the `cbx_session` cookie). */
  token: z.string(),
  user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
  tenantId: z.string(),
  tenantCode: z.string(),
});
export type ConnectVerifyResponse = z.infer<typeof ConnectVerifyResponse>;

/** The same failure body Better Auth gives a wrong code at `/login`. */
export const CONNECT_INVALID = { code: "INVALID_OTP", message: "Invalid OTP" } as const;

export const ConnectDevice = z.object({
  deviceId: z.string(),
  name: z.string(),
  hostname: z.string(),
  online: z.boolean(),
  lastSeenAt: z.string().nullable(),
  /** The device's own lease: `none`, `active` or `expired`. */
  licenseState: LicenseState,
});
export type ConnectDevice = z.infer<typeof ConnectDevice>;

/** `GET /api/v1/connect/devices?tenantId=` (defaults to the session's active tenant). */
export const ConnectDevicesResponse = z.object({
  tenantId: z.string(),
  tenantCode: z.string(),
  tenantName: z.string(),
  plan: TenantPlan,
  devices: z.array(ConnectDevice),
});
export type ConnectDevicesResponse = z.infer<typeof ConnectDevicesResponse>;
