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
// client sends `Origin: https://box.affinityminds.in`.
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
  /**
   * WT-11 (additive): the device's LAN address from its latest health document
   * (`network.lan_address`), or null when the Agent hasn't reported one yet. Alpha demo only
   * (`LanDirect`); superseded by the private overlay address once WT-9 lands `NetBird`.
   */
  lanAddress: z.string().nullable().optional(),
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

// ─── RDP session credential broker (WT-11, ADR 0013) ────────────────────────────────────────────
//
// `POST /api/v1/connect/devices/:deviceId/session` mints a short-lived managed-user credential for
// CloudBox Connect to hand to Windows Credential Manager (`TERMSRV/<address>`) before launching
// `mstsc`, never on a command line or in a file. The caller must be an active member of the
// device's tenant (any standing). The cloud assigns the lowest managed slot (`cloudNN`) that has no
// live grant for this device, mints a random one-time password, stores only its hash (table
// `rdp_session_grants`, migration 0013) and queues `SET_MANAGED_USER_PASSWORD` for the Agent to
// apply on its next heartbeat (see `HeartbeatResponse.commands`, ADR 0013). The plaintext password
// is returned to the caller exactly once, here, and never again — Connect must write it to Windows
// Credential Manager immediately and never log or persist it.

/** Managed-user slots are numbered 1..`max_managed_users`; the wire name is `cloud01`, `cloud02`, … */
export const managedUserName = (slot: number): string => `cloud${String(slot).padStart(2, "0")}`;

export const RdpSessionRequest = z.object({});
export type RdpSessionRequest = z.infer<typeof RdpSessionRequest>;

export const RdpSessionResponse = z.object({
  deviceId: z.string(),
  /** e.g. `cloud03`. */
  user: z.string(),
  /** One-time password, plaintext, returned exactly once. */
  password: z.string(),
  /** ISO-8601; the Agent will have applied the password well before this (heartbeat cadence). */
  expiresAt: z.string(),
});
export type RdpSessionResponse = z.infer<typeof RdpSessionResponse>;

/** The exact shape queued in `HeartbeatResponse.commands` for this grant (documented for WT-10). */
export const SetManagedUserPasswordCommand = z.object({
  type: z.literal("SET_MANAGED_USER_PASSWORD"),
  user: z.string(),
  /** Compact JWE (`RSA-OAEP-256` / `A256GCM`, `cty: "json"`) of `{"password":"…"}`, encrypted to
   * the device's own enrolled RSA public key — the same key management scheme as the entitlement
   * envelope (`@cloudbox/licensing-contracts`), so the Agent decrypts it with the same device key. */
  passwordCiphertext: z.string(),
});
export type SetManagedUserPasswordCommand = z.infer<typeof SetManagedUserPasswordCommand>;
