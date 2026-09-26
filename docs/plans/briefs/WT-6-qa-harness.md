# WT-6 — QA / CI / test harness
Model: **Sonnet 5**. Branch: `wt/p1-qa` from `phase-1/identity` (after foundation). No migration.

Load: agent-notes `platform/cloudflare-workers.md` #15 (test pool is not the edge; `defineWorkersConfig` removed in 0.22 → `cloudflareTest` plugin with `readD1Migrations`/`applyD1Migrations`), `platform/fast-data-hydration.md` "two tests that stop regressions", `process/parallel-agent-slices.md` (exclude worktrees from globs, build before test).

You own: `apps/worker-api/vitest.config.ts`, `apps/worker-api/test/**` (setup, `countingD1`, session/permission fixtures, migration test), `packages/test-fixtures/**`, `tests/e2e-cloud/**` (Playwright), `.github/workflows/ci.yml` **only** to add the e2e job behind `workflow_dispatch` (one edit, minimal).

Deliver:
1. Migrate worker tests to `@cloudflare/vitest-pool-workers` 0.22 with real D1: apply `infra/cloudflare/migrations/*.sql` in `setup`, `compatibility_date` supported by the pool's workerd, `isolatedStorage` on. Keep `app.request()`-style tests working. Exclude `**/.claude/**`, `**/.worktrees/**`, `**/dist/**`.
2. Migration test: every migration applies from empty **and** from the previous release's state (apply 0001–0002, insert the seeded foundation rows as production has them, then apply 0003+). Query-plan test: `EXPLAIN QUERY PLAN` for the loader queries WT-2/WT-3/WT-5 register in `test/queries.ts` — no `SCAN` on tenant-scoped tables.
3. `countingD1(env.DB)` proxy + `expectQueryCeiling(loader, 3)` helper; `packages/test-fixtures`: `makeStaff(role)`, `makeTenantMember(tenant, standing)`, `makeDevice(tenant)`, `signInAs()` that creates a Better Auth session row directly through Better Auth's internal adapter API (not by hand-minting), returning a Cookie header. Document usage in `packages/test-fixtures/README.md` so WT-1/2/3/5 consume it instead of inventing fakes.
4. Permission-boundary matrix test scaffold: for every route in `routes/v1/index.ts` that WT-1..5 tag with `requirePermission`, assert `read_only` gets 403 and unauthenticated gets 401. Generate the matrix from the route list, not by hand.
5. Playwright (`tests/e2e-cloud`): production smoke against `BASE_URL` — `/api/health`, `/api/version` equals `EXPECTED_SHA`, shell renders (title, sidebar), `/login` shows the email step; screenshot to `docs/evidence/e2e/`. Runs on `workflow_dispatch` only tonight.
6. Report in the handoff which tests other worktrees still need to write.

Demo path: `pnpm --filter @cloudbox/worker-api test` shows real-D1 tests green; deliberately break an index and show the query-plan test fail; run the Playwright smoke against `https://box.affinityminds.in` after the Phase 0 deploy.
