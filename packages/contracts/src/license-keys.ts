// Owner: WT-14. Server licence keys: staff generate them in batches for resellers (PC stores); a
// buyer redeems one at onboarding (`POST /api/v1/onboarding/redeem`). Only the SHA-256 of a key is
// stored; the plaintext exists once, in the generation response.
import { z } from "zod";

export const LicenseKeyStatus = z.enum(["unredeemed", "redeemed", "revoked"]);
export type LicenseKeyStatus = z.infer<typeof LicenseKeyStatus>;

export const LICENSE_KEY_BATCH_MAX = 500;

/** `POST /api/v1/license-keys/batches` (`license.issue`). `Accept: text/csv` returns CSV. */
export const GenerateLicenseKeysRequest = z.object({
  planCode: z.string().min(1).max(64),
  quantity: z.number().int().min(1).max(LICENSE_KEY_BATCH_MAX),
  batchLabel: z.string().trim().min(1).max(120),
  expiresAt: z.iso.datetime().optional(),
});
export type GenerateLicenseKeysRequest = z.infer<typeof GenerateLicenseKeysRequest>;

export const GeneratedLicenseKey = z.object({
  id: z.string(),
  /** Plaintext `CBX-LIC-XXXXX-XXXXX-XXXXX-XXXXX`: returned here only, never again. */
  code: z.string(),
  last4: z.string(),
});

export const GenerateLicenseKeysResponse = z.object({
  batchId: z.string(),
  batchLabel: z.string(),
  planCode: z.string(),
  expiresAt: z.string().nullable(),
  count: z.number().int(),
  keys: z.array(GeneratedLicenseKey),
});
export type GenerateLicenseKeysResponse = z.infer<typeof GenerateLicenseKeysResponse>;

/** `GET /api/v1/license-keys?batch=&status=&last4=` (`license.issue`). Never the code or hash. */
export const LicenseKeysQuery = z.object({
  batch: z.string().max(64).optional(),
  status: LicenseKeyStatus.optional(),
  last4: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[0-9A-Z]{4}$/)
    .optional(),
});
export type LicenseKeysQuery = z.infer<typeof LicenseKeysQuery>;

export const LicenseKeyListItem = z.object({
  id: z.string(),
  batchId: z.string(),
  batchLabel: z.string(),
  codeLast4: z.string(),
  planCode: z.string(),
  status: LicenseKeyStatus,
  /** `unredeemed` past `expiresAt` is shown as expired (derived, never stored). */
  expired: z.boolean(),
  createdBy: z.string(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  redeemedAt: z.string().nullable(),
  redeemedTenantId: z.string().nullable(),
  redeemedTenantCode: z.string().nullable(),
  redeemedByEmail: z.string().nullable(),
  revokedAt: z.string().nullable(),
  revokeReason: z.string().nullable(),
});
export type LicenseKeyListItem = z.infer<typeof LicenseKeyListItem>;

export const LicenseKeyBatch = z.object({
  batchId: z.string(),
  batchLabel: z.string(),
  planCode: z.string(),
  createdAt: z.string(),
  createdBy: z.string(),
  expiresAt: z.string().nullable(),
  total: z.number().int(),
  unredeemed: z.number().int(),
  redeemed: z.number().int(),
  revoked: z.number().int(),
  /**
   * The plan's price at read time, for display only (migration 0011, owner addition) — a batch
   * does not store its own price, and this is not what a redeemed subscription is billed; it is
   * just the plan's current price, shown so staff can see what a batch is "worth" at a glance.
   */
  planPriceAmount: z.number().int(),
  planCurrency: z.string(),
});
export type LicenseKeyBatch = z.infer<typeof LicenseKeyBatch>;

export const LicenseKeysResponse = z.object({
  batches: z.array(LicenseKeyBatch),
  items: z.array(LicenseKeyListItem),
});
export type LicenseKeysResponse = z.infer<typeof LicenseKeysResponse>;

// `POST /api/v1/license-keys/:id/revoke` (`license.revoke`) request: `RevokeLicenseKeyRequest` in
// `./reasons.ts` (reason-code + free-text, audited alongside `LicenseKeyRevokeReasonCode`).
