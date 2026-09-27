import { z } from "zod";
import { Feature, Plan, SubscriptionListItem } from "./subscriptions";

/** JOSE parameters (ADR 0004): JWS ES256 nested in JWE RSA-OAEP-256 / A256GCM, `cty: "JWT"`. */
export const ENTITLEMENT_JOSE = {
  issuer: "cloudbox",
  typ: "cbx-entitlement+jwt",
  signingAlg: "ES256",
  keyManagementAlg: "RSA-OAEP-256",
  contentEncryption: "A256GCM",
  cty: "JWT",
} as const;

/**
 * Signed claims inside the entitlement (master spec §9.3 + `iss`, `kid`, `jti`, `iat`). `kid` also
 * travels in the JWS and JWE protected headers and must match; `jti` equals `license_id`; `iat` is in
 * seconds. Snake_case because the Windows agent reads it verbatim. The TypeScript type the signer
 * accepts is `@cloudbox/licensing-contracts` `EntitlementClaims`; keep both in step.
 */
export const EntitlementClaims = z.object({
  iss: z.literal(ENTITLEMENT_JOSE.issuer),
  kid: z.string().min(1),
  jti: z.string().startsWith("lic_"),
  iat: z.number().int().min(0),
  license_id: z.string().startsWith("lic_"),
  tenant_id: z.string().startsWith("ten_"),
  device_id: z.string().startsWith("dev_"),
  device_key_thumbprint: z.string().min(1),
  max_managed_users: z.number().int().min(0),
  valid_from: z.iso.datetime(),
  valid_until: z.iso.datetime(),
  renewal_warning_days: z.number().int().min(0),
  offline_grace_days: z.number().int().min(0),
  generation: z.number().int().min(1),
  features: z.array(Feature),
});
export type EntitlementClaims = z.infer<typeof EntitlementClaims>;

/** Admin view of an issued entitlement. The compact token itself is never returned to the UI. */
export const EntitlementRecord = z.object({
  id: z.string(),
  subscriptionId: z.string(),
  deviceId: z.string(),
  generation: z.number().int(),
  issuedBy: z.string(),
  issuedAt: z.string(),
  validUntil: z.string(),
  revokedAt: z.string().nullable(),
});
export type EntitlementRecord = z.infer<typeof EntitlementRecord>;

/** Detail-screen row: an entitlement with the device it was issued to. */
export const EntitlementHistoryItem = EntitlementRecord.extend({
  deviceName: z.string(),
  validFrom: z.string(),
});
export type EntitlementHistoryItem = z.infer<typeof EntitlementHistoryItem>;

/** `POST /api/v1/devices/:deviceId/entitlements/issue|renew`. `validUntil` is capped at the subscription's. */
export const IssueEntitlementRequest = z.object({
  validUntil: z.iso.datetime().optional(),
});
export type IssueEntitlementRequest = z.infer<typeof IssueEntitlementRequest>;

// `POST /api/v1/devices/:deviceId/entitlements/revoke` request: `RevokeEntitlementRequest` in
// `./reasons.ts` (reason-code + free-text, audited alongside `EntitlementRevokeReasonCode`).

/** Issue/renew response. Carries the signed claims (not secret) and never the token. */
export const IssueEntitlementResponse = z.object({
  entitlement: EntitlementRecord,
  claims: EntitlementClaims,
});
export type IssueEntitlementResponse = z.infer<typeof IssueEntitlementResponse>;

export const RevokeEntitlementResponse = z.object({
  deviceId: z.string(),
  revokedGenerations: z.array(z.number().int()),
  revokedAt: z.string(),
});
export type RevokeEntitlementResponse = z.infer<typeof RevokeEntitlementResponse>;

/** `GET /api/v1/screens/subscriptions/:id`: one subscription, its tenant's devices, entitlement history. */
export const SubscriptionDetailScreen = z.object({
  serverTime: z.string(),
  subscription: SubscriptionListItem,
  plan: Plan,
  /** Newest first. Never includes the token. */
  entitlements: z.array(EntitlementHistoryItem),
  /** Whether `ENTITLEMENT_SIGNING_JWK` is configured on this deployment (issuance needs it). */
  signingKeyConfigured: z.boolean(),
});
export type SubscriptionDetailScreen = z.infer<typeof SubscriptionDetailScreen>;
