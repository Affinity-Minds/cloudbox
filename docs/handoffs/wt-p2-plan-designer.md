# Handoff: WT-13 — Plan designer, plan selector, timezone selector

**Status:** Ready for review (draft PR against `phase-2/devices`)
**Date:** 2026-09-27
**Branch:** `wt/p2-plan-designer` (from `phase-2/devices` @ `2d00c1f`, merged forward once as
`origin/phase-2/devices` moved to `9398c32` — WT-14's self-onboarding/licence-keys slice landed
mid-task)

---

## Mission

**Slice:** 3.6 (plan designer, plan selector, timezone selector).

**Success criterion:** a super admin can create, edit, retire and reactivate plans through an
operational console; a retired plan cannot be chosen for a new tenant or a new subscription, but
every existing subscription on it keeps working unchanged; the tenant sheet and the subscription
create dialog pick a plan and a timezone through a searchable, keyboard-navigable combobox instead
of free text.

---

## Current status

- Branch: `wt/p2-plan-designer`, parent `phase-2/devices`.
- Commits: 1 feature commit + 1 merge commit (`origin/phase-2/devices`, bringing in WT-14's
  self-onboarding/licence-keys/pending-subscriptions slice).
- `corepack pnpm run verify`: **green**, exit code checked (see "Tests run and results").
- Live-verified with `wrangler dev` + a fresh local D1 + a real Playwright session (password +
  computed RFC 6238 authenticator code, same as the enrollment worktree's evidence) — every
  screenshot in `docs/evidence/wt-p2-plans/` is from that run, on the exact tree being handed off.

---

## Commits ready for merge

```
3a8ef7c feat(plans): plan designer, plan selector, timezone selector
bc32c49 Merge remote-tracking branch 'origin/phase-2/devices' into wt/p2-plan-designer
```

The merge commit resolves conflicts in `db/schema.ts` (plans lifecycle columns + WT-14's
subscription changes, both kept), `nav.ts` (Plans then Licence keys), `packages/contracts/src/{devices,subscriptions}.ts`
(additive), `apps/worker-api/src/routes/v1/{subscriptions,tenants}.ts` (the `plan_retired`/
`invalid_timezone` checks alongside WT-14's `pending` subscriptions and primary-contact-becomes-owner
logic), `apps/worker-api/test/queries.ts` (both sets of registered queries), the generated
`routeTree.gen.ts` (regenerated from disk, not hand-merged), and one WT-14 test
(`onboarding.test.ts`'s `term_days` test tried to force the column to `NULL`, which the actual
`NOT NULL DEFAULT 365` column no longer allows — narrowed to test the real, always-populated
column instead of a since-impossible edge case). It also swaps `/start`'s plain `<select>` for
`TimezoneSelect` (owner request, mid-task, so there is one timezone selector everywhere) and fixes
a latent circular-import bug in `@cloudbox/contracts` found while capturing evidence (see
"Deviations").

---

## Files and contracts changed

- **migrations:** `0009_plans_lifecycle.sql` (reserved number, used).
- **worker-api:**
  - `src/db/schema.ts` — `plans` table only: `description`, `status`, `termDays`, `createdAt`,
    `updatedAt`, two `check()` constraints.
  - `src/routes/v1/subscriptions.ts` — `toPlan` extended; `GET/POST /plans`, `PATCH /plans/:code`,
    `POST /plans/:code/{retire,reactivate}`; `plan_retired` 409 added to
    `POST /tenants/:tenantId/subscriptions`.
  - `src/routes/v1/tenants.ts` — `isPlanRetired`/`isValidTimezone` helpers; `plan_retired` 409 and
    `invalid_timezone` 400 on both `POST /` and `PATCH /:tenantId`.
  - `src/routes/v1/screens/plans.ts` (new) — `loadPlansScreen`, one line in `screens/index.ts`.
  - `test/plans.test.ts` (new, 19 tests), `test/queries.ts` (+1 registered query), one edit to
    `test/subscriptions.test.ts` (the existing `GET /plans` test now asserts with
    `expect.objectContaining` since `Plan` grew fields) and one to `test/onboarding.test.ts` (see
    above).
- **contracts (`packages/contracts/src`):**
  - `subscriptions.ts` — `PlanStatus`, `PlanCode`; `Plan` extended (`description`, `status`,
    `termDays`, `createdAt`, `updatedAt`); `CreatePlanRequest`, `UpdatePlanRequest`, `PlanListItem`,
    `PlansScreen`. All additive; no existing export renamed.
  - `common.ts` — `AuditEntry` moved here from `screens.ts` (see "Deviations"); `devices.ts`'s
    import updated to match.
- **admin-web:**
  - `src/api/plans.ts` (new) — `plansScreenQuery`, `activePlansQuery`, `createPlan`, `updatePlan`,
    `retirePlan`, `reactivatePlan`.
  - `src/components/plan-select.tsx`, `src/components/timezone-select.tsx` (+
    `src/lib/timezones.ts`, `src/lib/timezones.test.ts`) — the two reusable comboboxes.
  - `src/components/plan-bits.tsx`, `src/components/plan-form-sheet.tsx`,
    `src/components/retire-plan-dialog.tsx` — the designer's own pieces.
  - `src/components/ui/popover.tsx` (new, via `shadcn add popover` — no new npm dependency, the
    `radix-ui` meta-package already ships it).
  - `src/routes/_app/plans.tsx` (new route).
  - `src/nav.ts` — one line (`plans` under Govern).
  - `src/components/tenants/tenant-form-sheet.tsx` — `planCode`/`timezone` fields now use the two
    comboboxes via `Controller` instead of plain `Input`; default timezone is the browser's own
    zone on create.
  - `src/routes/_app/subscriptions.tsx` — the "New subscription" dialog's plan field now uses
    `PlanSelect` (additive replacement of that one field; nothing else in the dialog changed).
  - `src/portal/start-page.tsx` — `/start`'s organisation-step timezone `<select>` replaced with
    `TimezoneSelect` (owner request, mid-task; the customer surface has no auth dependency on
    `PlanSelect`'s staff-only endpoint, so this is safe there).
- **Configuration:** none. No new bindings, vars, secrets or dependencies. `.claude/launch.json`
  gained a `cloudbox-worker-dev` entry (worker-api's own `wrangler dev`, port 8787) alongside the
  existing `cloudbox-dev` (admin-web's vite dev, port 5173) — needed to drive the live evidence
  capture; harmless to keep.

---

## Migrations

- Reserved `0009`, used: `infra/cloudflare/migrations/0009_plans_lifecycle.sql`.
- Hand-written (no `drizzle-kit generate` diff — see "Deviations" for why), matching this repo's
  existing convention for hand-added ALTER/trigger migrations (0002's `audit_log` triggers, 0003's
  tail). D1/SQLite's `ALTER TABLE ADD COLUMN` only accepts a **constant** default, so
  `created_at`/`updated_at` get a fixed placeholder and are backfilled to a real timestamp for the
  seeded `cloudbox-6` row in the same migration; every row the API inserts from here on sets both
  explicitly via `nowIso()`, same as every other table.
- Applied locally: ✓ — fresh local D1, `wrangler d1 migrations apply cloudbox-db --local`, all of
  0001 through 0010 (0010 is WT-14's, picked up by the merge) apply cleanly in order.

---

## API changes

See the table in `docs/slices/3.6-plan-designer.md`; the same table has been added to
`docs/handoffs/wt-p3-entitlement.md`'s API section (that document is the canonical "subscriptions
and plans" reference other worktrees read).

---

## Security assumptions

- Every plans route re-resolves the staff principal's permissions per request (WT-1's
  `requirePermission`); reads of retired plans and every write additionally check
  `subscription.manage` inside the handler for the query-param case (`?include=retired`), using
  the same `getStaffPrincipal`/`forbidden` primitives `guardFor` uses internally — refused before
  any plan-table query runs (asserted in the permission-boundary tests: 0 extra handler round
  trips on a 403 for `read_only`).
- `code` is immutable by construction: `UpdatePlanRequest` has no `code` field, and the PATCH
  handler never reads `input.code`, so a client sending one is silently ignored (Zod strips
  unknown keys by default) — covered by a test that PATCHes with a `code` field and asserts it had
  no effect.
- A retired plan is enforced **server-side** at the two points that matter (new tenant, new
  subscription) — the UI's own filtering (active-only in `PlanSelect`) is a convenience, not the
  security boundary.
- The timezone check is a pure function of the runtime's own IANA database
  (`Intl.supportedValuesOf`/`Intl.DateTimeFormat`) — no hand-maintained zone list to fall out of
  date, and no network call.

---

## Tests run and results

### `corepack pnpm run verify` (worktree, after merging `origin/phase-2/devices` @ `9398c32`)

```
$ biome check .                      Checked 205 files. No fixes applied. (1 pre-existing warning,
                                      not mine: tests/e2e-cloud noTemplateCurlyInString)
$ pnpm typecheck                     contracts, licensing-contracts, tests/e2e-cloud, admin-web,
                                      worker-api: all Done
$ pnpm test
  packages/licensing-contracts       Test Files 2 passed (2)     Tests 16 passed (16)
  apps/admin-web                     Test Files 3 passed (3)     Tests 13 passed (13)
  apps/worker-api                    Test Files 30 passed (30)   Tests 580 passed (580)
$ pnpm build                         admin-web ✓ built; worker-api dry-run
                                      Total Upload 3175.28 KiB / gzip 547.04 KiB
EXIT 0
```

(Exit code checked directly, not piped — `echo "EXIT:$?"` after the run, per the brief.)

### Coverage by file

- `apps/worker-api/test/plans.test.ts` (19, new): plan CRUD (create + audit, invalid code slug in
  four shapes, unknown feature/out-of-range limits each rejected, duplicate code 409, **code is
  immutable** on PATCH with audit before/after, PATCH needs ≥1 field, 404 on unknown code); plan
  lifecycle (retiring blocks a new tenant with `plan_retired`, blocks a new subscription the same
  way, **does not disturb an existing subscription already on the plan** — still listed, still
  PATCH-able — cannot set a retired plan on a tenant PATCH either, retiring twice is a real 409 not
  a silent 200, reactivate un-blocks selection with an audit trail of both events, retire/reactivate
  404 on an unknown code, default `GET /plans` excludes retired while `?include=retired` includes
  it); permission boundary (anonymous 401 on all seven plans routes; `read_only` reads active
  plans, 403s `?include=retired` and `GET /screens/plans`, 403s all five writes); `GET
  /screens/plans` round-trip ceiling (`countingD1`, `≤ 1 + AUTH_ROUND_TRIPS`) with a real
  subscription count; invalid timezone 400 on tenant create and update, valid zone 201.
- `apps/worker-api/test/subscriptions.test.ts` (1 edit): `GET /api/v1/plans` test now asserts with
  `expect.objectContaining` (the seeded plan gained fields).
- `apps/worker-api/test/onboarding.test.ts` (1 edit, WT-14's file): the `term_days` fallback test
  no longer forces the column to `NULL` (impossible against the real `NOT NULL` column); it now
  asserts the column default (365) and an explicit override (30).
- `apps/admin-web/src/lib/timezones.test.ts` (8, new): substring match including region prefix,
  abbreviation match case-insensitive, an abbreviation for a different zone does not match, empty
  query matches everything, no-match returns false, region splitting, and the legacy-alias case
  (`Asia/Calcutta` found via "kolkata" and vice versa — see "Deviations").

Todo tests: **none.**

### Demo path (live-verified, not just described)

Local, `wrangler dev` (port 18787, to avoid a port clash with a concurrent process on this shared
build host — see "Deviations") + a fresh local D1 (`0001`–`0010` applied) + a real Playwright
session:

```
1. Staff sign-in: email + the seeded initial password                       (01a-staff-login.png)
2. Forced password change                                                    (01b-setup-password-blank.png)
3. Authenticator enrolment: manual-entry secret read off the page, a real
   RFC 6238 code computed from it and typed in                               (01c-setup-authenticator-qr.png)
4. Backup codes shown once, acknowledged                                     (01d-backup-codes.png)
5. Overview renders signed in as Super Admin, Plans visible under Govern     (02-overview-signed-in.png)
6. Plans: seeded cloudbox-6 only                                             (03-plans-table-seeded.png)
7. New plan "CloudBox Pro" (10 devices, 25 users, all 3 features, 14d grace,
   45d warning, 365d term) → Save                                            (04-new-plan-sheet.png / 05-plans-table-with-new-plan.png)
8. Retire it → confirmation names "No subscriptions are on this plan right
   now" → Retire plan → status pill flips                                    (06-retire-plan-confirmation.png / 07-plans-table-after-retire.png)
   → Reactivate (not screenshotted separately; audited, asserted in tests)
9. Tenants → New tenant → Plan combobox: type "clo" → both plans, with
   device/user counts                                                        (08-plan-combobox-search.png)
10. Timezone combobox: type "kolk" → matching zone found (this runtime lists
    it as Asia/Calcutta — the search matches either spelling), grouped under
    "Asia", live UTC offset shown                                            (09-timezone-combobox-search.png)
11. Both fields set, primary contact filled                                  (10-tenant-sheet-both-selectors.png)
12. Save → tenant created, CBX-00001, plan and timezone both persisted       (11-tenant-created.png)
```

---

## Known failures

None outstanding in this slice's own scope.

---

## Deviations from the brief

- **`term_days` column (owner addition, mid-task):** the owner asked, via the coordinator, for a
  `term_days INTEGER NOT NULL DEFAULT 365` column on `plans` (1–3650), a "Term (days)" field in the
  create/edit sheet, and a "Term" table column formatted as "1 year"/"N days" — added exactly as
  scoped (column + UI only). The redemption semantics (`pending` → `active` with
  `valid_from`/`valid_until` set at activation) are WT-14's, in a sibling worktree, and had already
  landed by the time I merged — WT-14's own `planTermDays()` helper reads this column defensively
  (`SELECT *`, tolerant of the column not existing) and needed one test adjustment (see above).
- **Integration merge (owner instruction, mid-task):** merged `origin/phase-2/devices` (WT-14's
  self-onboarding/licence-keys slice, `9398c32`) into this branch before opening the PR, per an
  explicit request naming the exact conflict points. Resolved as described above; also replaced
  `/start`'s plain timezone `<select>` with `TimezoneSelect` per the same request, so there is one
  timezone selector across the whole app.
- **Circular-import fix in `@cloudbox/contracts` (found, not requested):** `devices.ts` imported
  `AuditEntry` from `screens.ts`, which imports `Device` from `devices.ts` — a genuine cycle,
  pre-existing (verified via `git log` on both files — no WT-13 commit ever touched them before
  this fix). It never surfaced before because `packages/contracts/src/index.ts`'s `export *`
  ordering plus every prior consumer's happened-to-work module-evaluation order avoided the
  temporal-dead-zone case; Vite's native-ESM dev server hit it deterministically the moment the
  full barrel loaded, throwing `ReferenceError: Cannot access 'Device' before initialization`
  before any page — not just this slice's — could render. Fixed by moving `AuditEntry` to
  `common.ts` (a true leaf module) and pointing `devices.ts` at it instead; `screens.ts` also now
  imports it from `common.ts`. No shape changed, no export renamed, verified acyclic afterward by
  inspection of every file's own `import … from "./…"` lines. Flagging this prominently since it
  is outside my file ownership but was blocking evidence capture for every worktree, not just this
  one.
- **Timezone legacy-alias handling (found while capturing evidence, not requested):** this build
  host's own ICU lists the India zone as `Asia/Calcutta`, not `Asia/Kolkata` (both name the same
  real-world zone — `Intl.supportedValuesOf('timeZone')` returning one or the other is purely an
  ICU-vintage difference, not a bug in either name). The brief's own example ("kolkata" should
  match Asia/Kolkata) would have silently failed on a runtime that happens to expose the legacy
  spelling. `lib/timezones.ts` now matches a small set of legacy IANA link pairs
  (`Asia/Calcutta`↔`Asia/Kolkata`, `Europe/Kiev`↔`Europe/Kyiv`, and a few more) in both directions,
  so the search is robust to whichever name the runtime returns; the display always shows the
  runtime's own name honestly rather than silently rewriting it.
- **Dev port 18787, not 8787:** this is a shared build host running other concurrent worktree
  sessions (`wt-p2-onboarding` observed alongside this one); to capture evidence without risking a
  port clash with another session's `wrangler dev`, I ran mine on `18787` instead of the project's
  usual `8787`. Purely a local capture-session choice — nothing in the committed code assumes a
  fixed dev port, and `.claude/launch.json`'s `cloudbox-worker-dev` entry still targets `8787` (the
  project default) for normal use.
- Retire/reactivate confirmation is a plain named-and-counted dialog, not a typed-name
  confirmation (agent-notes ux-patterns "Confirmations" reserves typed-name for genuinely
  destructive, hard-to-reverse actions; retiring is reversible via reactivate).
- Query-plan guard: `screens.plans`'s subscription-count query (`GROUP BY plan_code` over the
  whole `subscriptions` table, a guarded table per `test/query-plans.test.ts`) is registered in
  `test/queries.ts` and passes the existing unindexed-scan check as-is — empirically verified, not
  assumed; D1/SQLite's plan for this aggregate did not trip the "SCAN TABLE" heuristic.

---

## Decisions needed

- None blocking. Worth a look if convenient: whether `PATCH /plans/:code` should also allow
  changing `status` directly (today status changes only through `/retire`/`/reactivate`, which is
  what gives the "N subscriptions on it" confirmation its number) — I kept status out of the
  general PATCH deliberately so that number can never go stale between reading and writing it.

---

## Requests to another worktree

- None. `term_days` is already aligned with WT-14 (their `planTermDays()` helper and the one test
  adjustment above); no other cross-worktree ask is open.

---

## Safe next action

Ready for review and merge into `phase-2/devices`. Draft PR titled "WT-13: plan designer, plan
selector, timezone selector" — do not merge without a human decision, per the standing instructions.

---

## Appendix: Evidence

- Screenshots: `docs/evidence/wt-p2-plans/01a-staff-login.png` through `11-tenant-created.png` (14
  files).
- Test output: see "Tests run and results" above; reproduce with
  `corepack pnpm run verify` from the repo root (about 1–2 minutes).
- Not deployed to `box.affinity.ai.in` — this worktree never deploys; that happens after merge
  via the existing GitHub Actions workflow.
