import { z } from "zod";
import { Feature } from "./subscriptions";

/** JOSE parameters (PLAN_5AM §7): JWS ES256 nested in JWE RSA-OAEP-256 / A256GCM. */
export const ENTITLEMENT_JOSE = {
  issuer: "cloudbox",
  typ: "cbx-entitlement+jwt",
  signingAlg: "ES256",
  keyManagementAlg: "RSA-OAEP-256",
  contentEncryption: "A256GCM",
} as const;

/**
 * Signed claims inside the entitlement (master spec §9.3 + `iss`). `kid` travels in the JWS
 * protected header, not in the claims. Snake_case because the Windows agent reads it verbatim.
 */
export const EntitlementClaims = z.object({
  iss: z.literal(ENTITLEMENT_JOSE.issuer),
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
