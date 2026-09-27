// Owner: WT-18. OTA release management (master spec §18, §45; Slices 10.1–10.4).
//
// The manifest's JOSE shape and its zod schema live in `@cloudbox/update-contracts` (the signer and
// the Windows updater's reference verifier); this file has its own lightweight mirror of the wire
// shapes admin-web and the device-facing API need, same convention as `entitlement.ts` next to
// `@cloudbox/licensing-contracts` ("keep both in step") — this package stays a browser-safe leaf
// with no dependency on `jose`.
import { z } from "zod";

export const ReleaseComponent = z.enum(["agent", "status", "setup", "connect"]);
export type ReleaseComponent = z.infer<typeof ReleaseComponent>;

export const ReleaseChannel = z.enum(["development", "pilot", "stable", "pinned"]);
export type ReleaseChannel = z.infer<typeof ReleaseChannel>;

export const ReleaseStatus = z.enum(["draft", "pilot", "stable", "withdrawn"]);
export type ReleaseStatus = z.infer<typeof ReleaseStatus>;

/** Required terminal states, master spec §45. */
export const ReleaseResultState = z.enum([
  "assigned",
  "downloaded",
  "verified",
  "installed_healthy",
  "installed_unhealthy",
  "rolled_back",
  "failed_download",
  "failed_validation",
  "deferred_active_users",
  "deferred_maintenance",
]);
export type ReleaseResultState = z.infer<typeof ReleaseResultState>;

export const AssignmentScope = z.enum(["device", "tenant", "fleet_percent"]);
export type AssignmentScope = z.infer<typeof AssignmentScope>;

/** SemVer 2.0.0 core + optional pre-release/build metadata. Mirrors `@cloudbox/update-contracts`. */
export const SemVer = z
  .string()
  .regex(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    "must be a semantic version, e.g. 1.4.2",
  );
export type SemVer = z.infer<typeof SemVer>;

export const ReleasePackageInfo = z.object({
  r2Key: z.string(),
  sha256: z.string(),
  sizeBytes: z.number().int(),
});
export type ReleasePackageInfo = z.infer<typeof ReleasePackageInfo>;

/** The signed manifest's payload, exactly as `@cloudbox/update-contracts` `ReleaseManifest` defines
 * it — this is what a device receives and verifies. */
export const ReleaseManifestWire = z.object({
  component: ReleaseComponent,
  version: SemVer,
  channel: ReleaseChannel,
  minAgentVersion: SemVer.nullable(),
  package: ReleasePackageInfo,
  rollbackOf: SemVer.nullable(),
  notes: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
});
export type ReleaseManifestWire = z.infer<typeof ReleaseManifestWire>;

/** Admin view of a release row (never the JWS itself — that is an implementation detail). */
export const Release = z.object({
  id: z.string(),
  component: ReleaseComponent,
  version: SemVer,
  channel: ReleaseChannel,
  status: ReleaseStatus,
  package: ReleasePackageInfo,
  minAgentVersion: SemVer.nullable(),
  rollbackOf: SemVer.nullable(),
  notes: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  promotedAt: z.string().nullable(),
  withdrawnAt: z.string().nullable(),
  withdrawReason: z.string().nullable(),
});
export type Release = z.infer<typeof Release>;

/** Never infer a successful rollout only from "downloaded" (spec §45): the list always carries the
 * full breakdown, not just a success/failure roll-up. */
export const ReleaseResultCounts = z.record(ReleaseResultState, z.number().int());
export type ReleaseResultCounts = z.infer<typeof ReleaseResultCounts>;

export const ReleaseListItem = Release.extend({
  resultCounts: ReleaseResultCounts,
  assignmentCount: z.number().int(),
});
export type ReleaseListItem = z.infer<typeof ReleaseListItem>;

export const ReleaseAssignment = z.object({
  id: z.string(),
  releaseId: z.string(),
  scope: AssignmentScope,
  deviceId: z.string().nullable(),
  deviceName: z.string().nullable(),
  tenantId: z.string().nullable(),
  tenantName: z.string().nullable(),
  percent: z.number().int().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
});
export type ReleaseAssignment = z.infer<typeof ReleaseAssignment>;

export const ReleaseResultRow = z.object({
  id: z.string(),
  releaseId: z.string(),
  deviceId: z.string(),
  deviceName: z.string(),
  state: ReleaseResultState,
  detail: z.unknown().nullable(),
  reportedAt: z.string(),
});
export type ReleaseResultRow = z.infer<typeof ReleaseResultRow>;

export const ReleaseDevicePickerItem = z.object({
  id: z.string(),
  name: z.string(),
  tenantId: z.string(),
  tenantName: z.string(),
});
export type ReleaseDevicePickerItem = z.infer<typeof ReleaseDevicePickerItem>;

export const ReleaseTenantPickerItem = z.object({
  id: z.string(),
  publicCode: z.string(),
  displayName: z.string(),
});
export type ReleaseTenantPickerItem = z.infer<typeof ReleaseTenantPickerItem>;

/** `GET /api/v1/screens/releases`. */
export const ReleasesScreen = z.object({
  serverTime: z.string(),
  items: z.array(ReleaseListItem),
  signingKeyConfigured: z.boolean(),
});
export type ReleasesScreen = z.infer<typeof ReleasesScreen>;

/** `GET /api/v1/screens/releases/:id`. */
export const ReleaseDetailScreen = z.object({
  serverTime: z.string(),
  release: ReleaseListItem,
  assignments: z.array(ReleaseAssignment),
  results: z.array(ReleaseResultRow),
  devices: z.array(ReleaseDevicePickerItem),
  tenants: z.array(ReleaseTenantPickerItem),
  signingKeyConfigured: z.boolean(),
});
export type ReleaseDetailScreen = z.infer<typeof ReleaseDetailScreen>;

/** Non-file fields of `POST /api/v1/releases` (multipart; the file itself is the `file` field). */
export const UploadReleaseFields = z.object({
  component: ReleaseComponent,
  version: SemVer,
  channel: ReleaseChannel,
  minAgentVersion: SemVer.optional(),
  rollbackOf: SemVer.optional(),
  notes: z.string().trim().max(4000).optional(),
});
export type UploadReleaseFields = z.infer<typeof UploadReleaseFields>;

/** `POST /api/v1/releases/:id/promote`. */
export const PromoteReleaseRequest = z.object({ channel: ReleaseChannel });
export type PromoteReleaseRequest = z.infer<typeof PromoteReleaseRequest>;

/** `POST /api/v1/releases/:id/withdraw`: the reason is typed by the operator and audited. */
export const WithdrawReleaseRequest = z.object({
  reason: z.string().trim().min(3).max(500),
});
export type WithdrawReleaseRequest = z.infer<typeof WithdrawReleaseRequest>;

/** `POST /api/v1/releases/:id/assignments`. Exactly one of `deviceId`/`tenantId`/`percent` applies,
 * matching `scope` — enforced by the API (a cross-field zod `.refine` here would duplicate that). */
export const CreateAssignmentRequest = z.object({
  scope: AssignmentScope,
  deviceId: z.string().optional(),
  tenantId: z.string().optional(),
  percent: z.number().int().min(1).max(100).optional(),
});
export type CreateAssignmentRequest = z.infer<typeof CreateAssignmentRequest>;

/** `POST /api/v1/releases/:id/result` (device token). */
export const ReportReleaseResultRequest = z.object({
  state: ReleaseResultState,
  detail: z.unknown().optional(),
});
export type ReportReleaseResultRequest = z.infer<typeof ReportReleaseResultRequest>;

/** `GET /api/v1/releases/assigned` (device token): the highest applicable release, signed. */
export const AssignedReleaseResponse = z.object({
  releaseId: z.string(),
  manifest: ReleaseManifestWire,
  manifestJws: z.string(),
  downloadUrl: z.string(),
  downloadExpiresAt: z.string(),
});
export type AssignedReleaseResponse = z.infer<typeof AssignedReleaseResponse>;
