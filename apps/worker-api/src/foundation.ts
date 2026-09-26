// Phase 0 foundation loader and audited release change (kept for the deploy workflow's proof).
import { desc, eq, like } from "drizzle-orm";
import { z } from "zod";
import { audit } from "./audit";
import type { Db } from "./db/client";
import { auditLog, settings } from "./db/schema";
import { nowIso } from "./ids";

const foundationReleaseSchema = z.object({
  status: z.string().min(1).max(64),
  sha: z.string().min(1).max(128),
});

export type FoundationRelease = z.infer<typeof foundationReleaseSchema>;

const parseJson = (value: string | null) => (value ? JSON.parse(value) : null);

export async function loadFoundation(db: Db) {
  const [releaseRows, recentAudit] = await db.batch([
    db.select().from(settings).where(eq(settings.key, "foundation.release")).limit(1),
    db
      .select()
      .from(auditLog)
      .where(like(auditLog.eventType, "foundation.%"))
      .orderBy(desc(auditLog.createdAt))
      .limit(25),
  ]);
  const releaseRow = releaseRows[0];

  return {
    release: releaseRow ? foundationReleaseSchema.parse(JSON.parse(releaseRow.valueJson)) : null,
    audit: recentAudit.map(({ beforeJson, afterJson, ...row }) => ({
      ...row,
      before: parseJson(beforeJson),
      after: parseJson(afterJson),
    })),
  };
}

export async function changeFoundationRelease(
  db: Db,
  nextInput: unknown,
  context: { actor: { type: "system" | "bootstrap-admin"; id: string }; correlationId: string },
) {
  const next = foundationReleaseSchema.parse(nextInput);

  const [existing] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, "foundation.release"))
    .limit(1);

  const before = existing ? foundationReleaseSchema.parse(JSON.parse(existing.valueJson)) : null;
  const timestamp = nowIso();
  const auditId = crypto.randomUUID();

  await db.batch([
    db
      .insert(settings)
      .values({ key: "foundation.release", valueJson: JSON.stringify(next), updatedAt: timestamp })
      .onConflictDoUpdate({
        target: settings.key,
        set: { valueJson: JSON.stringify(next), updatedAt: timestamp },
      }),
    audit(db, {
      id: auditId,
      eventType: "foundation.release.changed",
      entityType: "setting",
      entityId: "foundation.release",
      action: "update",
      actor: context.actor,
      before,
      after: next,
      correlationId: context.correlationId,
      source: "deploy",
    }),
  ]);

  return { before, after: next, auditId };
}
