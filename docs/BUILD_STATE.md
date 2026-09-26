# Current phase
Phase 1 — Identity, tenancy and devices (integration branch `phase-1/identity`)

# Current slice
Foundation commit (WT-0) — shared files for the Phase 1–3 fan-out. Contract: `docs/handoffs/foundation.md`.

# Status
Foundation: done. Fan-out worktrees (WT-1 … WT-7) branch from this commit.

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
