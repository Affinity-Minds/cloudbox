# CloudBox Backup and Restore Runbook

Cloud-side implementation status: **built** (WT-19, Slices 9.3-9.5). Windows-side implementation
(Slices 9.1 local application-consistent backup, 9.2 separate local target, 9.6 guided restore) is
**not built yet** — this doc describes the contract the Agent must satisfy once it lands, and the
cloud API/dashboard/retention that already exists to receive it.

- **Full Backup/Restore Runbook:** [docs/runbooks/backup-restore.md](runbooks/backup-restore.md)
- **Backup System Specification:** spec §23 (all subsections), §24, §46; Slices 9.1-9.6 (§56)
- **Slice doc (cloud):** [docs/slices/9.3-9.5-backups-cloud.md](slices/9.3-9.5-backups-cloud.md)
- **Handoff:** [docs/handoffs/wt-p9-backups-cloud.md](handoffs/wt-p9-backups-cloud.md)

## Overview

CloudBox performs application-consistent backups of customer business-application data (§23.2 —
never a live-folder sync) and maintains local + offsite redundancy (§23.3 3-2-1 baseline). The
cloud side tracks every backup as a **job** (local metadata) and, once uploaded, an **artifact**
(the R2 object's own state) — §23.8 "backup success is not upload success" is enforced as a real
state machine, not inferred from a file existing.

## What the Agent must do (Slices 9.1/9.2/9.6 — not yet built; contract only)

1. **Local backup (9.1).** Produce an application-consistent backup artifact using the
   application's own supported backup mechanism (never a raw copy of open files). Compute its
   `sha256` and byte size locally.
2. **Report the job.** `POST /api/v1/backups/jobs` (device Bearer token) with
   `{kind, sourceDataset, appVersion?, localPathHint?}` → `201 {job}` in state `created`.
3. **Mark it verified locally.** `PATCH /api/v1/backups/jobs/:id`
   `{state: "verified_local", sha256, sizeBytes}` once the local artifact is confirmed intact.
   This is a hard requirement of the state machine (`src/backups/state-machine.ts`): the upload
   endpoints refuse a job that has not reached `verified_local` first.
4. **Upload after local completion only** (§23.5 Layer C, §23.6):
   - **Small artifacts (≤5 GiB):** `POST /api/v1/backups/jobs/:id/upload` with the raw bytes as
     the body. The server recomputes the sha256 while streaming to R2 and compares it to the
     declared one, moving the job to `cloud_verified` on a match or `failed` (reason
     `sha256_mismatch`) otherwise — the bad object is deleted, never left half-verified.
   - **Larger artifacts, or resumable uploads:** `POST /api/v1/backups/jobs/:id/upload/init`
     `{sizeBytes, encryption?}` → `{artifactId, uploadId, r2Key}`, then
     `PUT /api/v1/backups/jobs/:id/upload/parts/:n` (raw bytes of part `n`) → `{partNumber, etag}`
     for each part (track every returned `etag`), then
     `POST /api/v1/backups/jobs/:id/upload/complete` `{parts, sha256, sizeBytes}` to finish. The
     server verifies the assembled object's hash by reading it back once.
5. **Retention is a cloud-only concern.** The Agent never deletes offsite artifacts itself; the
   cloud's Cron-driven retention sweep (`src/backups/retention.ts`) does that, server-side and
   audited (§23.7). `GET /api/v1/backups/policy` returns the device's effective policy (tenant
   override, or the global default) if the Agent wants to show it locally.
6. **Guided restore (9.6)** is Windows-side, not built by this slice. The cloud side already
   records restore drills (`POST /api/v1/backups/restore-tests`, staff-only today) so §23.9's
   "a backup that has never been restored is unproven" has somewhere to report to once a guided
   restore flow exists.

## What the cloud side already does (built, WT-19)

- **Tables** (migration `0017`): `backup_policies`, `backup_jobs`, `backup_artifacts`,
  `restore_tests`. See the slice doc for full column lists.
- **Device API** (`src/routes/v1/backups.ts`, Bearer `requireDevice()`): job create/patch, both
  upload flows, effective policy read. Device-scoped: a device can only read or modify its own
  jobs (404, not 403, for anything else — never confirms another device's job exists).
- **Retention engine** (`src/backups/retention.ts`): grandfather-father-son rotation (recent →
  daily → weekly → monthly → yearly), Cron-driven (`src/scheduled.ts`, daily), audited
  `BACKUP_RETENTION_APPLIED`. The single newest `cloud_verified` artifact per device is never
  deleted, regardless of policy.
- **Staff dashboard** (`GET /api/v1/screens/backups`, `admin-web` "Backups" page): exception
  counts (devices protected/overdue, failed jobs last 24h, restore verification overdue), primary
  table (§46), per-device history drawer with a retention-policy editor and a restore-test log.
- **Customer portal read**: `GET /api/v1/me/backups` — the signed-in user's own tenant(s), last
  local/cloud backup time and state, read-only.

## Disaster recovery checklist (unchanged intent, once 9.1/9.2/9.6 land)

1. Install CloudBox on replacement hardware.
2. Enroll device to same tenant.
3. Verify entitlements issued.
4. Restore latest backup via Device → Backups → Restore (Windows-side, not built).
5. Record the outcome as a restore test so the dashboard reflects it (staff can do this today via
   `POST /api/v1/backups/restore-tests` even without a guided UI flow).
6. Verify application and data integrity; resume operations.
