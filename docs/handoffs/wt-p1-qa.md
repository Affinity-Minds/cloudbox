# Handoff — WT-6 `wt/p1-qa` (fixtures, query-plan test, permission-matrix scaffold, e2e smoke)

## Mission

**Scope (per this worktree's adjusted brief — the vitest-pool-workers/D1 harness itself was
already built by the foundation commit; this slice does not rebuild it):**

1. `apps/worker-api/test/fixtures.ts`: `seedStaff`, `seedTenant`, `seedMembership`, `seedDevice`,
   `seedSubscription`; re-export `countingD1` and (once WT-1 shipped it) `signInAs`.
2. `apps/worker-api/test/queries.ts` + `query-plans.test.ts`: a registry other worktrees append to,
   asserted against `EXPLAIN QUERY PLAN` for no unindexed scan on the tenant-scoped/large tables.
3. `apps/worker-api/test/permission-matrix.test.ts`: enumerates `/api/v1/*` from the live route
   table (no hand-maintained list) and asserts 401 unauthenticated / 403 `read_only` on every
   implemented route.
4. `tests/e2e-cloud/`: Playwright smoke suite against a running deployment, plus a
   `workflow_dispatch`-only `e2e-smoke` CI job.
5. `apps/worker-api/test/migrations.test.ts`: add "every migration applies from empty, in order"
   and "applying the chain twice is a no-op, not a silent partial apply."

**Success criterion:** the above five are real (not stubs), `pnpm run verify` is green, and the
handoff says precisely which permission-boundary and query-plan coverage the other worktrees still
owe as their own routes land.

---

## Current status

- Branch: `wt/p1-qa`, parent `phase-1/identity`.
- Merged `origin/phase-1/identity` twice while this ran: once to pick up WT-1's auth/authz spine
  (`signInAs`, gated screens, migration `0004`), again for the Biome worktree-root fix and the
  staff API. Both merges were clean (no conflicts — this worktree's files don't overlap anyone
  else's).
- `pnpm run verify`: **green** — `pnpm check` (Biome, 104 files), `pnpm typecheck` (all 4 TS
  packages), `pnpm test` (worker-api 64/64, admin-web 3/3 — `e2e-cloud` has no `test` script, so
  `pnpm -r --if-present test` correctly skips it), `pnpm build` (admin-web + worker-api dry-run
  deploy).

## Commits ready for merge

```
37bf1b8 wip: fixtures, query-plan test, permission-matrix scaffold, migration tests
02d3a3e Merge remote-tracking branch 'origin/phase-1/identity' into wt/p1-qa
91e62b2 wip: e2e-cloud playwright smoke suite, biome fixes
c4f53a8 Merge remote-tracking branch 'origin/phase-1/identity' into wt/p1-qa
8748a89 ci(e2e): workflow_dispatch e2e-smoke job; align smoke suite with the auth guard that landed
(+ this handoff)
```

---

## Files and contracts changed

- **migrations:** none (this worktree does not own a reserved number).
- **`apps/worker-api/test/fixtures.ts`:** implements `seedStaff`, `seedTenant`, `seedMembership`,
  `seedDevice`, `seedSubscription` (each inserts through `src/db/schema.ts` and returns the row);
  re-exports `countingD1` (from `./counting-d1`) and `signInAs`/`SignedIn`/`TEST_ORIGIN` (from
  WT-1's `./auth-fixtures`, which landed mid-slice — see "Decisions" below for the brief timing).
  Documented in `apps/worker-api/test/fixtures.README.md`.
- **`apps/worker-api/test/queries.ts`:** registry (`{name, sql, params?}[]`) — owners append one
  entry per query *shape* that reads `tenants`, `devices`, `tenant_memberships`, `subscriptions`,
  `entitlements`, `enrollment_tokens`, or `audit_log`. Seeded with the foundation's six
  overview/audit query shapes.
- **`apps/worker-api/test/query-plans.test.ts`:** runs `EXPLAIN QUERY PLAN` for every registry
  entry and fails on a `SCAN` line naming a guarded table that isn't `USING (COVERING) INDEX` or
  `USING INTEGER PRIMARY KEY`. Verified the demo path: temporarily dropping
  `devices_tenant_status_idx` turns the matching case red; restoring it turns it green again.
- **`apps/worker-api/test/permission-matrix.test.ts`:** reads `v1.routes` (Hono's own routing
  table) directly, applies a small allowlist (health/version/the `/api/v1` index/`/api/auth/*`/
  `/api/v1/agent/*`), skips any route still answering the foundation's `{status:'stub'}`
  placeholder, and asserts 401 unauthenticated + 403 for a seeded `read_only` staff member on
  every non-GET route except `POST /api/v1/auth/logout` (self-service — ending your own session
  needs identity, not a "manage" permission; see the file's `SELF_SERVICE_ROUTES` comment for the
  one-line rule for adding to it). No hand-maintained route list — it re-derives as routes land.
- **`apps/worker-api/test/migrations.test.ts`:** kept the existing upgrade test; added "applies
  from empty, in order" (now includes `0004_auth_rate_limit.sql`), "fails loudly (not partially)
  when a migration runs before its dependencies", and "applying the full chain twice is a no-op".
  Added a `resetD1()` helper (multi-pass `DROP TABLE`, since `sqlite_master`'s order isn't FK
  order) — `env.UPGRADE_DB` is **not** reset between tests in the same file, only between files;
  verified this empirically (see the git history of this file — the first version of these tests
  had exactly this bug).
- **`tests/e2e-cloud/`** (new workspace package, `pnpm-workspace.yaml` gained a `tests/*` entry):
  `package.json` (`@cloudbox/e2e-cloud`, script `e2e`, not `test` — confirmed excluded from
  `pnpm -r --if-present test`), `playwright.config.ts` (`BASE_URL` default
  `http://localhost:8787`), `tests/smoke.spec.ts`:
  - `GET /api/health` is 200.
  - `GET /api/version` reports `gitSha`; matches `EXPECTED_SHA` when that env var is set.
  - An anonymous visit to `/` redirects to `/login` and the login chrome renders (see "Decisions"
    — this replaced the brief's original "shell renders with sidebar for an anonymous visit",
    which the auth guard that landed during this slice made incorrect to assert).
  - `/login` renders the email step.
  - A **best-effort** authenticated check, `test.skip`ped unless `E2E_OTP_LOG_PATH` points at a
    local `wrangler dev`'s stdout: signs in for real (email → reads the `[otp-dev-echo]` line
    `sendOtpEmail` logs when `OTP_DEV_ECHO=1` → types the code) and asserts the actual sidebar
    (Overview/Tenants/Fleet). Not run in CI (no log access there, and `OTP_DEV_ECHO` is refused
    in production by `assertOtpEchoSafe`) — this is the "prove it locally" half of the brief.
  - Screenshots land in `docs/evidence/e2e/`: `guard-redirect.png`, `login.png`, and (local-only)
    `shell.png`.
- **`.github/workflows/ci.yml`** (the one permitted edit): added `workflow_dispatch` with inputs
  `base_url` (default `https://box.affinityminds.in`) and `expected_sha`, and a new job
  `e2e-smoke` gated on `if: github.event_name == 'workflow_dispatch'` — never runs on
  `pull_request`/`push`. Installs Chromium, runs `pnpm --filter @cloudbox/e2e-cloud e2e` with
  `BASE_URL`/`EXPECTED_SHA` from the inputs, uploads `docs/evidence/e2e/` as an artifact.
- **`.gitignore`:** added Playwright's own `test-results/`, `playwright-report/`,
  `blob-report/`, `playwright/.cache/`.
- **`biome.json`, `pnpm-lock.yaml`:** not edited by this worktree (the Biome worktree-root fix and
  the `@playwright/test`/`@types/node` lockfile entries came from `pnpm install` resolving the new
  `tests/e2e-cloud` package's declared deps — see "Tests run" for the one real bug this surfaced).

---

## Migrations

None.

## API changes

None (test/CI-only slice).

---

## Security assumptions

- The permission-matrix test's `SELF_SERVICE_ROUTES` allowlist is the one place a real
  authorization gap could hide behind a false "pass" — it currently holds exactly one entry
  (`POST /api/v1/auth/logout`), with the justification inline. Adding to it should always cite the
  same kind of reasoning (identity-only action, not a permission), never "make the test green."
- The query-plan test's `GUARDED_TABLES` list matches `docs/handoffs/foundation.md`'s schema
  exactly; if WT-0 adds a new tenant-scoped table, it belongs in that list too, not just in new
  `queries.ts` entries.
- `OTP_DEV_ECHO` is asserted (by WT-1's `assertOtpEchoSafe`, not by this worktree) to be refused in
  production — the e2e suite's authenticated test structurally cannot run against a real
  deployment, by design, not by accident.

---

## Tests run and results

### Verification script (`pnpm run verify`)

```
✓ pnpm check      — Biome, 104 files, 0 findings
✓ pnpm typecheck  — packages/contracts, tests/e2e-cloud, apps/admin-web, apps/worker-api
✓ pnpm test       — apps/worker-api: 8 files / 64 tests; apps/admin-web: 2 files / 3 tests
✓ pnpm build      — admin-web (vite) + worker-api (wrangler deploy --dry-run)
```

One real environment bug surfaced and fixed along the way, not a test artifact: Biome's
`!!**/.claude` exclude pattern matched every file inside *any* worktree (because Biome resolves
glob roots against the shared git dir, not the worktree's own root) — WT-0 already fixed this
upstream (`!!.claude`, anchored) by the time this slice needed it; confirmed `pnpm run verify`
now passes from inside this worktree, not only from the main checkout.

### Worker-api suite (`apps/worker-api/test/`)

| File | What it covers |
|---|---|
| `foundation.test.ts` | health/version/foundation-release stub endpoints (pre-existing) |
| `migrations.test.ts` | upgrade-from-Phase-0 (pre-existing) + **new**: empty-apply-in-order, out-of-order failure is loud and non-partial, double-apply is a no-op |
| `screens.test.ts` | overview/audit loaders, round-trip ceilings (pre-existing) |
| `auth-otp.test.ts`, `authz.test.ts`, `staff.test.ts` | WT-1's suites (merged in, untouched) |
| `query-plans.test.ts` | **new** — registry-driven `EXPLAIN QUERY PLAN`, 6 entries seeded |
| `permission-matrix.test.ts` | **new** — self-deriving 401/403 matrix over `v1.routes` |

### e2e-cloud suite (`tests/e2e-cloud/tests/smoke.spec.ts`)

Run locally against `wrangler dev` (after `pnpm --filter @cloudbox/worker-api db:migrate:local` —
**note for whoever runs this next**: a fresh `wrangler dev` local D1 does not have migration 0004
applied until that command runs; the OTP send 500'd with `no such table: rate_limit` until I ran
it, which is exactly the kind of thing a smoke suite is for):

```
5 passed (with E2E_OTP_LOG_PATH set to the wrangler dev log)
4 passed, 1 skipped (without it — matches the CI e2e-smoke job's conditions)
```

### Demo path

```
1. corepack pnpm install --frozen-lockfile
2. pnpm --filter @cloudbox/worker-api db:migrate:local
3. pnpm --filter @cloudbox/admin-web build
4. pnpm --filter @cloudbox/worker-api exec wrangler dev --port 8787 --var OTP_DEV_ECHO:1 \
     > /tmp/wrangler.log 2>&1 &
5. BASE_URL=http://localhost:8787 E2E_OTP_LOG_PATH=/tmp/wrangler.log \
     pnpm --filter @cloudbox/e2e-cloud e2e
   → 5/5 pass; screenshots in docs/evidence/e2e/
6. Break the query-plan test: comment out `devices_tenant_status_idx` in
   infra/cloudflare/migrations/0003_identity_tenancy_devices.sql (a scratch edit, don't commit
   it), rerun `pnpm --filter @cloudbox/worker-api test query-plans` → the devices aggregate case
   goes red with a `SCAN TABLE devices` (no index) in the failure message. Revert.
```

---

## Known failures

- [ ] The `read_only` 403 sweep and the query-plan registry are both **self-updating but
  currently thin**: only the foundation's screens and WT-1's staff/auth routes exist today.
  Nothing red today does not mean nothing to do — see "Requests to other worktrees."
- [ ] `tests/e2e-cloud`'s authenticated shell test needs `E2E_OTP_LOG_PATH`; it is a genuine gap
  that there is no way to prove the authenticated shell against a **real deployment** (production
  refuses `OTP_DEV_ECHO` by design). If a future slice wants that proved on `workflow_dispatch`
  too, it needs a deliberate, reviewed backdoor (e.g., a staging-only test-login endpoint gated by
  a secret) — out of this worktree's scope to invent.
- [x] resolved: the original version of the "applies from empty" and "applying twice" migration
  tests were flaky against test order within the file (`env.UPGRADE_DB` carries state across tests
  in one file); fixed with `resetD1()`.
- [x] resolved: `permission-matrix.test.ts`'s first draft asserted 403 on `POST /api/v1/auth/logout`
  for `read_only` staff, which is wrong (logout is self-service); added the narrow
  `SELF_SERVICE_ROUTES` allowlist instead of loosening the whole check.

---

## Decisions needed

- None blocking. One judgment call already made and documented in the test file itself: the
  e2e "shell renders" check was rewritten from "anonymous visitor sees the sidebar" (the brief,
  written before WT-1's auth guard landed) to "anonymous visitor is redirected to /login" — the
  original assertion would now describe a security regression, not a pass. Flagging this loudly
  here in case anyone reads the original brief and wonders why the test doesn't match it literally.

---

## Requests to another worktree

- **WT-2 (tenants/memberships), WT-3 (enrollment/devices/agent), WT-5 (subscriptions/entitlements):**
  as each of your routes stops being a `{status:'stub'}` placeholder, `permission-matrix.test.ts`
  will **start asserting on it automatically** — no edit needed on your side for the 401/403
  sweep itself. But please do add your own tenant-scoped query shapes to
  `apps/worker-api/test/queries.ts` as you write your loaders (one entry per query *shape*,
  `{name, sql, params}` — see that file's header comment and the six existing entries for the
  pattern). The query-plan test only catches a missing index on a query someone registered.
- **WT-3 specifically:** `/api/v1/agent/*` is allowlisted in `permission-matrix.test.ts` (it's
  Bearer-device-auth, not staff/session auth) — please make sure your own agent-route tests cover
  the unauthenticated-Bearer and wrong-device-token 401 cases, since this suite deliberately
  doesn't.
- **WT-2:** `seedTenant`/`seedMembership` in `test/fixtures.ts` default `status: "active"` /
  `standing` as given — read `fixtures.README.md` before adding your own tenant-lifecycle
  fixtures so we don't end up with two ways to seed the same row.
- **Whoever owns the next production deploy:** run the `e2e-smoke` `workflow_dispatch` job
  against `https://box.affinityminds.in` with `expected_sha` set to the deployed commit, once
  after this merges to `main` and a deploy has run — it hasn't been run against the real
  production URL yet, only proved locally (see "Demo path").

---

## Safe next action

Merge this PR into `phase-1/identity` (it touches no file another in-flight worktree owns except
the one permitted `.github/workflows/ci.yml` line-set, and `pnpm run verify` is green); then any
worktree landing a new non-stub `/api/v1` route gets its 401/403 coverage for free, and should add
its own `queries.ts` entries as it writes tenant-scoped loaders.

---

## Appendix: Evidence

- Screenshots: `docs/evidence/e2e/guard-redirect.png`, `docs/evidence/e2e/login.png`,
  `docs/evidence/e2e/shell.png` (the last one is the authenticated sidebar, captured locally with
  `E2E_OTP_LOG_PATH` — not reproducible in CI by design; see "Known failures").
- `pnpm run verify` output: see "Tests run and results" above (full run captured during this
  session; rerun with `corepack pnpm run verify` from this worktree to reproduce).
