// Owner: WT-17. The staff distribution list for alert emails: `settings` key
// `alerts.staff_recipients` (same "one JSON row" pattern as `me.ts`'s `active_tenant:<userId>` and
// the tenant public-code counter), editable from Settings → "Alerts" (`settings.manage`).
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { settings } from "../db/schema";
import { nowIso } from "../ids";

export const STAFF_RECIPIENTS_KEY = "alerts.staff_recipients";

export async function getStaffRecipients(db: Db): Promise<string[]> {
  const [row] = await db
    .select({ valueJson: settings.valueJson })
    .from(settings)
    .where(eq(settings.key, STAFF_RECIPIENTS_KEY))
    .limit(1);
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.valueJson);
    return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === "string") : [];
  } catch {
    return [];
  }
}

export async function setStaffRecipients(db: Db, emails: string[]): Promise<void> {
  const now = nowIso();
  const valueJson = JSON.stringify(emails);
  await db.run(sql`
    insert into settings (key, value_json, updated_at)
    values (${STAFF_RECIPIENTS_KEY}, ${valueJson}, ${now})
    on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at
  `);
}
