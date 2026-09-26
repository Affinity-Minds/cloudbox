// Owner: WT-3. Per-IP fixed-window rate limit for the unauthenticated `POST /agent/enroll`.
// Tonight's version: one `settings` row per IP, read-then-write, good enough for a single Worker
// isolate under light load. It is NOT safe against a burst racing across isolates (agent-notes
// cloudflare-workers "SQLite unique indexes do not see NULLs" / conditional-update note applies
// the same way here) — the honest upgrade is a Durable Object per IP (or per enrollment token)
// serialising the check-then-increment, which FLEET_PRESENCE could host. Note only; not built
// tonight because the brief calls a settings-style counter acceptable for this slice.
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { settings } from "../db/schema";
import { nowIso } from "../ids";

const WINDOW_MS = 60_000;
const MAX_ATTEMPTS_PER_WINDOW = 10;

type Bucket = { windowStart: number; count: number };

function keyFor(ip: string): string {
  return `ratelimit.agent-enroll.${ip}`;
}

/** Returns true when the caller is still under the limit (and records the attempt). */
export async function checkEnrollRateLimit(db: Db, ip: string): Promise<boolean> {
  const key = keyFor(ip);
  const now = Date.now();

  const [existing] = await db.select().from(settings).where(eq(settings.key, key));
  const bucket: Bucket = existing ? JSON.parse(existing.valueJson) : { windowStart: 0, count: 0 };
  const windowStart = typeof bucket.windowStart === "number" ? bucket.windowStart : 0;

  const fresh = now - windowStart > WINDOW_MS;
  const nextBucket: Bucket = fresh
    ? { windowStart: now, count: 1 }
    : { windowStart, count: bucket.count + 1 };

  if (existing) {
    await db
      .update(settings)
      .set({ valueJson: JSON.stringify(nextBucket), updatedAt: nowIso() })
      .where(eq(settings.key, key));
  } else {
    await db
      .insert(settings)
      .values({ key, valueJson: JSON.stringify(nextBucket), updatedAt: nowIso() })
      .onConflictDoNothing();
  }

  return fresh || bucket.count < MAX_ATTEMPTS_PER_WINDOW;
}
