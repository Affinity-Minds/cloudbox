// Owner: WT-19. GET /api/v1/screens/backups?tenant=&state=, GET /api/v1/screens/backups/:deviceId.
// Master spec §46 "Backup Dashboard: focus on exceptions" — real counts only, primary table
// `Tenant | Device | Last local backup | Last cloud backup | Verify | Retention | State`, a row
// opens the history drawer. Both routes are staff-only (`backup.view`); unlike Fleet there is no
// tenant-standing audience here — the customer-facing equivalent is `GET /api/v1/me/backups`.
import {
  type BackupExceptionCounts,
  type BackupJobState,
  DEFAULT_BACKUP_POLICY,
  type RetentionClass,
} from "@cloudbox/contracts";
import { desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { requirePermission } from "../../../authz/permissions";
import { RECENT_WINDOW_HOURS } from "../../../backups/retention";
import { createDb, type Db } from "../../../db/client";
import {
  backupArtifacts,
  backupJobs,
  backupPolicies,
  devices,
  restoreTests,
  settings,
  tenants,
} from "../../../db/schema";
import type { AppEnv } from "../../../env";
import { toBackupArtifact, toBackupJob } from "../backups";

/** §23.11 "no successful backup within expected window" / §23.9 "flag fleets/tenants with no
 * recent verification" — thresholds the dashboard itself uses to flag exceptions. Not the
 * per-tenant retention policy (that governs how long an artifact is *kept*, not how often a fresh
 * one is expected); reuses the same 48h window `retention.ts` treats as "recent" for consistency. */
const OVERDUE_HOURS = RECENT_WINDOW_HOURS;
const RESTORE_TEST_OVERDUE_DAYS = 90;

function hoursAgo(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : (now - parsed) / 3_600_000;
}

type BackupsRow = {
  tenantId: string;
  tenantCode: string;
  tenantName: string;
  deviceId: string;
  deviceName: string;
  lastLocalBackupAt: string | null;
  lastCloudBackupAt: string | null;
  lastRestoreTestAt: string | null;
  latestRetentionClass: RetentionClass | null;
  state: BackupJobState | null;
};

export async function loadBackupsScreen(
  db: Db,
  filters: { tenant?: string; state?: BackupJobState },
) {
  const lastLocalBackupAt = sql<string | null>`(
    SELECT ${backupJobs.startedAt} FROM ${backupJobs}
    WHERE ${backupJobs.deviceId} = ${devices.id} AND ${backupJobs.state} != 'failed' AND ${backupJobs.state} != 'created'
    ORDER BY ${backupJobs.startedAt} DESC LIMIT 1
  )`;
  const latestState = sql<string | null>`(
    SELECT ${backupJobs.state} FROM ${backupJobs}
    WHERE ${backupJobs.deviceId} = ${devices.id}
    ORDER BY ${backupJobs.startedAt} DESC LIMIT 1
  )`;
  const lastCloudBackupAt = sql<string | null>`(
    SELECT ${backupArtifacts.uploadedAt} FROM ${backupArtifacts}
    INNER JOIN ${backupJobs} ON ${backupJobs.id} = ${backupArtifacts.jobId}
    WHERE ${backupJobs.deviceId} = ${devices.id} AND ${backupArtifacts.verifiedAt} IS NOT NULL
      AND ${backupArtifacts.deletedAt} IS NULL
    ORDER BY ${backupArtifacts.uploadedAt} DESC LIMIT 1
  )`;
  const latestRetentionClass = sql<string | null>`(
    SELECT ${backupArtifacts.retentionClass} FROM ${backupArtifacts}
    INNER JOIN ${backupJobs} ON ${backupJobs.id} = ${backupArtifacts.jobId}
    WHERE ${backupJobs.deviceId} = ${devices.id} AND ${backupArtifacts.deletedAt} IS NULL
    ORDER BY ${backupArtifacts.uploadedAt} DESC LIMIT 1
  )`;
  const lastRestoreTestAt = sql<string | null>`(
    SELECT ${restoreTests.performedAt} FROM ${restoreTests}
    WHERE ${restoreTests.deviceId} = ${devices.id}
    ORDER BY ${restoreTests.performedAt} DESC LIMIT 1
  )`;

  const tenantScope = filters.tenant ? eq(devices.tenantId, filters.tenant) : undefined;
  const failedSince = new Date(Date.now() - 24 * 3_600_000).toISOString();

  const [rows, failedRows, tenantRows] = await db.batch([
    db
      .select({
        tenantId: devices.tenantId,
        tenantCode: tenants.publicCode,
        tenantName: tenants.displayName,
        deviceId: devices.id,
        deviceName: devices.name,
        lastLocalBackupAt,
        lastCloudBackupAt,
        lastRestoreTestAt,
        latestRetentionClass,
        state: latestState,
      })
      .from(devices)
      .innerJoin(tenants, eq(tenants.id, devices.tenantId))
      .where(tenantScope)
      .orderBy(desc(devices.enrolledAt)),
    db
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(backupJobs)
      .where(sql`${backupJobs.state} = 'failed' AND ${backupJobs.startedAt} >= ${failedSince}`),
    db
      .select({ id: tenants.id, publicCode: tenants.publicCode, displayName: tenants.displayName })
      .from(tenants)
      .orderBy(tenants.displayName),
  ]);

  const now = Date.now();
  const withFlags = (rows as BackupsRow[]).map((row) => {
    const cloudAgeHours = hoursAgo(row.lastCloudBackupAt, now);
    const restoreAgeHours = hoursAgo(row.lastRestoreTestAt, now);
    const overdue = cloudAgeHours === null || cloudAgeHours > OVERDUE_HOURS;
    const verifyOverdue =
      restoreAgeHours === null || restoreAgeHours / 24 > RESTORE_TEST_OVERDUE_DAYS;
    return { ...row, overdue, verifyOverdue };
  });

  const exceptions: BackupExceptionCounts = {
    devicesProtected: withFlags.filter((r) => r.lastCloudBackupAt !== null).length,
    devicesOverdue: withFlags.filter((r) => r.overdue).length,
    failedJobsLast24h: failedRows[0]?.n ?? 0,
    restoreVerificationOverdue: withFlags.filter((r) => r.verifyOverdue).length,
  };

  const items = withFlags.filter(
    (row) => filters.state === undefined || row.state === filters.state,
  );
  // Exceptions first (§46 "focus on exceptions"): overdue or failed above everything else.
  items.sort(
    (a, b) => Number(b.overdue || b.state === "failed") - Number(a.overdue || a.state === "failed"),
  );

  return { exceptions, items, tenants: tenantRows };
}

/**
 * Two round trips (well under the fast-data-hydration ceiling of 3): the device+tenant join
 * resolves `tenantId`, which the second, batched call needs for the policy lookup — a dependent
 * query, so it cannot join the first `db.batch` (batch entries run together, not sequenced).
 */
export async function loadBackupDeviceHistory(db: Db, deviceId: string) {
  const [device] = await db
    .select({
      id: devices.id,
      name: devices.name,
      tenantId: devices.tenantId,
      tenantCode: tenants.publicCode,
      tenantName: tenants.displayName,
    })
    .from(devices)
    .innerJoin(tenants, eq(tenants.id, devices.tenantId))
    .where(eq(devices.id, deviceId));
  if (!device) return "not_found" as const;

  const [policyRows, settingsRows, jobRows, artifactRows, restoreRows] = await db.batch([
    db.select().from(backupPolicies).where(eq(backupPolicies.tenantId, device.tenantId)),
    db
      .select({ valueJson: settings.valueJson })
      .from(settings)
      .where(eq(settings.key, "backups.default_policy")),
    db
      .select()
      .from(backupJobs)
      .where(eq(backupJobs.deviceId, deviceId))
      .orderBy(desc(backupJobs.startedAt))
      .limit(50),
    db
      .select({ artifact: backupArtifacts })
      .from(backupArtifacts)
      .innerJoin(backupJobs, eq(backupJobs.id, backupArtifacts.jobId))
      .where(eq(backupJobs.deviceId, deviceId))
      .orderBy(desc(backupArtifacts.uploadedAt))
      .limit(50),
    db
      .select()
      .from(restoreTests)
      .where(eq(restoreTests.deviceId, deviceId))
      .orderBy(desc(restoreTests.performedAt))
      .limit(50),
  ]);

  const tenantPolicy = policyRows[0];
  const globalDefault = settingsRows[0]
    ? JSON.parse(settingsRows[0].valueJson)
    : DEFAULT_BACKUP_POLICY;
  const policy = tenantPolicy
    ? {
        tenantId: device.tenantId,
        frequentHours: tenantPolicy.frequentHours,
        dailyKeep: tenantPolicy.dailyKeep,
        weeklyKeep: tenantPolicy.weeklyKeep,
        monthlyKeep: tenantPolicy.monthlyKeep,
        yearlyKeep: tenantPolicy.yearlyKeep,
        offsiteEnabled: tenantPolicy.offsiteEnabled,
        isDefault: false,
        updatedBy: tenantPolicy.updatedBy,
        updatedAt: tenantPolicy.updatedAt,
      }
    : {
        tenantId: device.tenantId,
        ...globalDefault,
        isDefault: true,
        updatedBy: null,
        updatedAt: null,
      };

  return {
    device,
    policy,
    jobs: jobRows.map(toBackupJob),
    artifacts: artifactRows.map((r) => toBackupArtifact(r.artifact)),
    restoreTests: restoreRows,
  };
}

const backupsScreen = new Hono<AppEnv>();

backupsScreen.get("/", requirePermission("backup.view"), async (c) => {
  const db = createDb(c.env.DB);
  const state = c.req.query("state") as BackupJobState | undefined;
  const result = await loadBackupsScreen(db, { tenant: c.req.query("tenant"), state });
  return c.json(result);
});

backupsScreen.get("/:deviceId", requirePermission("backup.view"), async (c) => {
  const db = createDb(c.env.DB);
  const result = await loadBackupDeviceHistory(db, c.req.param("deviceId"));
  if (result === "not_found") return c.json({ error: "not_found" }, 404);
  return c.json(result);
});

export default backupsScreen;
