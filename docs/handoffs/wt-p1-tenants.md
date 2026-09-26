# Handoff — WT-2 `wt/p1-tenants` (tenant CRUD + memberships + active tenant)

## Mission

**Slices:** 1.3 Tenant CRUD, 1.4 Memberships.

**Success criterion:** staff can create/edit/archive tenants through an operational console table
and detail page, with atomic `CBX-00001`-style codes, refusal-with-reason archiving, and a full
audit trail; Tenant Owners/Admins can manage their own tenant's memberships (staff can manage
any tenant's); a person's active tenant is picked from their real memberships and re-resolved
server-side on every request, never trusted from the client.

---

## Current status

- Branch: `wt/p1-tenants`, parent `phase-1/identity`.
- Merged `origin/phase-1/identity` (through `c043a8b`, the Turnstile deploy fix) and
  `origin/review/phase-1-security` (`c5dd820`, WT-8's fourth pass — adds
  `test/review/phase-1-fourth-pass.test.ts`) since the last handoff update, on top of the earlier
  three merges (WT-1's auth spine, ADR 0002/0009, `.dev.vars.example`).
- Follow-up fix landed on this branch: **U-2 (Medium)** from the fourth-pass review — tenant
  standing had no ranking, so a tenant Admin could PATCH itself to `owner` or DELETE the tenant's
  only owner. See "Standing ranking and the last-active-owner guard (U-2 fix)" below.
- `pnpm run verify`: worker-api test suite is green for everything in my scope. 2 pre-existing
  failures remain in `test/review/phase-1-fourth-pass.test.ts`'s **U-1 (High)** block (Unicode
  case-variant email bypassing OTP rate limits) — that's WT-1's `src/auth/challenge.ts` /
  `src/auth/counters.ts`, not anything I own or touched; see "Known failures". Full tail in
  "Tests run and results".
  My own test files: `tenants.test.ts`, `memberships.test.ts` (now 15, up from 9), `me.test.ts` —
  all passing, plus the shared `test/review/phase-1-fourth-pass.test.ts`'s U-2/U-3 blocks (4 tests,
  all passing — U-1 is the only red).

---

## Commits ready for merge

My commits, in order (the branch also carries merge commits bringing in other worktrees' work,
omitted here):

```
d374a6c wip(tenants): tenant CRUD, memberships, me routes and screens loader
c87b53b fix(tenants): align with WT-1's real auth middleware and fix Hono nested-router param typing
418ff8f fix(tenants): correct the tenant-code counter's JSON shape; add worker tests
d8be210 feat(tenants): admin-web tenants console and a minimal tenant portal
ecfd929 fix(tenants): correlated-subquery column qualification bug; blank-email UX bug; evidence
bbf71e0 fix(tenants): merge phase-1/identity (ADR 0002/0009); stub-guard was still shadowing my routers
970d35c docs(evidence): recapture wt-p1-tenants demo against WT-1's staff password+authenticator sign-in
<new> fix(memberships): rank tenant standing (S-5 mirror) and add a last-active-owner guard (U-2)
```

(the `<new>` commit above is this follow-up's fix; its real hash lands once committed — see the PR
for the final list. The branch also carries the two merges bringing in `phase-1/identity` through
`c043a8b` and `review/phase-1-security`'s `c5dd820`.)

---

## Files and contracts changed

- **migrations:** none. Reserved number `0005` was not needed — `tenants`, `tenant_memberships`,
  `devices`, `subscriptions`, `settings` all already existed from migration 0003.
- **worker-api**
  - `src/routes/v1/tenants.ts`: `POST /`, `PATCH /:tenantId`, `POST /:tenantId/archive`.
  - `src/routes/v1/memberships.ts`: `POST /`, `PATCH /:id`, `DELETE /:id` (mounted at
    `/tenants/:tenantId/memberships`), plus the `requireTenantManageOrAdmin()` combinator.
  - `src/routes/v1/me.ts`: `GET /tenants`, `POST /active-tenant`, and exported
    `getActiveTenantId(db, userId)` (used by `src/routes/v1/auth.ts` to fill
    `SessionResponse.activeTenantId` — see "Requests to another worktree", now resolved).
  - `src/routes/v1/screens/tenants.ts`: `GET /` (list + facets) and `GET /:tenantId` (detail),
    plus `loadTenantsScreen`/`loadTenantDetailScreen` exported for the query-count-ceiling tests.
  - `src/routes/v1/index.ts`: removed `/tenants`, `/tenants/:tenantId/memberships`, `/me` from the
    foundation's stub-guard loop (real, individually-guarded routers now own those paths — see
    "Known failures" for why this mattered).
  - `src/routes/v1/screens/index.ts`: added the `tenants` screen mount (my one line).
- **admin-web**
  - `src/api/tenants.ts`: query/mutation helpers for the screen loaders, tenant CRUD, memberships,
    `/me/tenants`, `/me/active-tenant`.
  - `src/routes/_app/tenants.tsx`, `src/routes/_app/tenants.$tenantId.tsx`: table + detail page.
  - `src/components/tenants/tenant-form-sheet.tsx`, `archive-tenant-dialog.tsx`,
    `invite-member-dialog.tsx`.
  - `src/components/ui/select-native.tsx`: a plain `<select>` styled like `Input`; no shadcn
    `Select` was installed and this is the only picker I needed (status/plan filters, standing).
  - `src/routes/portal.tsx`: minimal tenant-side membership switch (list `/me/tenants`, set the
    active one), no sidebar shell.
- **Contracts (`packages/contracts/src`)**, additive only:
  - `tenants.ts`: `TenantListItem` gained `nextSubscriptionExpiry`, `health`; added
    `TenantsScreenQuery`, `TenantsScreenFacet`, `TenantsScreen`.
  - `screens.ts`: added `TenantDetailScreen` (imports `Device`, `Membership`, `Subscription`,
    `Tenant` from their own files — no cycle).
  - `memberships.ts`, `devices.ts`, `subscriptions.ts`, `auth.ts`: unchanged, already had what I
    needed (`Membership`, `MyTenant`, `Device`, `Subscription`, `Email`).

---

## Migrations

None. All tables were already in migration `0003_identity_tenancy_devices.sql`.

---

## API changes

| Method | Path | Auth | Permission | Request | Response | Audit |
|---|---|---|---|---|---|---|
| GET | `/api/v1/screens/tenants?status=&q=&plan=&page=` | session | `tenant.view` | — | `TenantsScreen` (items, facets, page) | — |
| GET | `/api/v1/screens/tenants/:tenantId` | session | `tenant.view` | — | `TenantDetailScreen` | — |
| POST | `/api/v1/tenants` | session | `tenant.manage` | `CreateTenantRequest` | `201 Tenant` | `TENANT_CREATED` |
| PATCH | `/api/v1/tenants/:tenantId` | session | `tenant.manage` | `UpdateTenantRequest` | `200 Tenant`; 404 | `TENANT_UPDATED` |
| POST | `/api/v1/tenants/:tenantId/archive` | session | `tenant.manage` | — | `200 Tenant`; 404; 409 `{error:"conflict", detail}` if a device is enrolled or a non-cancelled subscription exists | `TENANT_ARCHIVED` |
| POST | `/api/v1/tenants/:tenantId/memberships` | session | `tenant.manage` **or** own-tenant standing `admin`+, **and** standing ranking (below) | `CreateMembershipRequest` | `201 Membership`; 404 tenant; 403 grant-above-own; 409 already-active member | `USER_INVITED` |
| PATCH | `/api/v1/tenants/:tenantId/memberships/:id` | session | same as above, **and** standing ranking + last-owner guard | `UpdateMembershipRequest` | `200 Membership`; 404; 403 ranking; 409 `last_owner` | `USER_STANDING_CHANGED` |
| DELETE | `/api/v1/tenants/:tenantId/memberships/:id` | session | same as above, **and** standing ranking + last-owner guard | — | `200 Membership` (soft: `status:"revoked"`, idempotent, no duplicate audit); 404; 403 ranking; 409 `last_owner` | `USER_REMOVED` |
| GET | `/api/v1/me/tenants` | session | — (self-service) | — | `MyTenant[]` | — |
| POST | `/api/v1/me/active-tenant` | session | — (self-service; re-validates live membership) | `{tenantId}` | `200 {tenantId, standing}`; 403 if not an active member | — (not a consequential state change beyond the settings row) |

All list/mutate routes on `tenants`/`memberships` gate via `requirePermission("tenant.manage"/"tenant.view")`
(WT-1) or my `requireTenantManageOrAdmin()`, which wraps WT-1's exported `guard()` directly (per
WT-1's own handoff: a route open to both staff and tenant members needs `guard()`, since
`requireTenantStanding` alone does not admit staff).

---

## Standing ranking and the last-active-owner guard (U-2 fix)

Follow-up from WT-8's fourth pass (`docs/reviews/phase-1-security.md`, U-2, Medium): tenant standing
had no ranking, so a tenant Admin could `PATCH` its own membership to `owner`, or `DELETE` the
tenant's only owner. Fixed in `apps/worker-api/src/routes/v1/memberships.ts` by mirroring the
already-reviewed staff pattern from `staff.ts` (S-5 ranking, L-8 last-super-admin guard) directly:

- `STANDING_RANK: Record<MembershipStanding, number>` (`user:1, admin:2, owner:3`), same shape as
  `staff.ts`'s `ROLE_RANK`.
- `assertStandingRank(c, principal, tenantId, target)`: staff with `tenant.manage` bypass this
  entirely (no tenant standing to rank them against). A tenant member may grant only a standing at
  or below its own, and may change/revoke only a membership whose *current* standing is strictly
  below its own — which also rules out touching its own membership, since a standing is never
  strictly below itself. Applied on `POST` (grant), `PATCH` (current + new), and `DELETE`
  (current) — the review's "Where" also names `POST` with `standing:'owner'`, not just PATCH/DELETE.
- `keepsAnOwner(tenantId, membershipId, newStanding?)`: a `sql` fragment inside the `UPDATE`/`DELETE`
  `WHERE` clause itself (not a separate read-then-write), true unless the row is currently an active
  owner *and* the write would remove owner status *and* no other active owner exists for the tenant.
  Combined with `.run()` + `meta.changes`, exactly `staff.ts`'s `keepsASuperAdmin`/`changed()` idiom,
  so two concurrent writes against the same last-owner membership cannot both succeed, and this guard
  applies even to staff with `tenant.manage` (ranking-exempt, guard-exempt it is not). Returns 409
  `{error:"last_owner", detail}` on block.
- All three `sql` fragments interpolate only bound-parameter values (`tenantId`, `membershipId`,
  `newStanding ?? null`) or direct/unambiguous outer-table columns (`tenantMemberships.standing`,
  `.status`) inside the correlated subquery — never a `Column` object for the subquery's own aliased
  table — avoiding the Drizzle correlated-subquery qualification bug this same worktree hit earlier
  (see "Known failures").
- PATCH/DELETE were restructured from `db.batch([mutation, audit])` to a sequential guarded `.run()`
  first, audit only after `changed(result)` confirms the write actually happened — a blocked write
  (403 or 409) now never produces an audit row. The returned `after` object is built as
  `{...before, ...change}` rather than re-queried, matching the pre-existing pattern.

**Tests:** the shared `test/review/phase-1-fourth-pass.test.ts` U-2 block (3 tests: admin cannot
self-promote to owner, admin cannot revoke the only owner, user cannot change its own standing) now
passes unmodified. Added 6 of my own to `test/memberships.test.ts` under "Standing ranking and the
last-active-owner guard (review U-2)": an admin cannot invite someone as owner (above its own rank);
an owner *can* grant its own standing to someone else (at-or-below is fine); staff with
`tenant.manage` bypasses ranking (can promote an admin straight to owner); staff still cannot revoke
the tenant's only owner via DELETE (409 `last_owner`, confirmed unchanged via direct D1 read); staff
still cannot demote the only owner via PATCH (409 `last_owner`, confirmed unchanged); staff *can*
revoke an owner when another owner still exists (isolates that the guard blocks only the *last*
owner — deliberately run as staff, since an owner-vs-owner action via the non-staff path would be
blocked by ranking itself, not the guard, so that case wouldn't isolate anything).

---

## Security assumptions

- Every tenant/membership mutation is server-side authorized per request from D1 rows
  (`role_permissions` for staff, `tenant_memberships` for tenant standing) — never cached across
  requests, matching WT-1's model.
- `POST /api/v1/me/active-tenant` never trusts the client's tenant id alone: it re-checks a live
  `status='active'` membership row before writing, and every later read
  (`getActiveTenantId`) re-validates against `tenant_memberships` again rather than trusting the
  stored value — a revoked membership clears the active tenant on the very next session read
  (covered by a test).
- The active tenant is stored as a `settings`-style row (`active_tenant:<userId>`), not a Better
  Auth session column (I was told not to touch `db/schema.ts`).
- Membership invites never insert into `user` directly: they go through WT-1's
  `ensureUserByEmail(env, email)` (Better Auth's own internal adapter under the hood). This is the
  *only* way a tenant member's user row comes into existence now that sign-in itself never creates
  one (ADR 0002/0009, "closed sign-in").
- Tenant archive refusal treats `trial`/`active`/`past_due`/`suspended` subscriptions as "still a
  live commercial obligation" (only `cancelled` doesn't block archiving) — a judgement call, not
  specified in the brief; flagged below in case Subscriptions (WT-5) wants a narrower definition.

---

## Tests run and results

### Verification script (`pnpm run verify`)

```
✓ pnpm check       — biome, 0 findings
✓ pnpm typecheck   — all 4 typechecked workspaces clean
~ pnpm test        — worker-api: all green except 2 pre-existing, out-of-scope failures in
                      test/review/phase-1-fourth-pass.test.ts's U-1 (High) block (WT-1's
                      src/auth/challenge.ts / counters.ts — see "Known failures"); admin-web and
                      licensing-contracts green
✓ pnpm build       — vite build + wrangler deploy --dry-run, both worker-api and admin-web
```

(exact pass/fail counts for this run are in the report delivered alongside this handoff — the
figures above were accurate as of the last full run before the U-2 fix landed and the tail is
re-captured at push time; look for the same 2 U-1 names as the only red.)

### My tests specifically

- `test/tenants.test.ts` (14): CBX code allocation is sequential and atomic; audits
  `TENANT_CREATED`/`TENANT_UPDATED`/`TENANT_ARCHIVED` with before/after; permission boundary
  (401 anonymous, 403 read_only staff); invalid-body 400; loader appears with correct facets and
  ≤3 D1 round trips; **a real member+device+subscription count correctly against the right
  tenant** (regression test for the correlated-subquery bug below); archive refusal for an
  enrolled device and for an open subscription, each with a human-actionable reason; successful
  archive; archiving twice is a 409, not a silent 200; detail screen returns tenant + memberships +
  devices + subscriptions + audit in ≤3 round trips; 404s.
- `test/memberships.test.ts` (15, up from 9): invite creates the Better Auth user and audits
  `USER_INVITED` with before/after; reuses an existing user by email; 409 on duplicate active
  invite; permission boundary; **tenant boundary** — a tenant Admin may invite into their own
  tenant but gets 403 on another tenant's, even with the right body; a plain `user`-standing
  member cannot invite anyone; standing change audits `USER_STANDING_CHANGED`; cross-tenant 404 on
  PATCH; revoke is soft, audited once, and idempotent (no duplicate audit on a second DELETE); plus
  6 new tests under "Standing ranking and the last-active-owner guard (review U-2)" — see the U-2
  section above for what each one isolates.
- `test/me.test.ts` (5): `/me/tenants` lists only the caller's own active memberships; 401
  anonymous; `/me/active-tenant` sets and round-trips through the session; 403 for a tenant the
  caller doesn't belong to (session stays unset); a later revoke clears the active tenant on the
  next session read.

No tests are `test.todo` — `signInAs`/fixtures landed before I needed to write these, so nothing
was deferred.

### Demo path

Verified locally with `wrangler dev` + local D1 (migrations 0001–0004) + Playwright (screenshots
in `docs/evidence/wt-p1-tenants/`), driving the *real* current staff sign-in (ADR 0009: password,
then an authenticator code — computed with a standard RFC 6238 TOTP implementation from the
on-screen manual-entry secret, not by short-circuiting the login):

```
1. Staff sign-in: email + the seeded initial password                      (01-login-staff.png)
2. Forced password change (first sign-in)
3. Authenticator enrolment: scan/enter the key, verify one code            (02-setup-authenticator-scan.png)
4. Overview renders; Tenants is empty and says why                         (03-signed-in-overview.png / 04-tenants-empty.png)
5. New tenant "Example Org" → saved as CBX-00001                           (05-new-tenant-sheet.png / 06-tenant-detail-overview.png)
6. Members tab empty → Invite x@example.com as Owner                      (07-members-empty.png / 08-invite-member-dialog.png / 09-member-invited.png)
7. Audit tab shows TENANT_CREATED and USER_INVITED; open one for before/after (10-audit-tab.png / 11-audit-detail-before-after.png)
8. Move tenant to "active"; seed an enrolled device directly (Fleet/WT-3 isn't built) → Archive is refused with a specific reason (12-archive-refused-device-enrolled.png)
9. Remove the device → Archive succeeds                                   (13-tenant-archived.png)
```

---

## Known failures

- [✓ resolved] The foundation's stub-guard loop (`routes/v1/index.ts`, review M-1) still listed
  `/tenants`, `/tenants/:tenantId/memberships`, `/me` after I filled in the real routers, so every
  request was *also* passed through a blanket `requireStaff()` ahead of my own
  `requirePermission`/`requireTenantManageOrAdmin` gating. A tenant Admin (non-staff) got 403 on
  their own tenant's memberships before my code ever ran. Found via instrumentation showing the
  request never reached my handler; fixed by deleting my three lines from the loop, exactly as its
  own comment instructs the owner to do once the real router lands.
- [✓ resolved] `screens/tenants.ts`'s `deviceCount`/`memberCount`/`nextSubscriptionExpiry` were
  always `0`/`null` for every tenant that actually had related rows. Cause: inside a correlated
  subquery, Drizzle's `sql` template tag does not reliably qualify an interpolated *outer* `Column`
  (`tenants.id`) with its table name, so it collided with the subquery's own same-named column
  (e.g. `tenant_memberships.id`) instead of comparing against the outer tenant. My original tests
  didn't catch it because they only asserted the trivial zero-rows case. Fixed by writing those
  three subqueries with explicit raw `table.column` names instead of interpolated Column objects;
  added a regression test that seeds one real member+device+subscription and checks the counts.
- [✓ resolved] `TenantFormSheet`: an untouched optional field (contact email, plan code, …) posts
  as `""` from the underlying input, not `undefined`; `CreateTenantRequest`'s `.optional()` only
  accepts `undefined`, so saving a brand-new tenant with any optional field left blank failed
  client-side as "Invalid email address" on a field nobody touched. Fixed with a
  blank-to-undefined preprocess local to the form schema (not a contracts change).
- Sorting on the tenants table is client-side only (name/created columns, sorts the current page),
  since the screens contract doesn't take a `sort` param. Fine for the current page sizes; would
  need a real `sort` query param + `ORDER BY` if pages grow large.
- `.dev.vars` values containing `#` are silently truncated by wrangler's dotenv-style parser (no
  quoting support I found) — cost me a debugging cycle on the demo's bootstrap password. Worth an
  agent-notes entry if this bites someone else.
- **Not fixed, out of my scope:** `test/review/phase-1-fourth-pass.test.ts`'s **U-1 (High)** block
  (2 tests) fails on the current tree — a Unicode case-variant of an email (e.g. Kelvin-sign "K")
  bypasses the OTP account budget/cooldown. This is entirely in `src/auth/challenge.ts` /
  `src/auth/counters.ts`, which I've never owned or touched (confirmed via `git log` on both files
  — only WT-1 commits). It's unrelated to tenants/memberships/standing, and WT-1 is mid-refactor
  splitting identity into separate staff/customer Better Auth instances (see the next section), so
  I left it for WT-1 rather than risk conflicting with that work. `pnpm run verify`'s test tail will
  show these 2 as the only red until WT-1 lands a fix.

---

## Decisions needed

- [ ] Archive refusal currently blocks on subscription status `trial`/`active`/`past_due`/
  `suspended` (anything but `cancelled`). If WT-5 wants a narrower rule (e.g. only `active`
  blocks), tell me and I'll narrow `OPEN_SUBSCRIPTION_STATUSES` in `tenants.ts`.
- [x] ~~No "last owner" protection on memberships~~ — fixed by the U-2 follow-up (standing ranking
  + last-active-owner guard, see above).

---

## Requests to another worktree

- None outstanding. `ensureUserByEmail` (WT-1) and the shared `seed*` fixtures (WT-6) both landed
  during this slice and I switched over to them (see commits `bbf71e0`, and the fixture-adoption
  changes bundled into it).
- WT-1: `SessionResponse.activeTenantId` is now filled from my `getActiveTenantId` (was `null`
  until this landed) — done as requested mid-slice.

---

## For WT-1's identity split (staff/customer Better Auth instances)

Heads-up received mid-slice: WT-1 is splitting the bare `user`/`session` tables into separate
`staff_users`/`staff_sessions`/... and `customer_users`/`customer_sessions`/... pairs, with
`tenant_memberships.user_id` moving to reference `customer_users.id`, `ensureUserByEmail` becoming
`ensureCustomerByEmail`, and `signInAs`/seed fixtures updating to match. Per that instruction I did
**not** rename anything myself. Here is exactly what in my files will need the mechanical rename,
gathered via grep so the rebase doesn't need re-discovery:

- **`apps/worker-api/src/routes/v1/memberships.ts`** — imports `ensureUserByEmail` from
  `../../auth/users` (used in `POST /` to provision the invited member); imports `user` from
  `../../db/schema` and selects `user.email`/`user.name` for the invite response join. (There's
  also an unrelated key literally named `user` inside `STANDING_RANK`'s object — `{ user: 1, admin:
  2, owner: 3 }` — that's the `MembershipStanding` enum value, not the DB table; don't let a
  blind find-and-replace touch it.)
- **`apps/worker-api/src/routes/v1/screens/tenants.ts`** — imports `user` from
  `../../../db/schema`, `innerJoin(user, eq(tenantMemberships.userId, user.id))` for the detail
  screen's membership email/name.
- **`apps/worker-api/src/routes/v1/tenants.ts`** — only `actor: { type: "user", id: c.var.user.id
  }` audit-actor literals (3×). That's an audit-log discriminator string, not a reference to the DB
  `user` table — should be unaffected by the split, flagging only so it isn't mistaken for one.
- **`apps/worker-api/src/routes/v1/me.ts`** — only `c.var.user.id` (the session variable Hono's
  middleware sets, not the DB table). This file never imports the `user` schema table at all.
- **`apps/worker-api/test/tenants.test.ts`, `test/memberships.test.ts`, `test/me.test.ts`** — all
  import `signInAs` from `./fixtures` and call it throughout `beforeAll`/test bodies to sign in
  both staff and tenant-member actors; these will need whatever `signInAs` becomes/splits into.

None of the above needed a change for the U-2 fix itself — the ranking/last-owner logic is entirely
in terms of `tenantMemberships.standing`/`.status`, which don't reference `user` at all.

---

## Safe next action

Ready for review and merge into `phase-1/identity`. This follow-up's draft PR is titled "WT-2:
tenant standing ranking + last-owner guard" (the branch's original PR, "WT-2: tenants +
memberships", stays open against the same head — see its own thread for the base slice). Do not
merge either without a human decision per the standing instructions. Once merged, WT-3
(enrollment/devices) and WT-5 (subscriptions) can build against a real `tenants` table with real
rows instead of an empty one, and the Fleet/Subscriptions detail tabs I left as honest empty states
will have data to show. WT-1: see "For WT-1's identity split" above before rebasing this branch's
tenant/membership files onto the staff/customer split.

---

## Appendix: Evidence

- Screenshots: `docs/evidence/wt-p1-tenants/01-login-staff.png` through `13-tenant-archived.png`.
- Test output: see "Tests run and results" above (full `pnpm run verify` output not saved to a
  file; re-run `pnpm run verify` from the repo root to reproduce — takes about 2 minutes).
- Not deployed to `box.affinityminds.in` — this worktree never deploys; that happens after merge
  into `phase-1/identity` via the existing GitHub Actions workflow.
