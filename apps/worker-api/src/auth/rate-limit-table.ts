// Owner: WT-1. Better Auth's `rateLimit` model (rateLimit.storage = "database"), created by migration
// 0004. It lives here, not in db/schema.ts, only because that file is WT-0's; WT-0 may move it
// verbatim (requested in docs/handoffs/wt-p1-auth.md). Shape = `auth generate` output for 1.7.6.
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const rateLimit = sqliteTable("rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: integer("last_request").notNull(),
});
