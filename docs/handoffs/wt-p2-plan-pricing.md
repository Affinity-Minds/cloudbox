# Handoff: WT-13 — Plan pricing, add-on users, validity

**Status:** Ready for review (draft PR against `phase-2/devices`)
**Date:** 2026-09-27
**Branch:** `wt/p2-plan-pricing` (from `origin/phase-2/devices` @ `dbe6ae0` — includes this
worktree's own earlier plan-designer slice already merged, WT-14's self-onboarding/licence-keys
slice, the schema consolidation into `db/schema.ts`, and WT-8's phase-2 review verdict, which
already carried a pre-written test for this exact slice)

---

## Mission

**Slice:** 3.7 (plan pricing, add-on users, validity).

**Success criterion:** a plan carries a price and an add-on-user price/cap; a subscription can buy
add-on managed users up to that cap; the effective managed-user limit (base + add-ons) is what the
device entitlement is actually issued with; every screen that shows a subscription's user limit or
price shows the effective, computed figures, not just the plan's bare numbers.

---

## Current status

- Branch: `wt/p2-plan-pricing`, parent `phase-2/devices` @ `dbe6ae0`.
- Commits: see below.
- `corepack pnpm run verify`: **green**, exit code checked directly (not piped).
- `drizzle-kit generate` reports "No schema changes, nothing to migrate" both before adding my
  schema change (confirming the branch's starting point was clean) and after renaming the
  generated migration to `0011_plan_pricing.sql` (confirming the snapshot/journal stayed correct).
- Live-verified with `wrangler dev` + a fresh local D1 (migrations 0001–0011) + a real Playwright
  session (password + computed RFC 6238 authenticator code) — 7 screenshots in
  `docs/evidence/wt-p2-plan-pricing/`.

---

## Files and contracts changed

- **migrations:** `0011_plan_pricing.sql` (reserved by this task, generated via `drizzle-kit
  generate` then renamed — not hand-written like 0009, since the branch's schema/snapshot are now
  properly reconciled).
- **worker-api:**
  - `src/db/schema.ts` — `plans`: `priceAmount`, `currency`, `addonUserPriceAmount`,
    `maxAddonUsers`. `subscriptions`: `addonUsers`. (Both tables otherwise untouched.)
  - `src/routes/v1/subscriptions.ts` — `toPlan`/`toSubscription` extended; plan create/update
    handlers carry the four pricing fields (optional, server-defaulted); subscription create/PATCH
    carry `addonUsers` with the plan-dependent bound check (`addon_users_exceeds_plan_max`).
  - `src/routes/v1/screens/subscriptions.ts` — plan pricing columns joined in; `toListItem` derives
    `effectiveMaxManagedUsers`/`totalPriceAmount`/`currency`.
  - `src/routes/v1/screens/tenants.ts` — same derivation for the tenant detail screen's
    subscriptions list (added a `plans` join to the existing subscriptions query — no extra round
    trip).
  - `src/entitlement/service.ts` — `issueForDevice` selects `subscriptions.addonUsers`; the claim's
    `max_managed_users` is `effectiveMaxManagedUsers(...)`.
  - `src/onboarding/license-keys.ts` (WT-14's file) — the batch-listing aggregate query gains a
    `plans` left join for `planPriceAmount`/`planCurrency` (display only).
  - `test/subscriptions.test.ts` — 8 new tests appended (see "Tests run and results").
- **contracts (`packages/contracts/src`):**
  - `subscriptions.ts` — `Currency`; `Plan`/`CreatePlanRequest`/`UpdatePlanRequest` extended
    (pricing fields optional on create, defaulted server-side); `Subscription` gains `addonUsers`;
    new `SubscriptionWithPricing` (used by `TenantDetailScreen`); `SubscriptionListItem`'s
    `Derived` gains `effectiveMaxManagedUsers`/`totalPriceAmount`/`currency`; two shared pure
    functions, `effectiveMaxManagedUsers()` and `totalPriceAmount()`.
  - `screens.ts` — `TenantDetailScreen.subscriptions` changed from `Subscription[]` to
    `SubscriptionWithPricing[]` (additive: every existing field is unchanged, `Subscription[]`
    consumers still type-check against the extended shape).
  - `license-keys.ts` (WT-14's file) — `LicenseKeyBatch` gains `planPriceAmount`/`planCurrency`.
- **admin-web:**
  - `src/components/plan-bits.tsx` — `CURRENCIES`, `formatMoney`, `minorToMajorInput`.
  - `src/components/plan-form-sheet.tsx` — Price/Currency/Add-on price/Max add-on users fields;
    major-unit ⇄ minor-unit conversion at the form boundary; "Term" relabelled "Validity".
  - `src/components/plan-select.tsx` — secondary line gains price/validity.
  - `src/routes/_app/plans.tsx` — Price column; "Term" column relabelled "Validity".
  - `src/routes/_app/subscriptions.tsx` (WT-5's file, additive) — "Add-on users" field + live
    computed effective-limit/total-price summary in the New subscription dialog.
  - `src/routes/_app/subscriptions.$id.tsx` — same in the Edit dialog; summary table gains a Price
    row and an add-on breakdown on the Managed users row.
  - `src/routes/_app/tenants.$tenantId.tsx` — Subscription tab gains the same two figures.
  - `src/routes/_app/licences.tsx` (WT-14's file, additive) — a Price column on the batches table.
- **Configuration:** none. No new bindings, vars, secrets or dependencies.

---

## Migrations

- Reserved `0011`, used: `infra/cloudflare/migrations/0011_plan_pricing.sql`.
- **Generated properly this time**: `pnpm --filter @cloudbox/worker-api exec drizzle-kit generate`
  against the Drizzle schema change, output renamed from its auto-generated name to
  `0011_plan_pricing.sql`, journal entry's `tag` field renamed to match. The `currency` enum check
  (D1 can't pair an ALTER-added column with an inline CHECK) was hand-appended as two triggers
  after the generated ALTER statements, using the same `CREATE TRIGGER IF NOT EXISTS` idiom as
  migration 0009 — triggers are invisible to `drizzle-kit`'s own diffing, so this doesn't disturb
  future generates (verified: a second `generate` immediately after still reports no changes).
- Applied locally: ✓ — fresh local D1, migrations 0001 through 0011 apply cleanly in order.

---

## API changes

See the tables in `docs/slices/3.7-plan-pricing.md`.

---

## Security assumptions

- Pricing fields follow the exact same staff-permission gate as the rest of the plan designer
  (`subscription.manage` for every write) — no new permission was introduced, and no new route was
  added, only fields on existing ones.
- `addon_users`'s upper bound (`≤ plan.maxAddonUsers`) is a data-dependent invariant, so it is
  enforced in the handler against a fresh read of the plan row, not trusted from the client and not
  a static Zod range — checked on both subscription create and PATCH, and only re-fetches the plan
  when `addonUsers` is actually present in a PATCH body (keeps the common-case round-trip count
  unchanged).
- The entitlement claim's `max_managed_users` is computed from the same `effectiveMaxManagedUsers`
  function the UI uses, so there is one definition of "effective limit", not two that could drift.
- Money is stored as integer minor units throughout the API and contracts; the admin UI is the only
  place major-unit strings exist, and only inside the plan form's own boundary
  (`majorUnitInput`/`minorToMajorInput` in `plan-form-sheet.tsx`/`plan-bits.tsx`).

---

## Tests run and results

### `corepack pnpm run verify` (worktree, on `origin/phase-2/devices` @ `dbe6ae0` + this branch's commits)

```
$ biome check .                      Checked 209 files. No fixes applied. (1 pre-existing warning,
                                      not mine: tests/e2e-cloud noTemplateCurlyInString)
$ pnpm typecheck                     contracts, licensing-contracts, tests/e2e-cloud, admin-web,
                                      worker-api: all Done
$ pnpm test
  packages/licensing-contracts       Test Files 2 passed (2)     Tests 16 passed (16)
  apps/admin-web                     Test Files 3 passed (3)     Tests 13 passed (13)
  apps/worker-api                    Test Files 34 passed (34)   Tests 633 passed (633)
$ pnpm build                         admin-web ✓ built; worker-api dry-run
                                      Total Upload 3187.07 KiB / gzip 550.09 KiB
EXIT 0
```

### Coverage (the 8 new tests, `apps/worker-api/test/subscriptions.test.ts`, describe block "plan
pricing and add-on users (WT-13, migration 0011)")

Pricing fields default to `0`/`'INR'`/`0`/`0` when omitted from `POST /plans` and store correctly
when given; invalid currency and negative/out-of-range values rejected (400); `read_only` 403 on a
priced plan create; a subscription with add-on users within the plan's max is created correctly;
add-on users **above** the plan's max are refused on both create and PATCH with
`addon_users_exceeds_plan_max`; **the entitlement claim's `max_managed_users` is the effective
limit** (verified against a real device, a real signing key, and a real `verifyEntitlement`
decrypt: `6 + 4 = 10`, not the plan's bare `6`); `effectiveMaxManagedUsers`/`totalPriceAmount`/
`currency` appear correctly on `GET /screens/subscriptions`.

Also re-verified: WT-8's own pre-written `test/review/phase-2-verdict.test.ts` "V2-5: WT-13 plan
routes" block passes **unmodified** — its `planBody()` helper posts without any pricing fields,
which is exactly why those fields had to be optional rather than required (see "Deviations").

Todo tests: **none.**

### Demo path (live-verified)

See `docs/slices/3.7-plan-pricing.md`'s demo path; screenshots in
`docs/evidence/wt-p2-plan-pricing/01-plans-table-before.png` through
`07-tenant-detail-subscription-tab.png`.

---

## Known failures

None outstanding in this slice's own scope.

---

## Deviations from the brief

- **Pricing fields are optional on `POST /plans`, not required.** The brief didn't specify this
  either way, and my first pass made them required, matching the style of the slice-3.6 fields.
  That broke WT-8's own pre-written review test for this slice
  (`test/review/phase-2-verdict.test.ts`, "V2-5"), whose `planBody()` helper posts a plan without
  any pricing fields and expects `201`. Since that test was already merged into `phase-2/devices`
  before I started (part of the "schema consolidation" the coordinator's message pointed at), I
  treated it as the authoritative contract and made all four fields optional, defaulting
  server-side to the column defaults. Every plan created by every other test, and by the UI's own
  create form (which always sends explicit values), is unaffected.
- **Effective limit uses `subscription.maxManagedUsers`, not `plan.maxManagedUsers`.** The brief's
  wording ("plans.max_managed_users + subscriptions.addon_users") reads as the plan's base; I used
  the *subscription's* `maxManagedUsers` instead, because that column already resolves from the
  plan's base at subscription-creation time and can be staff-overridden per subscription (an
  existing, unrelated feature — see slice 3.1). Add-ons layer on top of whatever that resolved
  value is, so an overridden subscription's effective limit stays internally consistent rather than
  silently reverting to the plan's bare number. Flagging this interpretation explicitly in case the
  owner intended the literal plan value regardless of a subscription override.
- **License-key batch price is a `min()` aggregate over the plan's *current* price**, joined at
  read time — it is not captured at batch-creation time. If a plan's price changes after a batch is
  generated, every batch on that plan will show the new price retroactively. The brief said "for
  display only", which I read as "this is informational, not a stored/frozen fact" — consistent
  with that reading, but flagging the retroactive-change behavior explicitly since "for display
  only" could also have meant "frozen at creation, just never billed from directly."
- Money formatting uses `Intl.NumberFormat`'s `currency` style throughout (`formatMoney` in
  `plan-bits.tsx`) rather than hand-built per-currency symbol placement — matches the same
  "runtime's own database, not hand-maintained" principle used for the timezone selector in the
  prior slice.

---

## Decisions needed

- [ ] Confirm the effective-limit base is the *subscription's* `maxManagedUsers` (as built) rather
  than always the plan's own `maxManagedUsers` (see "Deviations" above) — only matters for a
  subscription whose `maxManagedUsers` was staff-overridden away from its plan's default.
- [ ] Confirm license-key batch pricing showing the plan's *current* price (not frozen at batch
  creation) is the intended "for display only" behavior.

---

## Requests to another worktree

None outstanding.

---

## Safe next action

Ready for review and merge into `phase-2/devices`. Draft PR titled "WT-13: plan pricing, add-on
users, validity" — do not merge without a human decision, per the standing instructions.

---

## Appendix: Evidence

- Screenshots: `docs/evidence/wt-p2-plan-pricing/01-plans-table-before.png` through
  `07-tenant-detail-subscription-tab.png` (7 files).
- Test output: see "Tests run and results" above; reproduce with `corepack pnpm run verify` from
  the repo root.
- Not deployed to `box.affinity.ai.in` — this worktree never deploys; that happens after merge
  via the existing GitHub Actions workflow.
