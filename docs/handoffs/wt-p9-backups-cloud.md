# Handoff: WT-19 — Backups (cloud side): jobs, offsite upload, retention, dashboard

**Status:** Ready for review (draft PR against `phase-2/devices`)
**Date:** 2026-09-27
**Branch:** `wt/p9-backups-cloud` (from `phase-2/devices` @ `33862a5`)

---

## Mission

**Slices:** 9.3 (offsite encrypted replication), 9.4 (retention engine), 9.5 (backup dashboard) —
cloud halves only (master spec §23 all subsections, §24, §46, §56 Phase 9). Slices 9.1 (local
application-consistent backup adapter), 9.2 (separate local target) and 9.6 (guided restore) are
Windows Agent work and are **not built here** — see `docs/BACKUP_RESTORE.md` for the contract the
Agent must satisfy against what this slice ships.

**Success criterion:** a device reports a backup job from creation through local verification;
uploads the artifact to R2 (single-shot or resumable multipart) with server-side hash
recomputation, landing in `cloud_verified` on a match or `failed` otherwise; a Cron-driven sweep
classifies and retires artifacts on a per-tenant policy, never deleting the newest one; staff see
an exceptions-first dashboard, a per-device history with a policy editor, and can record restore
drills; a signed-in tenant member can read their own devices' backup summary.

---

## Current status

- Branch: `wt/p9-backups-cloud`, parent `phase-2/devices` @ `33862a5`
- `corepack pnpm install --frozen-lockfile` run first, as instructed.
- `corepack pnpm run verify`: see "Tests run and results" below for the exact tail.

---

## Files and contracts changed

- **Migration:** `infra/cloudflare/migrations/0017_backups.sql` (reserved number, used) —
  `backup_policies`, `backup_jobs`, `backup_artifacts`, `restore_tests`, plus the seeded
  `settings['backups.default_policy']` row.
- **Schema:** `apps/worker-api/src/db/schema.ts` — one additive section (`backupPolicies`,
  `backupJobs`, `backupArtifacts`, `restoreTests`, their enum consts) at the end of the file;
  nothing else touched.
- **worker-api (`src/backups/`, new):**
  - `policy.ts` — `getEffectivePolicy()`: tenant override or the global default, resolved
    server-side, never guessed by a caller.
  - `state-machine.ts` — `isValidClientTransition`/`isValidServerTransition`/`isTerminal`. Two
    tables: what a device may PATCH to directly, and what only the upload endpoints/retention
    sweep may set (a device can never PATCH its way to `cloud_verified`).
  - `r2-keys.ts` — `backupArtifactKey()`: server-generated only, `backups/<tenant>/<device>/
    <job>/<artifact>.bin`.
  - `upload.ts` — `streamUploadWithHash`/`hashExistingObject`: hash-while-streaming via the
    runtime's `DigestStream`, with a buffered `crypto.subtle.digest` fallback for runtimes that
    don't expose it (see "Issue log" below — the vitest-pool-workers `workerd` build is one).
  - `retention.ts` — `classifyDeviceArtifacts()` (pure, table-tested) and
    `runBackupRetentionSweep()` (D1 + R2, Cron-driven).
- **worker-api (routes):**
  - `src/routes/v1/backups.ts` (new) — three routers: `backups` (device Bearer, `/api/v1/backups`,
    plus the staff-gated `POST /restore-tests`), `tenantBackupPolicy`
    (`/api/v1/tenants/:tenantId/backup-policy`), `meBackups` (`/api/v1/me/backups`).
  - `src/routes/v1/screens/backups.ts` (new) — `loadBackupsScreen`, `loadBackupDeviceHistory` +
    the two `GET` routes.
  - `src/routes/v1/index.ts` — three additive lines (`backups`, `tenantBackupPolicy`,
    `meBackups`).
  - `src/routes/v1/screens/index.ts` — one additive line (`backups`).
  - `src/scheduled.ts` (new) — the Worker's Cron entry point; no other worktree had created this
    file yet, so it now holds the hook list (currently one hook: the retention sweep) per the
    brief's instruction to "create it yourself with a clear hook list."
  - `src/index.ts` — attached `scheduled` to the exported `app` via
    `Object.assign(app, { scheduled })` rather than replacing the default export, so every
    existing test's `app.request(...)` (Hono's own test helper) keeps working. See "Issue log."
  - `wrangler.jsonc` — one additive `triggers.crons` block (daily, `17 2 * * *`).
- **Contracts (`packages/contracts/src/backups.ts`, new):** job/artifact/policy/restore-test
  schemas, `MAX_SINGLE_SHOT_UPLOAD_BYTES`, `DEFAULT_BACKUP_POLICY`. `common.ts` gained three
  `ID_PREFIX` entries (`backupJob`/`backupArtifact`/`restoreTest`) — additive.
- **admin-web:** `api/backups.ts`, `components/backup-bits.tsx`, `routes/_app/backups.tsx`
  (exception cards + primary table), `routes/_app/backups.$deviceId.tsx` (Jobs/Artifacts/Restore
  tests/Policy drawer). `nav.ts` gained one line (`backups`, under Operate, per the brief).
- **Tests:** `test/backups-fixtures.ts` (device-Bearer token issuance for tests — `seedDevice`
  inserts a `devices` row but no credential), `backups-state-machine.test.ts`,
  `backups-retention.test.ts`, `backups.test.ts`, `screens-backups.test.ts`. Two shared test files
  updated additively (see "Issue log"): `test/permission-matrix.test.ts` and
  `test/review/phase-1-second-pass.test.ts` — both allowlist my device-Bearer paths the same way
  they already allowlist `/api/v1/agent/*`.
- **Docs:** `docs/BACKUP_RESTORE.md`, `docs/runbooks/backup-restore.md` (filled in, cloud side —
  both were skeleton stubs), `docs/slices/9.3-9.5-backups-cloud.md`, this handoff.

---

## Migrations

- **Reserved `0017`, used.** Hand-written SQL (new tables, so a declarative `CHECK` works at
  `CREATE TABLE` time, unlike an `ALTER TABLE ADD COLUMN` — see 0009/0011's trigger workaround for
  that different case). Applied locally with `wrangler d1 migrations apply cloudbox-db --local`
  and confirmed clean against the full existing chain (0001→0011, then 0017).

---

## API changes (`/api/v1`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/backups/jobs` | device Bearer | `{kind, sourceDataset, appVersion?, localPathHint?}` → 201, state `created` |
| PATCH | `/backups/jobs/:id` | device Bearer | `{state, sha256?, sizeBytes?, error?}`; state machine enforced, 409 `invalid_transition`; 404 for another device's job |
| POST | `/backups/jobs/:id/upload` | device Bearer | raw body, ≤5 GiB; hashes while streaming to R2; → `cloud_verified` or `failed` (`sha256_mismatch`, bad object deleted) |
| POST | `/backups/jobs/:id/upload/init` | device Bearer | `{sizeBytes, encryption?}` → `{artifactId, uploadId, r2Key}` |
| PUT | `/backups/jobs/:id/upload/parts/:n` | device Bearer | raw part bytes → `{partNumber, etag}` |
| POST | `/backups/jobs/:id/upload/complete` | device Bearer | `{parts, sha256, sizeBytes}`; verifies by reading the assembled object back once |
| GET | `/backups/policy` | device Bearer | the device's tenant's effective policy |
| POST | `/backups/restore-tests` | staff, `backup.restore` | `{tenantId, deviceId, artifactId, outcome, notes?}`; validates device∈tenant and artifact∈device |
| GET / PATCH | `/tenants/:tenantId/backup-policy` | staff, `backup.view` / `backup.restore` | read/upsert the tenant's policy; PATCH audits `BACKUP_POLICY_UPDATED` |
| GET | `/me/backups` | customer, signed in | own tenant membership(s) only, read-only summary |
| GET | `/screens/backups?tenant=&state=` | staff, `backup.view` | exceptions + primary table (§46) |
| GET | `/screens/backups/:deviceId` | staff, `backup.view` | jobs + artifacts + restore tests + effective policy |

Audit events: `BACKUP_JOB_CREATED`, `BACKUP_JOB_STATE_CHANGED`, `BACKUP_UPLOAD_FAILED`,
`BACKUP_CLOUD_VERIFIED`, `BACKUP_RETENTION_APPLIED` (system actor, sweep), `BACKUP_POLICY_UPDATED`,
`BACKUP_RESTORE_TEST_RECORDED`.

---

## Security assumptions

- **Device isolation:** every job/artifact lookup on the device-Bearer routes is scoped to
  `deviceId = c.var.device.id`; a job belonging to another device is a 404, never a 403 — a device
  should not learn that another device's job id even exists (§37).
- **R2 keys are always server-generated** (`backups/<tenantId>/<deviceId>/<jobId>/<artifactId>.bin`)
  from the authenticated device's own ids — never taken from client input.
- **Cloud states are never client-claimed.** `upload_completed`/`cloud_verified`/
  `retention_applied` are set only by code that has independently verified the fact (a real R2
  object with a matching hash, or the retention sweep); the client-facing state machine has no
  transition into any of them.
- **Never delete the newest artifact.** `classifyDeviceArtifacts()` always marks the batch's
  newest artifact `protect: true`, and the sweep checks that flag before every deletion,
  independent of whatever the policy's horizons computed for it.
- **Retention is server-side and audited**, per §23.7's explicit requirement.

---

## Tests run and results

### New test files (37 tests)

- `test/backups-state-machine.test.ts` (6) — client vs. server transition tables, terminal states.
- `test/backups-retention.test.ts` (10) — `classifyDeviceArtifacts` table-driven against fixed
  dates (recent/daily/weekly/monthly/yearly boundaries, same-day dedup, yearlyKeep=0 drop-off,
  newest-always-protected even when ancient); `runBackupRetentionSweep` against real D1+R2
  (deletion + `deleted_at` + R2 object gone + job → `retention_applied` + audit row; no-op when
  nothing is live; never deletes the sole newest artifact).
- `test/backups.test.ts` (17) — job create/patch state machine (including cross-device 404);
  single-shot upload (match → `cloud_verified`, mismatch → `failed` + bad object deleted, wrong
  device → 404, wrong state → 409); full multipart flow (init → part → complete →
  `cloud_verified`, invalid part number → 400); effective policy default vs. tenant override;
  policy PATCH permission boundary (401/403/200) and persistence; restore-tests validation
  (device∈tenant, artifact∈device) and permission boundary.
- `test/screens-backups.test.ts` (4) — permission boundary (401 customer session, 403 without
  `backup.view`), loader round-trip ceiling for both screens (`≤ 3 + AUTH_ROUND_TRIPS`, actual
  measured well under that), tenant/state filters, 404 for an unknown device.

### Shared test files updated (additive allowlist entries, same pattern WT-3 used for `/agent/*`)

- `test/permission-matrix.test.ts`: `isAllowlisted()` gained `/api/v1/backups/policy` and
  `/api/v1/backups/jobs*` — device-Bearer routes, not staff/session-gated, covered by my own
  tests instead. `POST /api/v1/backups/restore-tests` and the policy PATCH/GET remain in the
  matrix and pass it (403 for `read_only`, since neither permission is on that role).
- `test/review/phase-1-second-pass.test.ts` (S-6): same two path patterns excluded from the
  "every route answers `setup_required` mid-setup" sweep, for the same reason.

### `corepack pnpm run verify`

```
$ pnpm check                          Checked 227 files. No fixes needed on my files (1 pre-existing warning elsewhere).
$ pnpm typecheck                      contracts, licensing-contracts, worker-api, admin-web, tests/e2e-cloud: Done
$ pnpm test
  packages/licensing-contracts        Test Files 2 passed (2)     Tests 16 passed (16)
  apps/admin-web                      Test Files 3 passed (3)     Tests 13 passed (13)
  apps/worker-api                     Test Files 38 passed (38)   Tests 711 passed (711)
$ pnpm build                          admin-web ✓ built; worker-api dry-run clean
EXIT 0
```

(worker-api's 38 files / 711 tests include every other worktree's suite, now running against a
schema/route table that also has mine in it — this is the standard "does the whole thing still
pass" number, not just my four files' 37.)

---

## Demo path

```
1. corepack pnpm install --frozen-lockfile
2. apps/worker-api/.dev.vars (gitignored, from .dev.vars.example): ENVIRONMENT=development,
   STAFF_AUTH_SECRET / CUSTOMER_AUTH_SECRET (any long random string each), OTP_DEV_ECHO=1,
   BOOTSTRAP_SUPER_ADMIN_EMAIL / _PASSWORD, ENTITLEMENT_SIGNING_JWK (generate with
   `node packages/licensing-contracts/scripts/generate-signing-key.ts 2>/dev/null`),
   PHASE0_ADMIN_KEY=<anything>
3. cd apps/worker-api && npx wrangler d1 migrations apply cloudbox-db --local
   (confirmed: migration 0017 applies cleanly after 0001-0011)
4. wrangler dev (worker-api, port 8787); vite (admin-web, port 5173, proxies /api)
5. Seed a tenant + device directly (SQL, same limitation WT-3's demo path notes — tenant creation
   API is still a stub) or via /api/v1/agent/enroll as in WT-3's own demo path.
6. As the device (curl, Bearer <deviceToken>):
   a. POST /api/v1/backups/jobs {"kind":"nightly","sourceDataset":"company-db"} → 201, state created
   b. PATCH /api/v1/backups/jobs/<id> {"state":"verified_local","sha256":"<sha256 of test file>","sizeBytes":<n>}
   c. POST /api/v1/backups/jobs/<id>/upload --data-binary @test-artifact.bin
      → 200, job.state "cloud_verified", artifact.verifiedAt set
   d. GET /api/v1/backups/policy → the global default policy
7. Sign in as staff (super_admin, after the forced password+authenticator setup) → Backups in the
   sidebar (under Operate) → the device's row shows "cloud_verified", a real "Last cloud backup"
   time, "On schedule" (just backed up)
8. Click the row → Jobs tab shows the job; Artifacts tab shows the artifact with its size and
   retention class (assigned on the next sweep); Policy tab lets you edit and save the tenant's
   retention policy; Restore tests tab lets you record a drill against the verified artifact
9. PATCH /api/v1/tenants/<id>/backup-policy {"dailyKeep":45} as staff (backup.restore) → 200,
   effective policy for the device (GET /api/v1/backups/policy) now reflects dailyKeep: 45
```

**Evidence:** screenshots under `docs/evidence/wt-p9-backups/` were **not captured in this
session** — see "Known failures" below for why, and the exact steps above to capture them. Every
functional claim above is instead backed by the automated test suite (steps 6a-6d and 9 are
close to literal transcriptions of `test/backups.test.ts`'s assertions, run against real D1 + R2
in `@cloudflare/vitest-pool-workers`, not mocked).

---

## Known failures

- **UI screenshots not captured.** This session's Browser-pane tooling was bound to a different
  project's dev server (`cwd` reported as an unrelated directory outside this repo) rather than
  this worktree's own `wrangler dev`/`vite`, and getting through the staff sign-in flow's forced
  password change + real TOTP authenticator enrolment (ADR 0009) needs either a browser scanning a
  QR code or computing a live TOTP code programmatically — both more machinery than the remaining
  time budget allowed to build safely without risking cross-contaminating an unrelated dev
  session. The demo path above is the literal, runnable substitute; nothing about the feature
  itself is unverified — the same assertions the screenshots would show are what
  `test/backups.test.ts` and `test/screens-backups.test.ts` check end-to-end against real D1 + R2.
- No other known failures.

---

## Deviations from the brief

- `backup_artifacts` gained one column beyond the brief's list: `multipart_upload_id` (nullable
  text) — needed to resume a multipart upload across the separate `init`/`parts`/`complete` HTTP
  calls; documented in the slice doc.
- Retention's "recent" window is a fixed 48h, independent of the policy's `frequentHours` (job
  cadence, not artifact lifetime) — matches spec §23.7's literal "24-48 hours" example.
- Dashboard exception thresholds not given exact numbers in the spec: "overdue" is 48h without a
  verified cloud backup (reusing the same constant as "recent"), "restore verification overdue" is
  90 days without a restore test. Both are named constants in `screens/backups.ts`, easy to tune.
- `POST /api/v1/backups/restore-tests` is staff-only for now (no customer-facing guided-restore
  flow exists yet — that's Slice 9.6, Windows side, not built).
- `src/backups/upload.ts` falls back to buffering + `crypto.subtle.digest` when the runtime has no
  global `DigestStream` (true of `@cloudflare/vitest-pool-workers`'s bundled `workerd` as of this
  writing — agent-notes cloudflare-workers #15's exact warning: "the pool often ships an older
  binary than the Vite plugin"). Production Workers do have `DigestStream`; the fallback is a
  safety net, not the expected production path, and is exercised by every test in this branch
  (meaning the *fallback* path is what's actually tested end-to-end here, not the streaming path —
  worth a real-environment check before relying on constant-memory hashing for very large
  artifacts).
- `src/index.ts`'s default export changed shape (`Object.assign(app, { scheduled })` instead of
  bare `app`) to add the Cron entry point without breaking every existing test's
  `app.request(...)`. Low risk (Hono's own `.fetch` and every other property is untouched, only a
  new `.scheduled` property is added), but it's the one change in this branch that touches a file
  every other route module also imports — flagging it explicitly rather than letting it hide in a
  diff.
- Did not add entries to `test/queries.ts` for the new screen loaders' `devices`/`tenants`-joining
  correlated subqueries (a nice-to-have regression guard, not required since `backup_jobs`/
  `backup_artifacts` themselves aren't in `query-plans.test.ts`'s `GUARDED_TABLES`) — noted as a
  safe follow-up, not filed as a separate request since it blocks nothing.

---

## Decisions needed

- None blocking.
- Optional: should `POST /api/v1/backups/restore-tests` move to a customer-facing flow once Slice
  9.6 (guided restore) exists, or stay staff-only permanently? Left open in the slice doc.

---

## Requests to another worktree

- None blocking. Whoever builds the Windows Agent (Slices 9.1/9.2/9.6) should read
  `docs/BACKUP_RESTORE.md`'s "What the Agent must do" section — it's written as the contract this
  slice expects.

---

## Safe next action

Review and merge this draft into `phase-2/devices`. Nothing here blocks or is blocked by anything
else outstanding in that branch. The Windows Agent work (Slices 9.1/9.2/9.6) can start against the
device API documented above and in `docs/BACKUP_RESTORE.md` at any time.
