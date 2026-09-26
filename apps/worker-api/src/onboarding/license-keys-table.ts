// Owner: WT-14. Drizzle table for migration 0010's `license_keys`. Lives here, not in `db/schema.ts`
// (WT-0's file), the same way WT-12's `email_providers` does; see the WT-14 handoff "Requests to
// WT-0" (move it verbatim into `db/schema.ts` and regenerate the Drizzle snapshot).
import { sql } from "drizzle-orm";
import { check, index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const isoNow = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const LICENSE_KEY_STATUSES = ["unredeemed", "redeemed", "revoked"] as const;

export const licenseKeys = sqliteTable(
  "license_keys",
  {
    id: text("id").primaryKey(),
    /** Groups the keys of one generation call (a label may be reused across batches). */
    batchId: text("batch_id").notNull(),
    /** SHA-256 (hex) of the plaintext key. The plaintext exists only in the generation response. */
    codeHash: text("code_hash").notNull(),
    /** Last four symbols of the key, for support lookups. */
    codeLast4: text("code_last4").notNull(),
    planCode: text("plan_code").notNull(),
    batchLabel: text("batch_label").notNull(),
    status: text("status", { enum: LICENSE_KEY_STATUSES }).notNull().default("unredeemed"),
    /** Staff user id. */
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(isoNow),
    expiresAt: text("expires_at"),
    redeemedAt: text("redeemed_at"),
    redeemedTenantId: text("redeemed_tenant_id"),
    redeemedByEmail: text("redeemed_by_email"),
    revokedAt: text("revoked_at"),
    revokeReason: text("revoke_reason"),
  },
  (table) => [
    uniqueIndex("license_keys_code_hash_unique").on(table.codeHash),
    index("license_keys_batch_idx").on(table.batchId, table.createdAt),
    index("license_keys_status_idx").on(table.status, table.createdAt),
    index("license_keys_last4_idx").on(table.codeLast4),
    check(
      "license_keys_status_check",
      sql`${table.status} IN ('unredeemed', 'redeemed', 'revoked')`,
    ),
  ],
);
