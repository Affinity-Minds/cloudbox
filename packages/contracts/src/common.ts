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
