// Owner: WT-19. Backup metadata, offsite upload/verify and retention policy data (master spec
// §23, all subsections; Slices 9.3-9.4 cloud halves). Three routers, one file, mirroring
// subscriptions.ts's shape (its paths span three prefixes too):
//   - `backups`             → `/api/v1/backups`                       (device Bearer token, plus
//                              one staff-gated route: `POST /restore-tests`)
//   - `tenantBackupPolicy`  → `/api/v1/tenants/:tenantId/backup-policy` (staff, `backup.restore`)
//   - `meBackups`           → `/api/v1/me/backups`                     (customer portal, own tenant)
// Device-facing routes never touch `routes/v1/agent.ts` (WT-3's file) — they live entirely here,
// using WT-3's `requireDevice()` for the Bearer gate.
import {
  CompleteMultipartUploadRequest,
  CreateBackupJobRequest,
  CreateRestoreTestRequest,
  InitMultipartUploadRequest,
  MAX_SINGLE_SHOT_UPLOAD_BYTES,
  PatchBackupJobRequest,
  UpdateBackupPolicyRequest,
} from "@cloudbox/contracts";
import { zValidator } from "@hono/zod-validator";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { audit } from "../../audit";
import { requireUser } from "../../auth/middleware";
import { requirePermission } from "../../authz/permissions";
import { getEffectivePolicy } from "../../backups/policy";
import { backupArtifactKey } from "../../backups/r2-keys";
import { isValidClientTransition } from "../../backups/state-machine";
import { hashExistingObject, streamUploadWithHash } from "../../backups/upload";
import { isUniqueConstraintError } from "../../crypto";
import { createDb, type Db } from "../../db/client";
import {
  backupArtifacts,
  backupJobs,
  backupPolicies,
  devices,
  restoreTests,
  tenantMemberships,
  tenants,
} from "../../db/schema";
import { requireDevice } from "../../devices/require-device";
import type { AppDevice, AppEnv } from "../../env";
import { newId, nowIso } from "../../ids";

type BackupJobRow = typeof backupJobs.$inferSelect;
type BackupArtifactRow = typeof backupArtifacts.$inferSelect;

export const toBackupJob = (row: BackupJobRow) => ({
  id: row.id,
  tenantId: row.tenantId,
  deviceId: row.deviceId,
  kind: row.kind,
  state: row.state,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
  sourceDataset: row.sourceDataset,
  appVersion: row.appVersion,
  sizeBytes: row.sizeBytes,
  sha256: row.sha256,
  localPathHint: row.localPathHint,
  error: row.errorJson ? JSON.parse(row.errorJson) : null,
});

export const toBackupArtifact = (row: BackupArtifactRow) => ({
  id: row.id,
  jobId: row.jobId,
  r2Key: row.r2Key,
  sizeBytes: row.sizeBytes,
  sha256: row.sha256,
  encryption: row.encryptionJson ? JSON.parse(row.encryptionJson) : null,
  uploadedAt: row.uploadedAt,
  verifiedAt: row.verifiedAt,
  retentionClass: row.retentionClass,
  expiresAt: row.expiresAt,
  deletedAt: row.deletedAt,
});

/** The one artifact row a job ever has (`job_id` is unique); created lazily on the first upload
 * attempt (raw or multipart init), never on job creation itself. */
async function getOrCreateArtifact(
  db: Db,
  job: Pick<BackupJobRow, "id" | "tenantId" | "deviceId">,
): Promise<BackupArtifactRow> {
  const [existing] = await db
    .select()
    .from(backupArtifacts)
    .where(eq(backupArtifacts.jobId, job.id));
  if (existing) return existing;

  const id = newId("backupArtifact");
  const r2Key = backupArtifactKey(job.tenantId, job.deviceId, job.id, id);
  try {
    await db.insert(backupArtifacts).values({ id, jobId: job.id, r2Key });
  } catch (error) {
    if (!isUniqueConstraintError(error, "job_id")) throw error;
  }
  const [row] = await db.select().from(backupArtifacts).where(eq(backupArtifacts.jobId, job.id));
  if (!row) throw new Error("artifact row missing after insert");
  return row;
}

/** Loads a job scoped to the calling device; 404 (not 403) for anything not this device's own —
 * a device must never learn that a job id it doesn't own exists (§37 tenant isolation). */
async function loadOwnJob(db: Db, device: AppDevice, jobId: string) {
  const [job] = await db
    .select()
    .from(backupJobs)
    .where(and(eq(backupJobs.id, jobId), eq(backupJobs.deviceId, device.id)));
  return job ?? null;
}

// ─── /api/v1/backups ──────────────────────────────────────────────────────────────────────────

export const backups = new Hono<AppEnv>();

backups.post(
  "/jobs",
  requireDevice(),
  zValidator("json", CreateBackupJobRequest, (result, c) => {
    if (!result.success) return c.json({ error: "invalid_request" }, 400);
  }),
  async (c) => {
    const device = c.var.device;
    const body = c.req.valid("json");
    const db = createDb(c.env.DB);
    const now = nowIso();
    const id = newId("backupJob");

    const row: BackupJobRow = {
      id,
      tenantId: device.tenantId,
      deviceId: device.id,
      kind: body.kind,
      state: "created",
      startedAt: now,
      finishedAt: null,
      sourceDataset: body.sourceDataset,
      appVersion: body.appVersion ?? null,
      sizeBytes: null,
      sha256: null,
      localPathHint: body.localPathHint ?? null,
      errorJson: null,
    };

    await db.batch([
      db.insert(backupJobs).values(row),
      audit(db, {
        eventType: "BACKUP_JOB_CREATED",
        entityType: "backup_job",
        entityId: id,
        actor: { type: "device", id: device.id, tenantId: device.tenantId },
        before: null,
        after: { kind: row.kind, sourceDataset: row.sourceDataset },
        correlationId: c.var.correlationId,
        source: "agent",
      }),
    ]);

    return c.json({ job: toBackupJob(row) }, 201);
  },
);

backups.patch(
  "/jobs/:id",
  requireDevice(),
  zValidator("json", PatchBackupJobRequest, (result, c) => {
    if (!result.success) return c.json({ error: "invalid_request" }, 400);
  }),
  async (c) => {
    const device = c.var.device;
    const db = createDb(c.env.DB);
    const job = await loadOwnJob(db, device, c.req.param("id"));
    if (!job) return c.json({ error: "not_found" }, 404);

    const body = c.req.valid("json");
    if (!isValidClientTransition(job.state, body.state)) {
      return c.json(
        { error: "invalid_transition", detail: { from: job.state, to: body.state } },
        409,
      );
    }

    const now = nowIso();
    const before = toBackupJob(job);
    const patch: Partial<BackupJobRow> =
      body.state === "verified_local"
        ? { state: "verified_local", sha256: body.sha256, sizeBytes: body.sizeBytes }
        : body.state === "failed"
          ? { state: "failed", finishedAt: now, errorJson: JSON.stringify(body.error) }
          : { state: "upload_started" };
    const updatedRow = { ...job, ...patch };
    const after = toBackupJob(updatedRow);

    await db.batch([
      db.update(backupJobs).set(patch).where(eq(backupJobs.id, job.id)),
      audit(db, {
        eventType: "BACKUP_JOB_STATE_CHANGED",
        entityType: "backup_job",
        entityId: job.id,
        actor: { type: "device", id: device.id, tenantId: device.tenantId },
        before,
        after,
        correlationId: c.var.correlationId,
        source: "agent",
      }),
    ]);

    return c.json({ job: after });
  },
);

/** States a device may attempt an upload from: local verification must have happened first
 * (§23.5 Layer C "only after local backup completion and integrity verification"); `upload_started`
 * is also allowed so an interrupted attempt can simply be retried. */
const UPLOADABLE_STATES = new Set(["verified_local", "upload_started"]);

backups.post("/jobs/:id/upload", requireDevice(), async (c) => {
  const device = c.var.device;
  const db = createDb(c.env.DB);
  const job = await loadOwnJob(db, device, c.req.param("id"));
  if (!job) return c.json({ error: "not_found" }, 404);
  if (!UPLOADABLE_STATES.has(job.state)) {
    return c.json({ error: "invalid_state", detail: { state: job.state } }, 409);
  }
  if (!job.sha256) {
    return c.json({ error: "invalid_request", detail: "job has no declared sha256" }, 400);
  }

  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (contentLength > MAX_SINGLE_SHOT_UPLOAD_BYTES) {
    return c.json({ error: "artifact_too_large", detail: "use the multipart upload flow" }, 413);
  }
  const body = c.req.raw.body;
  if (!body) return c.json({ error: "invalid_request", detail: "missing body" }, 400);

  if (job.state !== "upload_started") {
    await db.update(backupJobs).set({ state: "upload_started" }).where(eq(backupJobs.id, job.id));
  }
  const artifact = await getOrCreateArtifact(db, job);

  const uploaded = await streamUploadWithHash(c.env.ARTIFACTS, artifact.r2Key, body, {
    httpMetadata: { contentType: "application/octet-stream" },
  });

  const matches =
    uploaded.sha256 === job.sha256 &&
    (job.sizeBytes === null || uploaded.sizeBytes === job.sizeBytes);
  const now = nowIso();

  if (!matches) {
    await c.env.ARTIFACTS.delete(artifact.r2Key);
    await db.batch([
      db
        .update(backupArtifacts)
        .set({
          sizeBytes: uploaded.sizeBytes,
          sha256: uploaded.sha256,
          uploadedAt: now,
          deletedAt: now,
        })
        .where(eq(backupArtifacts.id, artifact.id)),
      db
        .update(backupJobs)
        .set({
          state: "failed",
          finishedAt: now,
          errorJson: JSON.stringify({
            reason: "sha256_mismatch",
            detail: { declared: job.sha256, uploaded: uploaded.sha256 },
          }),
        })
        .where(eq(backupJobs.id, job.id)),
      audit(db, {
        eventType: "BACKUP_UPLOAD_FAILED",
        entityType: "backup_job",
        entityId: job.id,
        actor: { type: "device", id: device.id, tenantId: device.tenantId },
        before: { state: job.state },
        after: { state: "failed", reason: "sha256_mismatch" },
        correlationId: c.var.correlationId,
        source: "agent",
      }),
    ]);
    const [failedJob] = await db.select().from(backupJobs).where(eq(backupJobs.id, job.id));
    const [failedArtifact] = await db
      .select()
      .from(backupArtifacts)
      .where(eq(backupArtifacts.id, artifact.id));
    return c.json({
      job: toBackupJob(failedJob as BackupJobRow),
      artifact: toBackupArtifact(failedArtifact as BackupArtifactRow),
    });
  }

  await db.batch([
    db
      .update(backupArtifacts)
      .set({
        sizeBytes: uploaded.sizeBytes,
        sha256: uploaded.sha256,
        uploadedAt: now,
        verifiedAt: now,
      })
      .where(eq(backupArtifacts.id, artifact.id)),
    db
      .update(backupJobs)
      .set({ state: "cloud_verified", finishedAt: now })
      .where(eq(backupJobs.id, job.id)),
    audit(db, {
      eventType: "BACKUP_CLOUD_VERIFIED",
      entityType: "backup_job",
      entityId: job.id,
      actor: { type: "device", id: device.id, tenantId: device.tenantId },
      before: { state: job.state },
      after: { state: "cloud_verified", sizeBytes: uploaded.sizeBytes, sha256: uploaded.sha256 },
      correlationId: c.var.correlationId,
      source: "agent",
    }),
  ]);

  const [verifiedJob] = await db.select().from(backupJobs).where(eq(backupJobs.id, job.id));
  const [verifiedArtifact] = await db
    .select()
    .from(backupArtifacts)
    .where(eq(backupArtifacts.id, artifact.id));
  return c.json({
    job: toBackupJob(verifiedJob as BackupJobRow),
    artifact: toBackupArtifact(verifiedArtifact as BackupArtifactRow),
  });
});

backups.post(
  "/jobs/:id/upload/init",
  requireDevice(),
  zValidator("json", InitMultipartUploadRequest, (result, c) => {
    if (!result.success) return c.json({ error: "invalid_request" }, 400);
  }),
  async (c) => {
    const device = c.var.device;
    const db = createDb(c.env.DB);
    const job = await loadOwnJob(db, device, c.req.param("id"));
    if (!job) return c.json({ error: "not_found" }, 404);
    if (!UPLOADABLE_STATES.has(job.state)) {
      return c.json({ error: "invalid_state", detail: { state: job.state } }, 409);
    }

    const body = c.req.valid("json");
    const artifact = await getOrCreateArtifact(db, job);
    const multipart = await c.env.ARTIFACTS.createMultipartUpload(artifact.r2Key, {
      httpMetadata: { contentType: "application/octet-stream" },
    });

    await db.batch([
      db
        .update(backupArtifacts)
        .set({
          multipartUploadId: multipart.uploadId,
          encryptionJson: body.encryption !== undefined ? JSON.stringify(body.encryption) : null,
        })
        .where(eq(backupArtifacts.id, artifact.id)),
      db.update(backupJobs).set({ state: "upload_started" }).where(eq(backupJobs.id, job.id)),
    ]);

    return c.json({ artifactId: artifact.id, uploadId: multipart.uploadId, r2Key: artifact.r2Key });
  },
);

backups.put("/jobs/:id/upload/parts/:n", requireDevice(), async (c) => {
  const device = c.var.device;
  const db = createDb(c.env.DB);
  const job = await loadOwnJob(db, device, c.req.param("id"));
  if (!job) return c.json({ error: "not_found" }, 404);

  const partNumber = Number(c.req.param("n"));
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
    return c.json({ error: "invalid_request", detail: "partNumber must be 1..10000" }, 400);
  }

  const [artifact] = await db
    .select()
    .from(backupArtifacts)
    .where(eq(backupArtifacts.jobId, job.id));
  if (!artifact?.multipartUploadId) {
    return c.json({ error: "multipart_not_initialized" }, 409);
  }
  const body = c.req.raw.body;
  if (!body) return c.json({ error: "invalid_request", detail: "missing body" }, 400);

  const upload = c.env.ARTIFACTS.resumeMultipartUpload(artifact.r2Key, artifact.multipartUploadId);
  const buffer = await new Response(body).arrayBuffer();
  const part = await upload.uploadPart(partNumber, buffer);
  return c.json({ partNumber, etag: part.etag });
});

backups.post(
  "/jobs/:id/upload/complete",
  requireDevice(),
  zValidator("json", CompleteMultipartUploadRequest, (result, c) => {
    if (!result.success) return c.json({ error: "invalid_request" }, 400);
  }),
  async (c) => {
    const device = c.var.device;
    const db = createDb(c.env.DB);
    const job = await loadOwnJob(db, device, c.req.param("id"));
    if (!job) return c.json({ error: "not_found" }, 404);

    const [artifact] = await db
      .select()
      .from(backupArtifacts)
      .where(eq(backupArtifacts.jobId, job.id));
    if (!artifact?.multipartUploadId) {
      return c.json({ error: "multipart_not_initialized" }, 409);
    }

    const body = c.req.valid("json");
    const upload = c.env.ARTIFACTS.resumeMultipartUpload(
      artifact.r2Key,
      artifact.multipartUploadId,
    );
    await upload.complete(body.parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })));

    // R2 multipart complete() has no whole-object hash of its own (each part's ETag is not a
    // content hash of the assembled object), so verifying the declared sha256 means reading the
    // finished object back once (upload.ts's `hashExistingObject`; documented cost).
    const verification = await hashExistingObject(c.env.ARTIFACTS, artifact.r2Key);
    const now = nowIso();

    if (
      !verification ||
      verification.sha256 !== body.sha256 ||
      verification.sizeBytes !== body.sizeBytes
    ) {
      await c.env.ARTIFACTS.delete(artifact.r2Key);
      await db.batch([
        db
          .update(backupArtifacts)
          .set({
            sizeBytes: verification?.sizeBytes ?? null,
            sha256: verification?.sha256 ?? null,
            uploadedAt: now,
            deletedAt: now,
          })
          .where(eq(backupArtifacts.id, artifact.id)),
        db
          .update(backupJobs)
          .set({
            state: "failed",
            finishedAt: now,
            errorJson: JSON.stringify({
              reason: "sha256_mismatch",
              detail: { declared: body.sha256 },
            }),
          })
          .where(eq(backupJobs.id, job.id)),
        audit(db, {
          eventType: "BACKUP_UPLOAD_FAILED",
          entityType: "backup_job",
          entityId: job.id,
          actor: { type: "device", id: device.id, tenantId: device.tenantId },
          before: { state: job.state },
          after: { state: "failed", reason: "sha256_mismatch" },
          correlationId: c.var.correlationId,
          source: "agent",
        }),
      ]);
    } else {
      await db.batch([
        db
          .update(backupArtifacts)
          .set({
            sizeBytes: verification.sizeBytes,
            sha256: verification.sha256,
            uploadedAt: now,
            verifiedAt: now,
          })
          .where(eq(backupArtifacts.id, artifact.id)),
        db
          .update(backupJobs)
          .set({ state: "cloud_verified", finishedAt: now })
          .where(eq(backupJobs.id, job.id)),
        audit(db, {
          eventType: "BACKUP_CLOUD_VERIFIED",
          entityType: "backup_job",
          entityId: job.id,
          actor: { type: "device", id: device.id, tenantId: device.tenantId },
          before: { state: job.state },
          after: { state: "cloud_verified" },
          correlationId: c.var.correlationId,
          source: "agent",
        }),
      ]);
    }

    const [finalJob] = await db.select().from(backupJobs).where(eq(backupJobs.id, job.id));
    const [finalArtifact] = await db
      .select()
      .from(backupArtifacts)
      .where(eq(backupArtifacts.id, artifact.id));
    return c.json({
      job: toBackupJob(finalJob as BackupJobRow),
      artifact: toBackupArtifact(finalArtifact as BackupArtifactRow),
    });
  },
);

backups.get("/policy", requireDevice(), async (c) => {
  const db = createDb(c.env.DB);
  const policy = await getEffectivePolicy(db, c.var.device.tenantId);
  return c.json(policy);
});

backups.post(
  "/restore-tests",
  requirePermission("backup.restore"),
  zValidator("json", CreateRestoreTestRequest, (result, c) => {
    if (!result.success) return c.json({ error: "invalid_request" }, 400);
  }),
  async (c) => {
    const body = c.req.valid("json");
    const db = createDb(c.env.DB);

    const [deviceRow] = await db
      .select({ id: devices.id, tenantId: devices.tenantId })
      .from(devices)
      .where(and(eq(devices.id, body.deviceId), eq(devices.tenantId, body.tenantId)));
    if (!deviceRow) {
      return c.json({ error: "invalid_request", detail: "device not in tenant" }, 400);
    }
    const [artifactRow] = await db
      .select({ id: backupArtifacts.id, deviceId: backupJobs.deviceId })
      .from(backupArtifacts)
      .innerJoin(backupJobs, eq(backupJobs.id, backupArtifacts.jobId))
      .where(eq(backupArtifacts.id, body.artifactId));
    if (!artifactRow || artifactRow.deviceId !== body.deviceId) {
      return c.json({ error: "invalid_request", detail: "artifact not for device" }, 400);
    }

    const id = newId("restoreTest");
    const now = nowIso();
    const row = {
      id,
      tenantId: body.tenantId,
      deviceId: body.deviceId,
      artifactId: body.artifactId,
      performedBy: c.var.user.id,
      performedAt: now,
      outcome: body.outcome,
      notes: body.notes ?? null,
    };

    await db.batch([
      db.insert(restoreTests).values(row),
      audit(db, {
        eventType: "BACKUP_RESTORE_TEST_RECORDED",
        entityType: "device",
        entityId: body.deviceId,
        actor: { type: "user", id: c.var.user.id, tenantId: body.tenantId },
        before: null,
        after: { outcome: row.outcome, artifactId: row.artifactId },
        correlationId: c.var.correlationId,
        source: "api",
      }),
    ]);

    return c.json({ restoreTest: row }, 201);
  },
);

export default backups;

// ─── /api/v1/tenants/:tenantId/backup-policy ─────────────────────────────────────────────────

export const tenantBackupPolicy = new Hono<AppEnv>();

tenantBackupPolicy.get("/", requirePermission("backup.view"), async (c) => {
  const db = createDb(c.env.DB);
  const tenantId = c.req.param("tenantId") ?? "";
  const policy = await getEffectivePolicy(db, tenantId);
  return c.json({ policy });
});

tenantBackupPolicy.patch(
  "/",
  requirePermission("backup.restore"),
  zValidator("json", UpdateBackupPolicyRequest, (result, c) => {
    if (!result.success) return c.json({ error: "invalid_request" }, 400);
  }),
  async (c) => {
    const tenantId = c.req.param("tenantId") ?? "";
    const db = createDb(c.env.DB);

    const [tenantRow] = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    if (!tenantRow) return c.json({ error: "not_found" }, 404);

    const before = await getEffectivePolicy(db, tenantId);
    const body = c.req.valid("json");
    const merged = {
      frequentHours: body.frequentHours ?? before.frequentHours,
      dailyKeep: body.dailyKeep ?? before.dailyKeep,
      weeklyKeep: body.weeklyKeep ?? before.weeklyKeep,
      monthlyKeep: body.monthlyKeep ?? before.monthlyKeep,
      yearlyKeep: body.yearlyKeep ?? before.yearlyKeep,
      offsiteEnabled: body.offsiteEnabled ?? before.offsiteEnabled,
    };
    const now = nowIso();

    // Upsert: an explicit tenant policy either replaces its own row (a second edit) or is
    // created for the first time (before this call, the tenant was on the global default).
    await db
      .insert(backupPolicies)
      .values({ tenantId, ...merged, updatedBy: c.var.user.id, updatedAt: now })
      .onConflictDoUpdate({
        target: backupPolicies.tenantId,
        set: { ...merged, updatedBy: c.var.user.id, updatedAt: now },
      });

    const after = await getEffectivePolicy(db, tenantId);
    await audit(db, {
      eventType: "BACKUP_POLICY_UPDATED",
      entityType: "tenant",
      entityId: tenantId,
      actor: { type: "user", id: c.var.user.id, tenantId },
      before,
      after,
      correlationId: c.var.correlationId,
      source: "api",
    });

    return c.json({ policy: after });
  },
);

// ─── /api/v1/me/backups ───────────────────────────────────────────────────────────────────────

export const meBackups = new Hono<AppEnv>();

/** One correlated-subquery round trip (fast-data-hydration): latest non-failed job's start (the
 * "last local backup"), the latest job's own state, and the latest verified/live artifact's
 * upload time (the "last cloud backup") — one row per device the caller's tenant memberships
 * reach, no per-device follow-up query. */
meBackups.get("/", requireUser(), async (c) => {
  const db = createDb(c.env.DB);
  const membershipRows = await db
    .select({ tenantId: tenantMemberships.tenantId })
    .from(tenantMemberships)
    .where(
      and(eq(tenantMemberships.userId, c.var.user.id), eq(tenantMemberships.status, "active")),
    );
  const tenantIds = membershipRows.map((r) => r.tenantId);
  if (tenantIds.length === 0) return c.json({ items: [] });

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

  const rows = await db
    .select({
      deviceId: devices.id,
      deviceName: devices.name,
      lastLocalBackupAt,
      lastCloudBackupAt,
      state: latestState,
    })
    .from(devices)
    .where(inArray(devices.tenantId, tenantIds));

  return c.json({ items: rows });
});
