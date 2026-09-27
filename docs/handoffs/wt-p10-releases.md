# Handoff: wt-p10-releases

## Mission

**Slices:** 10.1–10.4 (OTA release management, cloud side)

**Success criterion:** Staff can upload a signed release package, promote it through
draft → pilot → stable (with a health gate before stable) or withdraw it, and target it at a
device, tenant, or fleet percentage. Devices (WT-3's `requireDevice()`-gated Bearer auth) can
discover the release assigned to them, download the package through a short-lived signed URL, and
report install results. Everything server-authoritative: manifests are signed with the release's
own signing key (never the entitlement key), download URLs are HMAC-scoped to one device/release
pair and expire in 15 minutes, and a device only ever sees the release it is actually assigned or
entitled to via channel default — never the full catalog.

---

## Current status

- Branch: `wt/p10-releases`
- Parent: `phase-2/devices`
- Implementation phase: Phase 10 (OTA release management)
- Commits: 0 since fork at time of writing — all 33 files are uncommitted work carried over from
  an agent session that crashed after verification finished green. This handoff records that
  verified state before committing.
- Gate status: see "Tests run and results" below — recorded per-stage at commit time.

---

## Commits ready for merge

Not yet committed as of this handoff. To be split into 2–3 logical commits (contracts/migration,
worker-api implementation + tests, admin-web UI + docs) once the gate below is re-run clean in
this session.

---

## Files and contracts changed

- **New package:** `packages/update-contracts` — release-manifest signing/verification, isolated
  from `@cloudbox/contracts` and from the entitlement signer. Exports manifest build/verify
  helpers, `parseReleaseSigningSecret`, and the `generate-signing-key` / `make-test-vector`
  scripts.
- **Contracts:** `packages/contracts/src/releases.ts` (new) — `UploadReleaseFields`,
  `PromoteReleaseRequest`, `WithdrawReleaseRequest`, `CreateAssignmentRequest`,
  `ReportReleaseResultRequest`, `ReleaseComponent`, screen types (`ReleasesScreen`,
  `ReleaseDetailScreen`, `ReleaseListItem`). Small additions to `packages/contracts/src/common.ts`
  and a re-export line in `packages/contracts/src/index.ts`.
- **Migration:** `infra/cloudflare/migrations/0016_releases_ota.sql` (+ matching
  `meta/_journal.json` entry and `meta/0004_snapshot.json`). Adds three tables (`releases`,
  `release_assignments`, `release_results`) and an `ALTER TABLE signing_keys ADD purpose` column
  with a trigger-enforced CHECK (`'entitlement' | 'release'`), since D1/SQLite cannot pair
  `ADD COLUMN` with an inline CHECK.
- **Database schema:** `apps/worker-api/src/db/schema.ts` — Drizzle definitions for the three new
  tables plus the `signing_keys.purpose` column, matching the migration.
- **Worker-api implementation:** `apps/worker-api/src/releases/` (new directory) — `service.ts`
  (create/promote/withdraw + `ReleaseRefusal`), `assignments.ts` (create/delete/list +
  `AssignmentRefusal`), `resolve.ts` (assignment-resolution precedence for device-facing lookup),
  `results.ts` (record device-reported install result), `upload.ts` (streaming R2 store + sha256,
  `MAX_PACKAGE_BYTES` cap), `download-token.ts` (HMAC-signed short-lived download URL),
  `signing-key.ts` (`ensureReleaseSigningKey`, `releaseSigningKeyConfigured`).
- **Routes:** `apps/worker-api/src/routes/v1/releases.ts` (new, mounted at `/api/v1/releases` in
  `routes/v1/index.ts`) and `apps/worker-api/src/routes/v1/screens/releases.ts` (new, mounted at
  `/api/v1/screens/releases` in `routes/v1/screens/index.ts`).
- **Config:** `apps/worker-api/src/env.ts` adds `RELEASE_SIGNING_JWK?: string` (its own binding,
  deliberately separate from `ENTITLEMENT_SIGNING_JWK`). `apps/worker-api/package.json` adds the
  `@cloudbox/update-contracts` workspace dependency. `apps/worker-api/tsconfig.json` picks up the
  new package's path.
- **Admin-web:** `apps/admin-web/src/routes/_app/updates.tsx` (new page — table + upload/promote/
  withdraw/assign dialogs + detail sheet), `apps/admin-web/src/api/releases.ts` (new — query/
  mutation functions), `apps/admin-web/src/components/release-bits.tsx` (new — shared pills/badges),
  one line each in `apps/admin-web/src/nav.ts` (adds `updates` nav key/route, `RefreshCw` icon) and
  the generated `apps/admin-web/src/routeTree.gen.ts`.
- **Test allowlist entries** (routes intentionally exempted from staff-session assumptions because
  they carry WT-3's device-Bearer auth on the same router as this slice's staff routes):
  - `apps/worker-api/test/permission-matrix.test.ts` — `DEVICE_BEARER_ROUTES` set:
    `/api/v1/releases/assigned`, `/api/v1/releases/:id/download`, `/api/v1/releases/:id/result`.
  - `apps/worker-api/test/review/phase-1-second-pass.test.ts` — `DEVICE_ONLY` set, same three
    paths, exempted from the S-6 "every route answers `setup_required` mid-setup" sweep.
- **Docs:** `docs/decisions/0012-release-manifest-format.md` (ADR), `docs/slices/10.1-10.4-releases.md`,
  `docs/runbooks/release-key-rotation.md`, two new entries in `docs/ISSUE_LOG.md` (Workers
  `DigestStream` global-vs-property trap; `Uint8Array<ArrayBufferLike>` vs `BufferSource` typing
  trap), plus edits to `docs/UPDATE_RUNBOOK.md` and `docs/runbooks/update-rollback.md` and a
  one-line fix in `tests/e2e-cloud/tests/smoke.spec.ts`.
- **Evidence:** `docs/evidence/wt-p10-releases/*.png` (13 screenshots, see below).

---

## Migrations

- **Reserved number:** 0016
- **Filename:** `infra/cloudflare/migrations/0016_releases_ota.sql`
- **Applied locally:** yes — `apps/worker-api/test/releases.test.ts` runs against the migrated
  local D1 (`test/apply-migrations.ts` harness), all cases pass.

---

## API changes

Owner: WT-18. Mounted at `/api/v1/releases` (`routes/v1/index.ts`). Middleware is per-route, never
`use("*")` on the router's own prefix, because two very different callers share it: staff routes
(`requirePermission`) and device-facing manifest routes (`requireDevice()`, WT-3).

| Method | Path | Auth | Permission | Request | Response | Notes |
|---|---|---|---|---|---|---|
| POST | `/api/v1/releases` | staff session | `update.release` | multipart: file + `UploadReleaseFields` | `{ release }` (201) | Streams into R2, computes sha256, signs manifest with `RELEASE_SIGNING_JWK`. 413 if `Content-Length` exceeds `MAX_PACKAGE_BYTES` pre-parse; 400 invalid fields/empty file; 409 duplicate component+version; 503 `signing_key_unavailable`/`_retired`/`_mismatch` |
| POST | `/api/v1/releases/:id/promote` | staff session | `update.release` | `PromoteReleaseRequest` (`{ channel }`) | `{ release }` | draft→pilot: no gate. pilot→stable: health gate (≥1 `installed_healthy`, 0 `installed_unhealthy`/`rolled_back`). draft→stable direct, or any promote on a withdrawn release: refused |
| POST | `/api/v1/releases/:id/withdraw` | staff session | `update.release` | `WithdrawReleaseRequest` (`{ reason }`) | `{ release }` | |
| GET | `/api/v1/releases/:id/assignments` | staff session | `update.deploy` | — | `{ items }` | |
| POST | `/api/v1/releases/:id/assignments` | staff session | `update.deploy` | `CreateAssignmentRequest` (`scope`, `deviceId`/`tenantId`/`percent`) | `{ assignment }` (201) | `device`/`tenant`/`fleet_percent` scopes; a draft release cannot take a tenant or percent assignment |
| DELETE | `/api/v1/releases/:id/assignments/:assignmentId` | staff session | `update.deploy` | — | 204 | |
| GET | `/api/v1/releases/assigned` | device Bearer (`requireDevice()`) | — | query: `{ component }` | `{ releaseId, manifest, manifestJws, downloadUrl, downloadExpiresAt }` or 404 | Resolution precedence: device assignment > tenant assignment > fleet-percent assignment > channel default (newest `channel='stable'`). `Cache-Control: no-store` |
| GET | `/api/v1/releases/:id/download` | device Bearer + HMAC token (`exp`, `token` query params) | — | — | package bytes (`application/octet-stream`) | 401 on tampered/expired token; 404 if release withdrawn or object missing |
| POST | `/api/v1/releases/:id/result` | device Bearer | — | `ReportReleaseResultRequest` (`state`, optional `detail`) | result record (201) | States: `assigned, downloaded, verified, installed_healthy, installed_unhealthy, rolled_back, failed_download, failed_validation, deferred_active_users, deferred_maintenance` |
| GET | `/api/v1/screens/releases` | staff session | (screen-level) | — | `ReleasesScreen` | List with per-release result-state counts and assignment counts, one `db.batch()` round trip |
| GET | `/api/v1/screens/releases/:id` | staff session | (screen-level) | — | `ReleaseDetailScreen` or 404 | |

Every route above (except `/assigned`, `/:id/download`, `/:id/result`, which are device-Bearer) is
covered by the standard staff-session/permission-matrix and setup-gate sweeps; the three
device-Bearer paths are allowlisted in both sweeps with the rationale recorded in-file (see "Test
allowlist entries" above) and exercised instead by `test/releases.test.ts`.

---

## Security assumptions

- **Manifests are signed, not just checksummed.** Each release's manifest (`manifest_json`) is
  signed as a JWS (`manifest_jws`) with `RELEASE_SIGNING_JWK`, an EC P-256 key with its own `kid`
  and `alg: "ES256"` — a **separate** key from `ENTITLEMENT_SIGNING_JWK` (ADR 0012: never reuse the
  entitlement signer for releases). The public half is persisted to `signing_keys` with the new
  `purpose` column (`'entitlement' | 'release'`, trigger-enforced CHECK since D1 can't pair
  `ADD COLUMN` with an inline CHECK). `ensureReleaseSigningKey` refuses to sign if the row is
  `retired` (`503 signing_key_retired`) or belongs to the other purpose or mismatched key material
  (`503 signing_key_mismatch`); the Worker never reads a private key back out of D1.
- **Download URLs are short-lived and HMAC-scoped, not genuine R2 presigned URLs.** Real R2
  presigned URLs need the S3-compatible API with access-key credentials, not provisioned for this
  slice (only the `ARTIFACTS` binding). Instead, `download-token.ts` derives an HMAC-SHA256 key
  from the private scalar (`d`) of `RELEASE_SIGNING_JWK` and signs `releaseId:deviceId:exp`
  (15-minute TTL). The download route re-verifies the device's Bearer token independently, so this
  is defence in depth, not the only gate.
- **A device only ever sees what it is actually entitled to.** `GET /assigned` resolves by
  precedence — device assignment > tenant assignment > fleet-percent assignment (deterministic
  bucketing, tested for `[0,100)` range) > channel default (newest `stable` release) — and never
  returns a pilot-only release to a device with no assignment (returns 404, not the pilot release).
  A draft release cannot receive a tenant or percent assignment (device-only, since draft is
  explicitly not for fleet rollout).
- **Promotion has a real health gate, not just an admin click.** pilot → stable requires ≥1
  `installed_healthy` result and 0 `installed_unhealthy`/`rolled_back` results; draft → stable
  directly is refused (must go through pilot); any promote on a withdrawn release is refused.
- **Server enforces all permission checks; UI hints are not sufficient.** `update.release` gates
  upload/promote/withdraw; `update.deploy` gates assignment create/delete/list — verified by
  `permission-matrix.test.ts`'s "403s update.release/update.deploy actions for support and
  read_only, but allows update.view" and "allows admin the same as super_admin" cases, and by
  `releases.test.ts`'s own permission-boundary describe block (a device Bearer token cannot promote
  a release; every staff route 401s without a session).

---

## Tests run and results

Verified green in the crashed session per the task brief (696 worker tests, update-contracts 13,
build ok); **re-run in this session before commit** — see the gate output captured below at commit
time.

### Test coverage

- `apps/worker-api/test/releases.test.ts` — 25 cases across six describe blocks:
  - **upload (7):** stores in R2 + computes sha256 + signs a verifiable manifest; 503 when
    `RELEASE_SIGNING_JWK` unset; 409 duplicate component+version; 400 invalid semver (no R2 touch);
    413 when `Content-Length` already exceeds the cap; refuses an oversized package at the storage
    layer (unit test, no real 200MB body); refuses an empty file.
  - **permission boundaries (4):** 401s every staff route without a session; 403s
    update.release/update.deploy for support/read_only but allows update.view; admin == super_admin
    for upload/promote/withdraw/assignments; a device Bearer token cannot promote (no staff
    session).
  - **promotion (4):** draft→pilot needs no gate, pilot→stable needs a health gate; passes the gate
    with ≥1 `installed_healthy` and 0 unhealthy/rolled_back; refuses the gate when an
    `installed_unhealthy` result is also present; refuses draft→stable directly and any promote on
    a withdrawn release.
  - **assignment resolution (6):** `percentBucket` deterministic and in `[0,100)`; a device with no
    assignment gets the channel default; does not see a pilot-only release with no assignment (404,
    not the pilot release); a device assignment on a draft release wins over everything; a tenant
    assignment beats the channel default but loses to a device assignment; cannot assign a
    tenant/percent scope to a draft release.
  - **results and screens (2):** records a device-reported result and reflects it in the release
    list's counts; a device token cannot record a result without a valid Bearer.
  - **download (2):** streams package bytes for a valid, unexpired token; 401s a tampered or
    expired token.
- `packages/update-contracts/test/manifest.test.ts` + `test/vector.test.ts` — manifest build/verify
  and a fixed test vector (`test/vectors/v1.json`) for cross-version format stability.
- Permission/setup-gate sweeps: `permission-matrix.test.ts` and
  `test/review/phase-1-second-pass.test.ts` updated with allowlist entries for the three
  device-Bearer routes (see "API changes" above); no new failures introduced in either sweep.

### Demo path

```
1. Sign in to admin-web as staff with update.release + update.deploy (e.g. super_admin).
2. Open /updates — empty state if no releases exist yet.
3. Click Upload; pick a component (agent/status/setup/connect), a semver version, a channel
   (development/pilot/stable/pinned), and a package file. Submit.
4. New release appears in the list with status "draft". Open its detail sheet.
5. Click Promote → Pilot. Status changes to "pilot".
6. Click Assign; create a device or tenant assignment (or leave unassigned to rely on channel
   default once a release reaches stable).
7. As a device (Bearer token), GET /api/v1/releases/assigned?component=agent — confirm the
   assigned release, its signed manifest, and a downloadUrl are returned.
8. POST /api/v1/releases/:id/result with state "installed_healthy" from that device.
9. Back in admin-web, detail sheet's result counts reflect the report.
10. Click Promote → Stable — succeeds now that a healthy result exists.
11. (Not yet captured in evidence) Click Withdraw on a release; confirm it drops out of
    /assigned resolution; confirm the final list view showing draft/pilot/stable/withdrawn
    releases together.
```

---

## Known failures

- [ ] None known from the implementation itself. The crashed session's work was reported green
  (696 worker tests, update-contracts 13, build ok) but that has not been independently re-verified
  in this cleanup session yet — treat as unconfirmed until the gate below is re-run.
- [ ] Evidence gap: promote-to-stable, withdraw, and the final combined-status list view were not
  captured as screenshots (7 of the planned ~20 steps) before the session crashed. The 13 captured
  screenshots cover sign-in/setup through pilot-promotion and device assignment (see Appendix).

---

## Decisions needed

- [ ] None outstanding for WT-0 beyond the deploy-workflow secret sync requested below.

---

## Requests to another worktree

- [ ] **WT-0:** Add a `RELEASE_SIGNING_JWK` sync step to the deploy workflow, mirroring the
  existing `ENTITLEMENT_SIGNING_JWK` pattern (`docs/runbooks/licensing-key-rotation.md` "Wiring the
  secret"). Exact step documented in `docs/runbooks/release-key-rotation.md` under "Wiring the
  secret (WT-0, deploy workflow)":
  ```yaml
  - name: Sync RELEASE_SIGNING_JWK (when set)
    working-directory: apps/worker-api
    env:
      RELEASE_SIGNING_JWK: ${{ secrets.RELEASE_SIGNING_JWK }}
    shell: bash
    run: |
      set -euo pipefail
      if [ -z "${RELEASE_SIGNING_JWK}" ]; then echo "not set; uploads stay 503"; exit 0; fi
      printf '%s' "$RELEASE_SIGNING_JWK" | pnpm wrangler secret put RELEASE_SIGNING_JWK
  ```
  Without this, `RELEASE_SIGNING_JWK` is never populated in production and every upload answers
  `503 signing_key_unavailable` (harmless — the Updates page shows a warning banner, nothing else
  is affected — but release management cannot function).
- [ ] **Owner (one-off, before or right after first deploy):** Generate the first key per
  `docs/runbooks/release-key-rotation.md` §1:
  ```bash
  node packages/update-contracts/scripts/generate-signing-key.ts \
    | gh secret set RELEASE_SIGNING_JWK --env production --repo Affinity-Minds/cloudbox
  ```

---

## What the Windows updater must do later

This slice is cloud-side only. A later slice on the Windows updater side must:

- Pin the set of trusted release-signing public JWKs (by `kid`) and verify `manifestJws` against
  them before trusting a manifest — never trust `manifest_json` alone.
- Call `GET /api/v1/releases/assigned?component=<component>` with its device Bearer token, per
  component it manages (agent/status/setup/connect).
- Download via the returned `downloadUrl` before `downloadExpiresAt` (15-minute TTL) — the URL is
  single-use in effect (scoped to that device+release+expiry), not re-fetchable after expiry.
- Verify the downloaded package's sha256 against `manifest.packageSha256` before install.
- Report install lifecycle via `POST /api/v1/releases/:id/result` with the appropriate `state`
  (`downloaded`, `verified`, `installed_healthy`, `installed_unhealthy`, `rolled_back`,
  `failed_download`, `failed_validation`, `deferred_active_users`, `deferred_maintenance`) —
  `installed_healthy`/`installed_unhealthy` are what the cloud-side health gate reads before
  allowing pilot→stable promotion, so accurate self-reporting here is load-bearing, not cosmetic.
- Respect the rotation protocol in `docs/runbooks/release-key-rotation.md` §2 (pin the new key
  before the signer switches; keep the old key pinned until the fleet reports the new updater
  build; only then unpin).

---

## Safe next action

Re-run the full gate in this session (`pnpm check`, `pnpm typecheck`, worker-api/update-contracts/
admin-web vitest suites, `pnpm build`), commit in 2–3 logical commits, push, and open a draft PR
against `phase-2/devices`. WT-0 should not merge until the `RELEASE_SIGNING_JWK` deploy-workflow
sync step above is also in place, or release upload will 503 in production indefinitely.

---

## Appendix: Evidence

- Screenshots: `docs/evidence/wt-p10-releases/` (13 captured; ~7 planned steps not captured — see
  "Known failures"):
  1. `01-staff-sign-in.png`
  2. `02-setup-password.png`
  3. `03-setup-authenticator-qr.png`
  4. `04-backup-codes.png`
  5. `05-overview-signed-in.png`
  6. `06-updates-empty.png`
  7. `07-upload-release-dialog.png`
  8. `08-updates-list-draft.png`
  9. `09-detail-draft.png`
  10. `10-promote-pilot-dialog.png`
  11. `11-detail-pilot.png`
  12. `12-assign-dialog.png`
  13. `13-detail-assigned.png`

  Not captured: promote-to-stable flow/result, withdraw flow/result, and the final combined-status
  release list (draft/pilot/stable/withdrawn together).
- Test output: captured at commit time in this session (see PR description).
- Build log: captured at commit time in this session (see PR description).
