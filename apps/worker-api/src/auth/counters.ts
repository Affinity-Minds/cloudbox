// Owner: WT-1. Short-lived security counters in each identity system's Better Auth rate-limit table
// (`staff_rate_limit` / `customer_rate_limit`, migration 0004; nothing shared):
// failed passwords and failed codes per (email, client), and used authenticator codes. They are
// uniform for every address (known, unknown, staff, customer), so a limit never becomes an
// existence oracle, and they write no audit rows. Keys are SHA-256 digests, so the table holds no
// email addresses or IPs. Every write is a single atomic statement.
//
// Better Auth prunes `rate_limit` rows idle longer than its longest configured window; authOptions
// registers COUNTER_HORIZON_SECONDS as a rule window so these rows outlive their own windows.
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";

export const COUNTER_HORIZON_SECONDS = 60 * 60;

/** Counters of the staff identity system; every other kind belongs to the customer system. */
const STAFF_KINDS = new Set(["pw-fail", "totp-used"]);

/**
 * The rate-limit table of the identity system a key belongs to (from its kind; a fixed name, never
 * user input), so a staff counter never lands in the customer system's table and vice versa.
 */
const t = (key: string) =>
  sql.raw(STAFF_KINDS.has(key.split(":")[1] ?? "") ? "staff_rate_limit" : "customer_rate_limit");

async function digest(parts: string[]): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(parts.join("\u0000")),
  );
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function counterKey(kind: string, ...parts: string[]): Promise<string> {
  return `cb:${kind}:${await digest(parts)}`;
}

/** Current count within a sliding window (the window restarts after `windowSeconds` idle). */
export async function readCounter(db: Db, key: string, windowSeconds: number): Promise<number> {
  const row = await db.get<{ count: number; last_request: number } | undefined>(
    sql`SELECT count, last_request FROM ${t(key)} WHERE key = ${key}`,
  );
  if (!row || row.last_request < Date.now() - windowSeconds * 1000) return 0;
  return row.count;
}

/** Adds one and returns the new count (a fresh window when the last hit is older than it). */
export async function bumpCounter(db: Db, key: string, windowSeconds: number): Promise<number> {
  const now = Date.now();
  const row = await db.get<{ count: number }>(sql`
    INSERT INTO ${t(key)} (id, key, count, last_request)
    VALUES (${crypto.randomUUID()}, ${key}, 1, ${now})
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN last_request < ${now - windowSeconds * 1000} THEN 1
                   ELSE count + 1 END,
      last_request = ${now}
    RETURNING count`);
  return row?.count ?? 1;
}

/**
 * Claims `key` for `windowSeconds`: true for the first claim, false while an earlier claim is
 * still live. One statement, so two concurrent claims cannot both win.
 */
export async function claimOnce(db: Db, key: string, windowSeconds: number): Promise<boolean> {
  const now = Date.now();
  const result = await db.run(sql`
    INSERT INTO ${t(key)} (id, key, count, last_request)
    VALUES (${crypto.randomUUID()}, ${key}, 1, ${now})
    ON CONFLICT (key) DO UPDATE SET count = 1, last_request = ${now}
    WHERE last_request < ${now - windowSeconds * 1000}`);
  return (result.meta?.changes ?? 0) > 0;
}
