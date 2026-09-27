// Owner: WT-11. Table for the RDP credential broker (ADR 0013), kept out of `db/schema.ts`
// (`_COMMON.md`: that file is WT-0's; new tables land in their own file and get folded in later,
// same pattern the license-keys table used before WT-0 consolidated it — see
// `docs/handoffs/wt-p2-self-onboarding.md`). Requires only `devices`/`tenants` for the FKs, both
// already exported by `../db/schema`.
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { devices, tenants } from "../db/schema";

const isoNow = () => new Date().toISOString();

/**
 * One minted managed-user (`cloudNN`) credential grant for CloudBox Connect's RDP broker. The
 * plaintext password is returned to the caller exactly once (`POST
 * /connect/devices/:deviceId/session`) and never stored: `password_hash` (SHA-256) is kept only so
 * a grant can be identified/audited without the plaintext, and `password_ciphertext` is the compact
 * JWE of `{"password":"…"}` encrypted to the device's own enrolled RSA public key at grant time
 * (the same key management scheme as the entitlement envelope) — safe to store because only that
 * device's private key (CNG-protected, never leaves the machine) can open it. `delivered_at` marks
 * the grant as already queued into a heartbeat response so a slow-polling Agent isn't handed the
 * same command twice.
 */
export const rdpSessionGrants = sqliteTable(
  "rdp_session_grants",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    managedUser: text("managed_user").notNull(),
    slot: integer("slot").notNull(),
    passwordHash: text("password_hash").notNull(),
    passwordCiphertext: text("password_ciphertext").notNull(),
    grantedBy: text("granted_by").notNull(),
    createdAt: text("created_at").notNull().default(isoNow()),
    expiresAt: text("expires_at").notNull(),
    deliveredAt: text("delivered_at"),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    index("rdp_session_grants_device_idx").on(table.deviceId, table.expiresAt),
    index("rdp_session_grants_pending_idx").on(table.deviceId, table.deliveredAt),
  ],
);
