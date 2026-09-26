// Owner: WT-3. Device display names: `CLOUDBOX-00017`, a global sequence stored the same way
// tenants' `public_code` counter is (settings row `tenants.next_code` — docs/handoffs/foundation.md).
// The increment is a single conditional `UPDATE … RETURNING`, so two concurrent enrolls each get a
// distinct number: SQLite serialises writes to one row (agent-notes cloudflare-workers "conditional
// update"). Not part of the atomic enroll batch — worst case on a race is a skipped number, which is
// cosmetic only.
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { settings } from "../db/schema";
import { nowIso } from "../ids";

const DEVICE_SEQ_KEY = "devices.next_seq";

export async function nextDeviceName(db: Db): Promise<string> {
  const now = nowIso();

  await db
    .insert(settings)
    .values({ key: DEVICE_SEQ_KEY, valueJson: "1", updatedAt: now })
    .onConflictDoNothing();

  const [row] = await db
    .update(settings)
    .set({
      valueJson: sql`CAST(CAST(${settings.valueJson} AS INTEGER) + 1 AS TEXT)`,
      updatedAt: now,
    })
    .where(eq(settings.key, DEVICE_SEQ_KEY))
    .returning({ valueJson: settings.valueJson });

  const seq = row ? Number.parseInt(row.valueJson, 10) - 1 : 1;
  return `CLOUDBOX-${String(Math.max(seq, 1)).padStart(5, "0")}`;
}
