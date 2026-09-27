import { z } from "zod";

/** ISO-8601 UTC timestamp text, e.g. `2026-09-26T18:00:00.000Z`. */
export const IsoTimestamp = z.iso.datetime();
export type IsoTimestamp = z.infer<typeof IsoTimestamp>;

/** Prefixes for every server-generated id. The suffix is a UUID. */
export const ID_PREFIX = {
  tenant: "ten_",
  device: "dev_",
  subscription: "sub_",
  license: "lic_",
  enrollmentToken: "tok_",
  membership: "mem_",
  deviceCredential: "cred_",
  emailProvider: "eprv_",
  licenseKey: "lkey_",
  licenseKeyBatch: "lkb_",
  networkPeer: "npeer_",
  /** WT-11, ADR 0013: `rdp_session_grants` rows. */
  rdpSessionGrant: "rdpg_",
  // WT-19 (migration 0017): backups.
  backupJob: "bkj_",
  backupArtifact: "bka_",
  restoreTest: "rst_",
  /** WT-17. */
  alert: "alrt_",
} as const;
export type IdKind = keyof typeof ID_PREFIX;

export const prefixedId = (kind: IdKind) =>
  z
    .string()
    .startsWith(ID_PREFIX[kind])
    .min(ID_PREFIX[kind].length + 1);

export const ErrorCode = z.union([
  z.enum(["unauthenticated", "forbidden", "not_found", "invalid_request", "conflict"]),
  z.string().regex(/^[a-z][a-z0-9_]*$/),
]);

/** Every non-2xx JSON body from `/api/v1/*`. */
export const ErrorBody = z.object({
  error: ErrorCode,
  detail: z.unknown().optional(),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

/** Keyset pagination: `cursor` is opaque; `nextCursor` is null on the last page. */
export const PageQuery = z.object({
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type PageQuery = z.infer<typeof PageQuery>;

/**
 * One audit_log row. Lives here (not screens.ts, its main consumer) so it stays a leaf: devices.ts
 * needs it too, and devices.ts <-> screens.ts would otherwise be a real import cycle — in Vite's
 * native-ESM dev server (unlike bundled builds or CJS-interop test runners) that throws
 * `ReferenceError: Cannot access 'Device' before initialization` the moment the barrel loads,
 * before any page can render. Found capturing WT-13 evidence; unrelated to that slice otherwise.
 */
export const AuditEntry = z.object({
  id: z.string(),
  eventType: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  actorType: z.string(),
  actorId: z.string(),
  actorTenantId: z.string().nullable(),
  action: z.string(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  correlationId: z.string().nullable(),
  source: z.string().nullable(),
  createdAt: z.string(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;
