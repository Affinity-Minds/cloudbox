// Owner: WT-19. Retention engine (master spec §23.7, Slice 9.4). `classifyDeviceArtifacts` is a
// pure function (grandfather-father-son rotation: recent → daily → weekly → monthly → yearly,
// each bucket claiming at most one artifact per calendar period, oldest-first exhaustion of the
// newer buckets before an artifact can fall into an older one) so it is table-testable against
// fixed dates without touching D1. `runBackupRetentionSweep` is the Cron-driven, server-side,
// audited sweep that actually deletes expired R2 objects (§23.7 "Retention deletion is a
// controlled server-side operation and must be audited").
import type { BackupPolicyValues, RetentionClass } from "@cloudbox/contracts";
import { and, eq, isNull, sql } from "drizzle-orm";
import { audit } from "../audit";
import type { Db } from "../db/client";
import { backupArtifacts, backupJobs } from "../db/schema";
import { nowIso } from "../ids";
import { getEffectivePolicy } from "./policy";

/** §23.7 "Recent restore points: 24-48 hours" — the upper bound, independent of the policy's
 * `frequentHours` cadence (which governs how *often* Layer A runs, not how long a point lives). */
export const RECENT_WINDOW_HOURS = 48;

const DAY_MS = 86_400_000;

function dayIndex(date: Date): number {
  return Math.floor(date.getTime() / DAY_MS);
}
function weekIndex(date: Date): number {
  return Math.floor(dayIndex(date) / 7);
}
function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
}
function yearKey(date: Date): string {
  return `${date.getUTCFullYear()}`;
}
function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

export type ClassifiableArtifact = { id: string; uploadedAt: string };

export type ArtifactClassification = {
  id: string;
  retentionClass: RetentionClass;
  expiresAt: string;
  /** The single newest artifact of the batch (per §23.7 "never delete the newest cloud_verified
   * artifact per device regardless of policy"); the sweep must never delete this one. */
  protect: boolean;
};

/**
 * Classifies one device's `cloud_verified`, not-yet-deleted artifacts. Callers pass exactly one
 * device's artifacts per call — cross-device grouping happens in `runBackupRetentionSweep`, never
 * here, so this stays a pure function of its input array plus `now`.
 */
export function classifyDeviceArtifacts(
  artifacts: readonly ClassifiableArtifact[],
  policy: BackupPolicyValues,
  now: Date,
): ArtifactClassification[] {
  const sorted = [...artifacts].sort((a, b) => Date.parse(b.uploadedAt) - Date.parse(a.uploadedAt));
  if (sorted.length === 0) return [];

  const newestId = sorted[0]?.id;
  const recentWindowDays = RECENT_WINDOW_HOURS / 24;
  const dailyHorizonDays = policy.dailyKeep;
  const weeklyHorizonDays = dailyHorizonDays + policy.weeklyKeep * 7;
  const monthlyHorizonDays = weeklyHorizonDays + policy.monthlyKeep * 30;
  const yearlyHorizonDays =
    monthlyHorizonDays + (policy.yearlyKeep > 0 ? policy.yearlyKeep * 365 : 0);

  const claimedDays = new Set<number>();
  const claimedWeeks = new Set<number>();
  const claimedMonths = new Set<string>();
  const claimedYears = new Set<string>();

  return sorted.map((artifact) => {
    const uploaded = new Date(artifact.uploadedAt);
    const ageDays = (now.getTime() - uploaded.getTime()) / DAY_MS;
    let retentionClass: RetentionClass;
    let expiresAt: Date;

    if (ageDays < recentWindowDays) {
      retentionClass = "recent";
      expiresAt = addDays(uploaded, recentWindowDays);
    } else if (ageDays < dailyHorizonDays) {
      const key = dayIndex(uploaded);
      const claimed = policy.dailyKeep > 0 && !claimedDays.has(key);
      if (claimed) claimedDays.add(key);
      retentionClass = "daily";
      expiresAt = claimed ? addDays(uploaded, policy.dailyKeep) : now;
    } else if (ageDays < weeklyHorizonDays) {
      const key = weekIndex(uploaded);
      const claimed = policy.weeklyKeep > 0 && !claimedWeeks.has(key);
      if (claimed) claimedWeeks.add(key);
      retentionClass = "weekly";
      expiresAt = claimed ? addDays(uploaded, policy.weeklyKeep * 7) : now;
    } else if (ageDays < monthlyHorizonDays) {
      const key = monthKey(uploaded);
      const claimed = policy.monthlyKeep > 0 && !claimedMonths.has(key);
      if (claimed) claimedMonths.add(key);
      retentionClass = "monthly";
      expiresAt = claimed ? addDays(uploaded, policy.monthlyKeep * 30) : now;
    } else if (policy.yearlyKeep > 0 && ageDays < yearlyHorizonDays) {
      const key = yearKey(uploaded);
      const claimed = !claimedYears.has(key);
      if (claimed) claimedYears.add(key);
      retentionClass = "yearly";
      expiresAt = claimed ? addDays(uploaded, policy.yearlyKeep * 365) : now;
    } else {
      // Beyond every configured horizon: already due for deletion (unless protected below).
      retentionClass = policy.yearlyKeep > 0 ? "yearly" : "monthly";
      expiresAt = now;
    }

    return {
      id: artifact.id,
      retentionClass,
      expiresAt: expiresAt.toISOString(),
      protect: artifact.id === newestId,
    };
  });
}

export type RetentionSweepResult = {
  classified: number;
  deleted: number;
  deletedByDevice: Record<string, string[]>;
};

/**
 * Cron-driven sweep (`src/scheduled.ts`). One query to gather every live `cloud_verified`
 * artifact with its device/tenant, then per device: classify, persist the classification, delete
 * whatever is both expired and unprotected (R2 delete + `deleted_at`), and audit
 * `BACKUP_RETENTION_APPLIED` once per device with deletions. Not a request-path loader, so the
 * fast-data-hydration 3-round-trip screen ceiling does not apply here — but it still batches
 * writes per device rather than per artifact.
 */
export async function runBackupRetentionSweep(
  db: Db,
  bucket: R2Bucket,
  now: Date = new Date(),
): Promise<RetentionSweepResult> {
  const rows = await db
    .select({
      artifactId: backupArtifacts.id,
      r2Key: backupArtifacts.r2Key,
      uploadedAt: backupArtifacts.uploadedAt,
      jobId: backupArtifacts.jobId,
      jobState: backupJobs.state,
      deviceId: backupJobs.deviceId,
      tenantId: backupJobs.tenantId,
    })
    .from(backupArtifacts)
    .innerJoin(backupJobs, eq(backupJobs.id, backupArtifacts.jobId))
    .where(and(isNull(backupArtifacts.deletedAt), sql`${backupArtifacts.verifiedAt} IS NOT NULL`));

  const byDevice = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byDevice.get(row.deviceId) ?? [];
    list.push(row);
    byDevice.set(row.deviceId, list);
  }

  const policyCache = new Map<string, BackupPolicyValues>();
  const result: RetentionSweepResult = { classified: 0, deleted: 0, deletedByDevice: {} };
  const nowIsoValue = nowIso();

  for (const [deviceId, deviceRows] of byDevice) {
    const tenantId = deviceRows[0]?.tenantId as string;
    let policy = policyCache.get(tenantId);
    if (!policy) {
      policy = await getEffectivePolicy(db, tenantId);
      policyCache.set(tenantId, policy);
    }

    const classifications = classifyDeviceArtifacts(
      deviceRows.map((r) => ({ id: r.artifactId, uploadedAt: r.uploadedAt as string })),
      policy,
      now,
    );
    result.classified += classifications.length;
    const byId = new Map(deviceRows.map((r) => [r.artifactId, r]));

    // Sequential, not `db.batch`: the array length varies per device, and each write is already
    // an independent, idempotent statement (a re-run of the sweep converges to the same state), so
    // batching for atomicity buys nothing here that is worth fighting drizzle's fixed-tuple batch
    // type for.
    const deletedIds: string[] = [];

    for (const c of classifications) {
      const row = byId.get(c.id);
      if (!row) continue;
      const expired = c.expiresAt <= nowIsoValue;
      if (expired && !c.protect) {
        await bucket.delete(row.r2Key);
        deletedIds.push(c.id);
        await db
          .update(backupArtifacts)
          .set({ deletedAt: nowIsoValue, retentionClass: c.retentionClass, expiresAt: c.expiresAt })
          .where(eq(backupArtifacts.id, c.id));
      } else {
        await db
          .update(backupArtifacts)
          .set({ retentionClass: c.retentionClass, expiresAt: c.expiresAt })
          .where(eq(backupArtifacts.id, c.id));
      }
      if (row.jobState === "cloud_verified") {
        await db
          .update(backupJobs)
          .set({ state: "retention_applied" })
          .where(eq(backupJobs.id, row.jobId));
      }
    }

    if (deletedIds.length > 0) {
      await audit(db, {
        eventType: "BACKUP_RETENTION_APPLIED",
        entityType: "device",
        entityId: deviceId,
        actor: { type: "system", id: "backup-retention-sweep", tenantId },
        before: { liveArtifacts: deviceRows.length },
        after: { deletedArtifactIds: deletedIds },
        source: "scheduled",
      });
    }

    result.deleted += deletedIds.length;
    if (deletedIds.length > 0) result.deletedByDevice[deviceId] = deletedIds;
  }

  return result;
}
