# Current phase
Phase 1 — Identity, tenancy and devices (integration branch `phase-1/identity`)

# Current slice
Foundation commit (WT-0) — shared files for the Phase 1–3 fan-out. Contract: `docs/handoffs/foundation.md`.

# Status
All Phase 1 slices integrated on `phase-1/identity` (13186f4): 469 worker tests, 16 crypto tests, 5 UI tests green; WT-8 fifth pass running; merge to `main` next, then live verification and the owner's first sign-in at `/ops/login`.

# Demo path
1. Fresh clone, checkout `phase-1/identity`.
2. `corepack pnpm install && pnpm run verify` (Biome check, typecheck, Workers-pool tests with real D1, admin-web build, wrangler dry-run).
3. Local console: `pnpm --filter @cloudbox/worker-api db:migrate:local`, `pnpm --filter @cloudbox/admin-web build`, `pnpm --filter @cloudbox/worker-api dev`, open http://localhost:8787/ (overview) and /audit.

# Evidence
- `pnpm run verify` green on the foundation commit (see the commit series on `phase-1/identity`).
- Migration `0003_identity_tenancy_devices.sql` applies on top of a populated 0001/0002 database (test `migrations.test.ts`); audit_log stays append-only; role grants seeded as rows (super_admin 21, admin 18, support 8, read_only 7).
- Overview loader: one D1 round trip (`countingD1` ceiling test ≤3). Audit screen: one round trip per page, keyset on rowid.
- Rendered UI: `docs/evidence/foundation/overview.png`, `docs/evidence/foundation/audit.png` (wrangler dev + local D1, Playwright Chromium).

# Open items
- Screens `/api/v1/screens/overview` and `/api/v1/screens/audit` are not yet behind a session: WT-1 gates them with `requireStaff()` / `requirePermission("audit.view")` before Phase 1 merges to `main`.
- `ENTITLEMENT_SIGNING_JWK` secret provisioning waits for WT-5's generator.
- Deploy workflow now stamps `ENVIRONMENT=production` and `BOOTSTRAP_SUPER_ADMIN_EMAIL` (repo variable) and creates `BETTER_AUTH_SECRET` once; first exercised on the Phase 1 merge to `main`.

# Blockers
None for the fan-out.

# Completed phases

## Phase 0 — Repository, engineering contract, deployable skeleton — DONE 2026-09-27 00:25 IST
- Merged to `main` via PR #1 (fix commit `584aa9e`) and deploy hotfix PR #3 (`89fc59c`); production SHA `8f16cde9a904bc8c21328d0e6fbef1fc7e351f2e`.
- Deploy run: GitHub Actions "Deploy CloudBox" succeeded; D1 `cloudbox-db` recreated in APAC while empty; R2 binding deferred with a workflow warning until R2 is enabled on the account.
- Live verification (curl, 00:24 IST): `GET /api/health` 200 `{"status":"ok"}`; `GET /api/version` gitSha equals `main`; `GET /api/v1` carries `X-API-Version: v1`; `GET /api/v1/foundation` returns `release.status=deployed`, `release.sha` = main SHA, and the audited `foundation.release.changed` row by `github-actions` with before/after; `GET /` serves the SPA shell (200, text/html).
- Rendered evidence: `docs/evidence/phase-0/live-shell.png` (Playwright Chromium against https://box.affinityminds.in, shows Release deployed, Build and Audited SHA `8f16cde9a904`, 2 audit records).
- Exit criteria per spec: staging/production deployable ✓, versioned ✓, testable (`pnpm run verify`, 5 tests at the time) ✓, every later slice has a home ✓, audited administrative state change proven live ✓.
- Deferred: R2 bucket (account-level enablement), Windows physical checks (none required by Phase 0).

