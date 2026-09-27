# Runbook: Update and Rollback

**Owner:** WT-18 (cloud side, this document). The local transactional updater (download → verify →
stage → install → health-check → commit/rollback, Slices 10.5–10.7) is a **later slice**; its
"Local device procedure" section below states the contract it must meet, not what it does yet.
**Phase:** 10
**Status:** Cloud side implemented. Local updater not yet built.

## Purpose

Guide for performing OTA updates to CloudBox components and rolling back if needed.

## Prerequisites

- `RELEASE_SIGNING_JWK` configured (`docs/runbooks/release-key-rotation.md`) — without it, upload answers `503 signing_key_unavailable`.
- The uploader holds `update.release` (upload/promote/withdraw) or `update.deploy` (assignments); `update.view` is enough to watch the Updates screen.

## Procedure (cloud side, as built)

### 1. Upload a release

`POST /api/v1/releases` (multipart: `file`, `component`, `version`, `channel`, `notes?`, `minAgentVersion?`, `rollbackOf?`) or Updates → **Upload release** in the console.

- The Worker streams the file into R2 under a server-generated key (`releases/<component>/<version>/<file>`), hashing it (SHA-256) in the same pass — the object is never buffered twice.
- 413 if the request's `Content-Length` already exceeds 200 MB, or if the parsed file's own size does (double-checked: multipart bodies are materialised by the platform regardless, see ADR 0012/slice doc "Deviations" — nothing here trusts `Content-Length` alone).
- 409 `version_exists` if that `component`+`version` was already uploaded.
- The manifest (component, version, channel, package hash/size, minimum Agent version, rollback-of, notes, uploader, timestamp) is signed ES256 and stored; the release starts `status='draft'`.

### 2. Promote through channels

`POST /api/v1/releases/:id/promote {channel}`.

- `draft` → `pilot`: no gate.
- `pilot` → `stable`: refused (`409 health_gate_failed`) unless ≥1 device has reported `installed_healthy` and 0 have reported `installed_unhealthy`/`rolled_back` for this release (`GET /api/v1/screens/releases/:id` shows the exact counts).
- `stable` ↔ `pinned` (same `channel` field, `status` stays `stable`): no gate; pinning removes it from the broadcast default without invalidating it.
- Any transition on a `withdrawn` release, or `draft` → `stable` directly: refused.

### 3. Assign a cohort (Pilot rollout, Slice 10.4)

`POST /api/v1/releases/:id/assignments {scope, deviceId | tenantId | percent}`.

- `scope: "device"` — always allowed, even on a `draft` release (the spec's "Internal lab" stage).
- `scope: "tenant"` / `"fleet_percent"` — refused (`409 release_not_released`) on a `draft` release; the release must be at least `pilot`.
- `fleet_percent` buckets devices deterministically by a stable hash of the device id (0–99); raising the percentage only ever adds devices, never removes any that were already in.
- `DELETE /api/v1/releases/:id/assignments/:assignmentId` removes one.

### 4. Withdraw (rollback trigger)

`POST /api/v1/releases/:id/withdraw {reason}` (3–500 chars, required). Terminal: the release is excluded from every resolution path (device/tenant/percent assignment and the channel default alike) from that point on, even for a device that already had an explicit assignment to it. It cannot be re-promoted or re-assigned.

### 5. Local device procedure (contract for the later slice)

The Windows updater must, on its own schedule, per component it manages:

1. `GET /api/v1/releases/assigned?component=<agent|status|setup|connect>` with its device Bearer token.
2. 404 means "nothing applies" — stop, nothing to do.
3. 200 returns `{releaseId, manifest, manifestJws, downloadUrl, downloadExpiresAt}`. Verify `manifestJws` against the pinned CloudBox release-signing public key(s) (same package `@cloudbox/update-contracts`'s test vector the .NET verifier is built against) before trusting anything in `manifest`.
4. Download from `downloadUrl` before `downloadExpiresAt` (~15 minutes; re-fetch `/assigned` for a fresh URL if it lapses) and verify the downloaded bytes' SHA-256 against `manifest.package.sha256`.
5. Stage, check maintenance conditions (active RDP sessions, backup activity, reboot requirements, maintenance window — spec §18.5), install, restart, health-check.
6. `POST /api/v1/releases/:id/result {state, detail?}` with exactly one of the ten §45 states: `assigned`, `downloaded`, `verified`, `installed_healthy`, `installed_unhealthy`, `rolled_back`, `failed_download`, `failed_validation`, `deferred_active_users`, `deferred_maintenance`.
7. On a failed post-update health check: roll back to the previous known-good package locally (kept until the new one passes health checks, spec §18.6) and report `rolled_back`, not `installed_unhealthy` (the two states are both refused by the health gate, but they mean different things to an operator reading the Updates screen).

## Troubleshooting (cloud side)

| Symptom | Cause | Fix |
|---|---|---|
| Upload answers `503 signing_key_unavailable` | `RELEASE_SIGNING_JWK` missing/invalid | `docs/runbooks/release-key-rotation.md` step 1 |
| Upload answers `409 version_exists` | Same component+version already uploaded | Bump the version, even for a re-upload of the same bytes |
| Promote answers `409 health_gate_failed` | No `installed_healthy` yet, or an unhealthy/rolled-back result is present | Wait for Pilot devices to report, or fix the regression and upload a new version |
| A device's `GET /assigned` never changes | No `stable` release for that component, and no explicit assignment reaches the device | Check `GET /api/v1/screens/releases/:id`'s assignments and channel for that component |
| Assignment answers `409 release_not_released` | Tried a tenant/percent scope on a still-`draft` release | Promote to `pilot` first, or use a device-scope assignment for lab testing |

## References

- Spec Section 18: OTA / self-update system; §18.3 package security; §18.5 update safety; §18.6 rollback; §18.7 forced updates
- Spec §45: Update Dashboard
- `docs/slices/10.1-10.4-releases.md`, ADR 0012, `docs/handoffs/wt-p10-releases.md`
