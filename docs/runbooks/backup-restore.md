# Runbook: Backup and Restore

**Owner:** WT-19 (Phase 9, cloud side)
**Phase:** Phase 9
**Status:** Cloud side (Slices 9.3-9.5) built. Windows-side (9.1, 9.2, 9.6) not yet implemented —
steps below note which half each covers.

## Purpose

Guide for performing application-consistent backups and verified restore procedures.

## Prerequisites

- CloudBox device operational and licensed
- Separate local backup target available (optional but recommended)
- Offsite storage configured and reachable

## Procedure

### 1. Initiate backup

- **Windows side (not built):** manual trigger via Device → Backups tab, or a scheduled automatic
  backup on the tenant's policy cadence (`frequentHours`); capture application state through the
  application's own supported backup mechanism, never a raw file copy.
- **Cloud side (built):** the Agent reports the attempt with
  `POST /api/v1/backups/jobs {kind, sourceDataset, appVersion?, localPathHint?}` → `201` in state
  `created`.

### 2. Verify backup (local, then cloud)

- **Local verification (Windows side, not built):** the Agent confirms the local artifact is
  intact and computes its sha256 + size.
- **Report local verification (cloud side, built):**
  `PATCH /api/v1/backups/jobs/:id {state: "verified_local", sha256, sizeBytes}`.
- **Upload and cloud verification (cloud side, built):** raw single-shot
  (`POST /api/v1/backups/jobs/:id/upload`, ≤5 GiB) or resumable multipart
  (`.../upload/init` → `.../upload/parts/:n` → `.../upload/complete`). The server recomputes the
  hash while streaming (or, for multipart, by reading the assembled object back once) and compares
  it to the declared value: a match moves the job to `cloud_verified`; a mismatch moves it to
  `failed` with `error.reason = "sha256_mismatch"` and deletes the bad R2 object.
- **Retention (cloud side, built):** a daily Cron sweep (`src/scheduled.ts` →
  `runBackupRetentionSweep`) classifies every live artifact into `recent`/`daily`/`weekly`/
  `monthly`/`yearly` per the tenant's policy (`GET`/`PATCH /api/v1/tenants/:id/backup-policy`) and
  deletes whatever has expired — except the single newest `cloud_verified` artifact per device,
  which is never deleted regardless of policy. Every deletion is audited
  (`BACKUP_RETENTION_APPLIED`).

### 3. Restore from backup

- **Windows side (not built, Slice 9.6):** select a restore point, show its exact metadata, warn
  about replacing current data, require a fresh step-up for the operator, snapshot current state
  first, then restore to a controlled location (never overwrite live data automatically).
- **Cloud side today:** staff can browse a device's backup history (jobs, artifacts, retention
  state) in the Backups dashboard's history drawer (`GET /api/v1/screens/backups/:deviceId`) to
  choose which artifact a restore should use.

### 4. Verify restore with business application

- Open the application with restored data; confirm data integrity (sample records, calculations,
  reports).
- **Record the result** (cloud side, built, staff-only for now):
  `POST /api/v1/backups/restore-tests {tenantId, deviceId, artifactId, outcome, notes?}`. The
  dashboard flags a device whose most recent restore test is missing or more than 90 days old
  (§23.9 "a backup that has never been restored is unproven").

## Troubleshooting

- **Backup job stuck in `created`:** the Agent has not yet called `PATCH .../jobs/:id` with
  `verified_local` — check disk space, Agent logs, network connectivity on the device.
- **Upload returns `409 invalid_state`:** the job hasn't reached `verified_local` yet, or is
  already terminal (`failed`/`retention_applied`) — a new job is required to retry from scratch.
- **Upload returns `413 artifact_too_large`:** the artifact exceeds the 5 GiB single-shot cap; use
  the resumable multipart flow instead.
- **Job `failed` with `sha256_mismatch`:** the bytes that reached R2 did not match what the Agent
  declared locally — re-run the local backup and retry the upload; the bad object is already
  deleted server-side.
- **Dashboard shows "Overdue":** no verified cloud backup within the exception window (48h) — check
  the device's connectivity and its most recent job's `error` field.
- **Restore failed:** verify the chosen artifact's `verifiedAt`/`deletedAt` in the history drawer
  before restoring — a `deletedAt` artifact was already retired by policy or a failed upload.

## References

- Spec §23 (all subsections) — business application backup strategy
- Spec §24 — storage and disk health
- Spec §46 — backup dashboard
- Spec §56, Phase 9, Slices 9.1-9.6
- `docs/slices/9.3-9.5-backups-cloud.md`, `docs/handoffs/wt-p9-backups-cloud.md`
