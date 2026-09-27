// Owner: WT-19. Backup job state machine (master spec §23.8 "backup success is not upload
// success"). Pure and synchronous so it is trivially unit-testable and reused by every route that
// transitions a job.
import type { BackupJobState } from "@cloudbox/contracts";

/**
 * Transitions a client may request directly (`PATCH /api/v1/backups/jobs/:id`). `upload_started`
 * is also reachable this way so a device can mark intent before either upload endpoint runs.
 * `upload_completed`, `cloud_verified` and `retention_applied` are never in this map — they are
 * set only by the upload endpoints and the retention sweep, which have independently verified the
 * fact (a real R2 object, a real hash match, a real sweep pass), never accepted as a claim.
 */
const CLIENT_TRANSITIONS: Record<BackupJobState, ReadonlySet<BackupJobState>> = {
  created: new Set(["verified_local", "failed"]),
  verified_local: new Set(["upload_started", "failed"]),
  upload_started: new Set(["failed"]),
  upload_completed: new Set(["failed"]),
  cloud_verified: new Set(),
  retention_applied: new Set(),
  failed: new Set(),
};

/**
 * Transitions the server itself may apply (upload endpoints, retention sweep) regardless of the
 * client-facing map above — e.g. a raw upload can move `verified_local` straight to
 * `upload_started` then `cloud_verified` in one request, or fail from any non-terminal state.
 */
const SERVER_TRANSITIONS: Record<BackupJobState, ReadonlySet<BackupJobState>> = {
  created: new Set(["upload_started", "failed"]),
  verified_local: new Set(["upload_started", "failed"]),
  upload_started: new Set(["upload_completed", "cloud_verified", "failed"]),
  upload_completed: new Set(["cloud_verified", "failed"]),
  cloud_verified: new Set(["retention_applied"]),
  retention_applied: new Set(["retention_applied"]),
  failed: new Set(),
};

export function isValidClientTransition(from: BackupJobState, to: BackupJobState): boolean {
  return CLIENT_TRANSITIONS[from]?.has(to) ?? false;
}

export function isValidServerTransition(from: BackupJobState, to: BackupJobState): boolean {
  return SERVER_TRANSITIONS[from]?.has(to) ?? false;
}

/** True once a job cannot transition anywhere else (a new job must be created to retry). */
export function isTerminal(state: BackupJobState): boolean {
  return state === "failed" || state === "retention_applied";
}
