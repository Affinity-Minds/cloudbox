// Owner: WT-12. Drizzle table for migration 0008. Lives here (not `db/schema.ts`, WT-0's file)
// the same way WT-1's `rateLimit` lived in `auth/rate-limit-table.ts` for migration 0004 — see
// that handoff's "Requests to WT-0": move this verbatim into `db/schema.ts` and regenerate the
// Drizzle meta snapshot (`drizzle.config.ts` only diffs `db/schema.ts` today).
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const isoNow = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const EMAIL_PROVIDER_KINDS = ["cloudflare_binding", "smtp", "log"] as const;

export const emailProviders = sqliteTable(
  "email_providers",
  {
    id: text("id").primaryKey().notNull(),
    name: text("name").notNull(),
    kind: text("kind", { enum: EMAIL_PROVIDER_KINDS }).notNull(),
    priority: integer("priority").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    fromAddress: text("from_address").notNull(),
    /** Non-secret fields only: `{host, port, secure, username}` for `smtp`, `{}` otherwise. */
    configJson: text("config_json").notNull().default("{}"),
    /** AES-256-GCM ciphertext/IV pair, base64. Null when the provider has no secret. */
    secretCiphertext: text("secret_ciphertext"),
    secretIv: text("secret_iv"),
    updatedBy: text("updated_by"),
    createdAt: text("created_at").notNull().default(isoNow),
    updatedAt: text("updated_at").notNull().default(isoNow),
  },
  (table) => [
    index("email_providers_enabled_priority_idx").on(table.enabled, table.priority),
    check(
      "email_providers_kind_check",
      sql`${table.kind} IN ('cloudflare_binding', 'smtp', 'log')`,
    ),
  ],
);
