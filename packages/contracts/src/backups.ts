// Owner: WT-19. Backup metadata, offsite upload and the backup dashboard (master spec §23, §46;
// Slices 9.3-9.5, cloud halves only — Slices 9.1/9.2/9.6 are the Windows Agent, later work).
import { z } from "zod";

export const BackupJobKind = z.enum(["frequent", "nightly", "manual", "pre_upgrade"]);
export type BackupJobKind = z.infer<typeof BackupJobKind>;

/**
 * §23.8 "backup success is not upload success": each state is a separate, auditable fact, never
 * inferred from "a file exists". `upload_completed`/`cloud_verified`/`retention_applied` are only
 * ever set by the server (upload endpoints, the retention sweep) — never accepted from a client
 * PATCH — so a device cannot claim a cloud state it did not actually reach (see
 * `state-machine.ts`).
 */
export const BackupJobState = z.enum([
  "created",
  "verified_local",
  "upload_started",
  "upload_completed",
  "cloud_verified",
  "retention_applied",
  "failed",
]);
export type BackupJobState = z.infer<typeof BackupJobState>;

/** §23.7 retention buckets (grandfather-father-son rotation), computed by `retention.ts`. */
export const RetentionClass = z.enum(["recent", "daily", "weekly", "monthly", "yearly"]);
export type RetentionClass = z.infer<typeof RetentionClass>;

export const RestoreOutcome = z.enum(["success", "failure", "partial"]);
export type RestoreOutcome = z.infer<typeof RestoreOutcome>;

export const BackupJobError = z.object({ reason: z.string(), detail: z.unknown().optional() });
export type BackupJobError = z.infer<typeof BackupJobError>;

export const BackupJob = z.object({
  id: z.string(),
  tenantId: z.string(),
  deviceId: z.string(),
  kind: BackupJobKind,
  state: BackupJobState,
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  sourceDataset: z.string(),
  appVersion: z.string().nullable(),
  sizeBytes: z.number().int().nullable(),
  sha256: z.string().nullable(),
  localPathHint: z.string().nullable(),
  error: BackupJobError.nullable(),
});
export type BackupJob = z.infer<typeof BackupJob>;

/** `POST /api/v1/backups/jobs` body (device Bearer token). */
export const CreateBackupJobRequest = z.object({
  kind: BackupJobKind,
  sourceDataset: z.string().min(1).max(255),
  appVersion: z.string().max(64).optional(),
  localPathHint: z.string().max(1024).optional(),
});
export type CreateBackupJobRequest = z.infer<typeof CreateBackupJobRequest>;

export const Sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "expected a lowercase sha256 hex digest");

/**
 * `PATCH /api/v1/backups/jobs/:id` body. Only client-safe transitions are accepted here:
 * `created` → `verified_local` (requires `sha256`+`sizeBytes`, §23.8) → `upload_started`, or any
 * non-terminal state → `failed` (with `error`). Cloud states are set by the upload endpoints.
 */
export const PatchBackupJobRequest = z
  .object({
    state: z.enum(["verified_local", "upload_started", "failed"]),
    sha256: Sha256Hex.optional(),
    sizeBytes: z.number().int().min(0).optional(),
    error: BackupJobError.optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.state === "verified_local" &&
      (value.sha256 === undefined || value.sizeBytes === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "verified_local requires sha256 and sizeBytes",
        path: ["sha256"],
      });
    }
    if (value.state === "failed" && value.error === undefined) {
      ctx.addIssue({ code: "custom", message: "failed requires error", path: ["error"] });
    }
  });
export type PatchBackupJobRequest = z.infer<typeof PatchBackupJobRequest>;

export const BackupArtifact = z.object({
  id: z.string(),
  jobId: z.string(),
  r2Key: z.string(),
  sizeBytes: z.number().int().nullable(),
  sha256: z.string().nullable(),
  encryption: z.unknown().nullable(),
  uploadedAt: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  retentionClass: RetentionClass.nullable(),
  expiresAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
});
export type BackupArtifact = z.infer<typeof BackupArtifact>;

/** Single-shot upload cap (§23.6, agent-notes cloudflare-workers #18 "cap by type"); above this a
 * device must use the resumable multipart flow instead. R2's own single-PUT ceiling is 5 GiB. */
export const MAX_SINGLE_SHOT_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

export const UploadCompleteResponse = z.object({ job: BackupJob, artifact: BackupArtifact });
export type UploadCompleteResponse = z.infer<typeof UploadCompleteResponse>;

/** `POST /api/v1/backups/jobs/:id/upload/init` body. */
export const InitMultipartUploadRequest = z.object({
  sizeBytes: z.number().int().min(1),
  encryption: z.unknown().optional(),
});
export type InitMultipartUploadRequest = z.infer<typeof InitMultipartUploadRequest>;

export const InitMultipartUploadResponse = z.object({
  artifactId: z.string(),
  uploadId: z.string(),
  r2Key: z.string(),
});
export type InitMultipartUploadResponse = z.infer<typeof InitMultipartUploadResponse>;

export const UploadPartResponse = z.object({
  partNumber: z.number().int().min(1),
  etag: z.string(),
});
export type UploadPartResponse = z.infer<typeof UploadPartResponse>;

export const CompleteMultipartUploadRequest = z.object({
  parts: z.array(z.object({ partNumber: z.number().int().min(1), etag: z.string() })).min(1),
  sha256: Sha256Hex,
  sizeBytes: z.number().int().min(0),
});
export type CompleteMultipartUploadRequest = z.infer<typeof CompleteMultipartUploadRequest>;

// ─── Retention policy ────────────────────────────────────────────────────────────────────────

/** §23.7 template default, also the seeded `settings['backups.default_policy']` row. */
export const DEFAULT_BACKUP_POLICY = {
  frequentHours: 4,
  dailyKeep: 30,
  weeklyKeep: 12,
  monthlyKeep: 12,
  yearlyKeep: 0,
  offsiteEnabled: true,
} as const;

export const BackupPolicyValues = z.object({
  frequentHours: z.number().int().min(1).max(24),
  dailyKeep: z.number().int().min(0).max(365),
  weeklyKeep: z.number().int().min(0).max(104),
  monthlyKeep: z.number().int().min(0).max(120),
  yearlyKeep: z.number().int().min(0).max(50),
  offsiteEnabled: z.boolean(),
});
export type BackupPolicyValues = z.infer<typeof BackupPolicyValues>;

/** `GET /api/v1/backups/policy` (device) and the tenant policy editor (staff): the tenant's own
 * row when one exists, else the global default — always resolved server-side, never guessed. */
export const EffectiveBackupPolicy = BackupPolicyValues.extend({
  tenantId: z.string(),
  isDefault: z.boolean(),
  updatedBy: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type EffectiveBackupPolicy = z.infer<typeof EffectiveBackupPolicy>;

export const UpdateBackupPolicyRequest = BackupPolicyValues.partial();
export type UpdateBackupPolicyRequest = z.infer<typeof UpdateBackupPolicyRequest>;

// ─── Restore tests (§23.9) ────────────────────────────────────────────────────────────────────

export const RestoreTest = z.object({
  id: z.string(),
  tenantId: z.string(),
  deviceId: z.string(),
  artifactId: z.string(),
  performedBy: z.string(),
  performedAt: z.string(),
  outcome: RestoreOutcome,
  notes: z.string().nullable(),
});
export type RestoreTest = z.infer<typeof RestoreTest>;

/** `POST /api/v1/backups/restore-tests` (staff, `backup.restore`). */
export const CreateRestoreTestRequest = z.object({
  tenantId: z.string(),
  deviceId: z.string(),
  artifactId: z.string(),
  outcome: RestoreOutcome,
  notes: z.string().max(2000).optional(),
});
export type CreateRestoreTestRequest = z.infer<typeof CreateRestoreTestRequest>;

// ─── Dashboard (§46) ──────────────────────────────────────────────────────────────────────────

/** Real counts only (§46 "Focus on exceptions"): no placeholder zeros dressed up as facts. */
export const BackupExceptionCounts = z.object({
  devicesProtected: z.number().int(),
  devicesOverdue: z.number().int(),
  failedJobsLast24h: z.number().int(),
  restoreVerificationOverdue: z.number().int(),
});
export type BackupExceptionCounts = z.infer<typeof BackupExceptionCounts>;

/** One row of the §46 primary table: `Tenant | Device | Last local backup | Last cloud backup |
 * Verify | Retention | State`. */
export const BackupsScreenRow = z.object({
  tenantId: z.string(),
  tenantCode: z.string(),
  tenantName: z.string(),
  deviceId: z.string(),
  deviceName: z.string(),
  lastLocalBackupAt: z.string().nullable(),
  lastCloudBackupAt: z.string().nullable(),
  lastRestoreTestAt: z.string().nullable(),
  verifyOverdue: z.boolean(),
  latestRetentionClass: RetentionClass.nullable(),
  state: BackupJobState.nullable(),
  overdue: z.boolean(),
});
export type BackupsScreenRow = z.infer<typeof BackupsScreenRow>;

/** `GET /api/v1/screens/backups?tenant=&state=`. */
export const BackupsScreen = z.object({
  exceptions: BackupExceptionCounts,
  items: z.array(BackupsScreenRow),
  tenants: z.array(z.object({ id: z.string(), publicCode: z.string(), displayName: z.string() })),
});
export type BackupsScreen = z.infer<typeof BackupsScreen>;

/** `GET /api/v1/screens/backups/:deviceId`: per-device history drawer. */
export const BackupDeviceHistoryScreen = z.object({
  device: z.object({
    id: z.string(),
    name: z.string(),
    tenantId: z.string(),
    tenantCode: z.string(),
    tenantName: z.string(),
  }),
  policy: EffectiveBackupPolicy,
  jobs: z.array(BackupJob),
  artifacts: z.array(BackupArtifact),
  restoreTests: z.array(RestoreTest),
});
export type BackupDeviceHistoryScreen = z.infer<typeof BackupDeviceHistoryScreen>;

// ─── Customer portal (`/api/v1/me/backups`) ──────────────────────────────────────────────────

export const MeBackupsRow = z.object({
  deviceId: z.string(),
  deviceName: z.string(),
  lastLocalBackupAt: z.string().nullable(),
  lastCloudBackupAt: z.string().nullable(),
  state: BackupJobState.nullable(),
});
export type MeBackupsRow = z.infer<typeof MeBackupsRow>;

export const MeBackupsResponse = z.object({ items: z.array(MeBackupsRow) });
export type MeBackupsResponse = z.infer<typeof MeBackupsResponse>;
