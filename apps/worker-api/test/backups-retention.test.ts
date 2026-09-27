import { env } from "cloudflare:test";
import type { BackupPolicyValues } from "@cloudbox/contracts";
import { DEFAULT_BACKUP_POLICY } from "@cloudbox/contracts";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  classifyDeviceArtifacts,
  RECENT_WINDOW_HOURS,
  runBackupRetentionSweep,
} from "../src/backups/retention";
import { createDb } from "../src/db/client";
import { backupArtifacts, backupJobs } from "../src/db/schema";
import { newId } from "../src/ids";
import { seedDevice, seedTenant } from "./fixtures";

const FIXED_NOW = new Date("2026-06-15T00:00:00.000Z");
const DAY_MS = 86_400_000;
const daysAgo = (n: number) => new Date(FIXED_NOW.getTime() - n * DAY_MS).toISOString();
const hoursAgo = (n: number) => new Date(FIXED_NOW.getTime() - n * 3_600_000).toISOString();

const POLICY: BackupPolicyValues = {
  frequentHours: 4,
  dailyKeep: 3,
  weeklyKeep: 2,
  monthlyKeep: 2,
  yearlyKeep: 1,
  offsiteEnabled: true,
};

describe("classifyDeviceArtifacts (table-driven, fixed dates)", () => {
  it("classifies a single fresh artifact as recent and always protects it", () => {
    const [result] = classifyDeviceArtifacts(
      [{ id: "a1", uploadedAt: hoursAgo(1) }],
      POLICY,
      FIXED_NOW,
    );
    expect(result?.retentionClass).toBe("recent");
    expect(result?.protect).toBe(true);
    expect(Date.parse(result?.expiresAt ?? "")).toBeGreaterThan(FIXED_NOW.getTime());
  });

  it("puts an artifact just past the recent window into the daily bucket", () => {
    const artifacts = [{ id: "a1", uploadedAt: hoursAgo(RECENT_WINDOW_HOURS + 1) }];
    const [result] = classifyDeviceArtifacts(artifacts, POLICY, FIXED_NOW);
    expect(result?.retentionClass).toBe("daily");
  });

  it("keeps only one artifact per day within the daily window, expiring same-day duplicates", () => {
    // 2 days + 5h old: past the 48h recent window, inside the 3-day daily horizon, and both
    // timestamps fall on the same UTC calendar day.
    const morning = new Date(FIXED_NOW.getTime() - 2 * DAY_MS - 5 * 3_600_000).toISOString();
    const afternoon = new Date(Date.parse(morning) + 3_600_000).toISOString();
    const artifacts = [
      { id: "morning", uploadedAt: morning },
      { id: "afternoon", uploadedAt: afternoon },
    ];
    const results = classifyDeviceArtifacts(artifacts, POLICY, FIXED_NOW);
    const kept = results.filter((r) => Date.parse(r.expiresAt) > FIXED_NOW.getTime());
    // Exactly one of the two same-day artifacts is still "alive"; the other's expiresAt is `now`.
    expect(kept).toHaveLength(1);
  });

  it("rolls a daily artifact into weekly once it ages past the daily horizon", () => {
    const artifacts = [{ id: "old", uploadedAt: daysAgo(POLICY.dailyKeep + 1) }];
    const [result] = classifyDeviceArtifacts(artifacts, POLICY, FIXED_NOW);
    expect(result?.retentionClass).toBe("weekly");
  });

  it("rolls into monthly, then yearly, as age increases; drops off the end when yearlyKeep is 0", () => {
    const monthlyHorizonDays = POLICY.dailyKeep + POLICY.weeklyKeep * 7;
    const [monthly] = classifyDeviceArtifacts(
      [{ id: "m", uploadedAt: daysAgo(monthlyHorizonDays + 1) }],
      POLICY,
      FIXED_NOW,
    );
    expect(monthly?.retentionClass).toBe("monthly");

    const yearlyHorizonDays = monthlyHorizonDays + POLICY.monthlyKeep * 30;
    const [yearly] = classifyDeviceArtifacts(
      [{ id: "y", uploadedAt: daysAgo(yearlyHorizonDays + 1) }],
      POLICY,
      FIXED_NOW,
    );
    expect(yearly?.retentionClass).toBe("yearly");
    expect(Date.parse(yearly?.expiresAt ?? "")).toBeGreaterThan(FIXED_NOW.getTime());

    const noYearly = { ...POLICY, yearlyKeep: 0 };
    const [expired] = classifyDeviceArtifacts(
      [{ id: "y2", uploadedAt: daysAgo(yearlyHorizonDays + 1) }],
      noYearly,
      FIXED_NOW,
    );
    expect(expired?.expiresAt).toBe(FIXED_NOW.toISOString());
  });

  it("never marks the newest artifact of the batch as unprotected, however old it is", () => {
    const [only] = classifyDeviceArtifacts(
      [{ id: "ancient", uploadedAt: daysAgo(10_000) }],
      { ...POLICY, yearlyKeep: 0 },
      FIXED_NOW,
    );
    expect(only?.protect).toBe(true);
    // Still "expired" by the classification (past every horizon) — protection is what saves it.
    expect(only?.expiresAt).toBe(FIXED_NOW.toISOString());
  });

  it("empty input yields no classifications", () => {
    expect(classifyDeviceArtifacts([], POLICY, FIXED_NOW)).toEqual([]);
  });
});

describe("runBackupRetentionSweep (D1 + R2)", () => {
  async function seedArtifact(
    tenantId: string,
    deviceId: string,
    uploadedAt: string,
  ): Promise<{ jobId: string; artifactId: string; r2Key: string }> {
    const db = createDb(env.DB);
    const jobId = newId("backupJob");
    const artifactId = newId("backupArtifact");
    const r2Key = `backups/${tenantId}/${deviceId}/${jobId}/${artifactId}.bin`;
    await db.insert(backupJobs).values({
      id: jobId,
      tenantId,
      deviceId,
      kind: "nightly",
      state: "cloud_verified",
      startedAt: uploadedAt,
      sourceDataset: "test",
    });
    await db.insert(backupArtifacts).values({
      id: artifactId,
      jobId,
      r2Key,
      sizeBytes: 10,
      sha256: "a".repeat(64),
      uploadedAt,
      verifiedAt: uploadedAt,
    });
    await env.ARTIFACTS.put(r2Key, "test-object");
    return { jobId, artifactId, r2Key };
  }

  it("deletes an artifact once expired, and audits BACKUP_RETENTION_APPLIED", async () => {
    const { tenantId } = await seedTenant(env.DB);
    const { deviceId } = await seedDevice(env.DB, { tenantId });

    // Old enough to have fallen out of every bucket under the *default* policy (no tenant
    // override, so the sweep uses `DEFAULT_BACKUP_POLICY`), but not the newest for this device.
    const horizonDays =
      DEFAULT_BACKUP_POLICY.dailyKeep +
      DEFAULT_BACKUP_POLICY.weeklyKeep * 7 +
      DEFAULT_BACKUP_POLICY.monthlyKeep * 30 +
      1;
    const stale = await seedArtifact(tenantId, deviceId, daysAgo(horizonDays));
    const newest = await seedArtifact(tenantId, deviceId, hoursAgo(1));

    const result = await runBackupRetentionSweep(createDb(env.DB), env.ARTIFACTS, FIXED_NOW);
    expect(result.deletedByDevice[deviceId]).toContain(stale.artifactId);
    expect(result.deletedByDevice[deviceId]).not.toContain(newest.artifactId);

    const db = createDb(env.DB);
    const [staleRow] = await db
      .select()
      .from(backupArtifacts)
      .where(eq(backupArtifacts.id, stale.artifactId));
    expect(staleRow?.deletedAt).not.toBeNull();
    expect(await env.ARTIFACTS.get(stale.r2Key)).toBeNull();

    const [newestRow] = await db
      .select()
      .from(backupArtifacts)
      .where(eq(backupArtifacts.id, newest.artifactId));
    expect(newestRow?.deletedAt).toBeNull();
    expect(await env.ARTIFACTS.get(newest.r2Key)).not.toBeNull();

    const [job] = await db.select().from(backupJobs).where(eq(backupJobs.id, newest.jobId));
    expect(job?.state).toBe("retention_applied");

    const auditRow = await env.DB.prepare(
      "SELECT * FROM audit_log WHERE event_type = 'BACKUP_RETENTION_APPLIED' AND entity_id = ?1",
    )
      .bind(deviceId)
      .first();
    expect(auditRow).not.toBeNull();
  });

  it("is a no-op when there are no live cloud_verified artifacts", async () => {
    const result = await runBackupRetentionSweep(createDb(env.DB), env.ARTIFACTS, FIXED_NOW);
    expect(result.deleted).toBe(0);
  });

  it("never deletes the single newest artifact even once every horizon has passed", async () => {
    const { tenantId } = await seedTenant(env.DB);
    const { deviceId } = await seedDevice(env.DB, { tenantId });
    const onlyOne = await seedArtifact(tenantId, deviceId, daysAgo(10_000));

    await runBackupRetentionSweep(createDb(env.DB), env.ARTIFACTS, FIXED_NOW);

    const [row] = await createDb(env.DB)
      .select()
      .from(backupArtifacts)
      .where(eq(backupArtifacts.id, onlyOne.artifactId));
    expect(row?.deletedAt).toBeNull();
    expect(await env.ARTIFACTS.get(onlyOne.r2Key)).not.toBeNull();
  });
});
