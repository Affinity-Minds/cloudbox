import { desc, eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { auditLog, settings } from "./schema";

export type AuditActor = {
  type: "system" | "bootstrap-admin";
  id: string;
};

const foundationReleaseSchema = z.object({
  status: z.string().min(1).max(64),
  sha: z.string().min(1).max(128),
});

export type FoundationRelease = z.infer<typeof foundationReleaseSchema>;

const nowSqlite = () => new Date().toISOString().replace("T", " ").replace("Z", "");

export async function loadFoundation(dbBinding: D1Database) {
  const db = drizzle(dbBinding);
  const [releaseRow] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, "foundation.release"))
    .limit(1);

  const recentAudit = await db
    .select()
    .from(auditLog)
    .where(like(auditLog.eventType, "foundation.%"))
    .orderBy(desc(auditLog.createdAt))
    .limit(25);

  return {
    release: releaseRow ? foundationReleaseSchema.parse(JSON.parse(releaseRow.valueJson)) : null,
    audit: recentAudit.map((row) => ({
      ...row,
      before: row.beforeJson ? JSON.parse(row.beforeJson) : null,
      after: row.afterJson ? JSON.parse(row.afterJson) : null,
      beforeJson: undefined,
      afterJson: undefined,
    })),
  };
}

export async function changeFoundationRelease(
  dbBinding: D1Database,
  nextInput: unknown,
  actor: AuditActor,
) {
  const next = foundationReleaseSchema.parse(nextInput);
  const db = drizzle(dbBinding);

  const [existing] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, "foundation.release"))
    .limit(1);

  const before = existing ? foundationReleaseSchema.parse(JSON.parse(existing.valueJson)) : null;
  const timestamp = nowSqlite();
  const auditId = crypto.randomUUID();

  const upsertSetting = db
    .insert(settings)
    .values({
      key: "foundation.release",
      valueJson: JSON.stringify(next),
      updatedAt: timestamp,
    })
    .onConflictDoUpdate({
      target: settings.key,
      set: {
        valueJson: JSON.stringify(next),
        updatedAt: timestamp,
      },
    });

  const appendAudit = db.insert(auditLog).values({
    id: auditId,
    eventType: "foundation.release.changed",
    entityType: "setting",
    entityId: "foundation.release",
    actorType: actor.type,
    actorId: actor.id,
    action: "update",
    beforeJson: before ? JSON.stringify(before) : null,
    afterJson: JSON.stringify(next),
    createdAt: timestamp,
  });

  await db.batch([upsertSetting, appendAudit]);

  return { before, after: next, auditId };
}
