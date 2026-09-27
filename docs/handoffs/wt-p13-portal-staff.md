# Handoff: WT-15 — Customer portal + staff screen (Slices 13.1, 1.6)

**Status:** Ready for review (draft PR against `phase-2/devices`)
**Date:** 2026-09-27
**Branch:** `wt/p13-portal-staff` (from `phase-2/devices` @ `33862a5`)

---

## Mission

**Slices:** 13.1 (tenant portal — customer-side administration) and 1.6 (staff screen, ops console).

**Success criterion:**

- A tenant member signs in at `/login` and lands in a calm, non-console portal scoped to their own
  tenants: Home (Tenant ID + plan banner + counts), CloudBoxes (their activated servers), Members
  (who can sign in to their portal), Subscription (read-only), Activate a server (mint an
  enrollment grant). A member of several tenants switches between them from the header; nothing
  here can reach another tenant's data or render the staff console's chrome.
- Staff holding `staff.manage` see and manage everyone who can sign in to the ops console from one
  screen under Govern > Staff: a table (email, role, authenticator enrolled, must-change-password,
  last sign-in, created), an Add staff sheet (generated initial password, shown once), Reset
  (new password + forced change + authenticator drop + session end, confirmed), and Revoke with an
  optional reason.

---

## Current status

- Branch: `wt/p13-portal-staff`, parent `phase-2/devices` (forked at `33862a5`)
- Work was produced by an agent that was killed mid-session by an app crash; picked up and
  finished in this session. Verified in isolation before gating: worker-api 661 tests, admin-web 16
  tests, `check`/`typecheck`/`build` all clean.
- Housekeeping done before gating: killed leftover `workerd`/`wrangler` processes bound to this
  worktree (port 18787 had nothing listening, but ~28 orphaned `workerd` child processes from this
  worktree's own test runs were still resident and were killed); deleted scratch files
  (`apps/worker-api/.seed-demo.sql`, `tests/e2e-cloud/.capture-portal-evidence.mjs`,
  `tests/e2e-cloud/.capture-staff-only.mjs`, `apps/worker-api/.dev.vars`,
  `apps/worker-api/.wrangler/`) — none of these were tracked by git (all gitignored). Kept
  `docs/evidence/wt-p13-portal/*.png`.

---

## Files and contracts changed

- **worker-api:**
  - `src/routes/v1/portal.ts` (new): the customer portal's own screens, mounted at
    `/api/v1/tenants/:tenantId/portal` (one import + one mount line in `routes/v1/index.ts`). Four
    `GET` routes — `/` (Home), `/members`, `/devices`, `/subscription` — every one gated by the
    real fixed gate `requireTenantStanding('user')` (any active member of `:tenantId` may read);
    mutations stay on their owners' existing routes (`memberships.ts` for invite/standing/revoke,
    `self-service.ts` for activation grants). Devices reuses WT-3's `loadFleet` directly, forced to
    exactly the path's tenant — never the wider `?tenant=` a caller could otherwise pass. The
    subscription line reuses WT-14's `tenantPlanQuery`/`toTenantPlan` and WT-5/13's pricing helpers.
  - `src/routes/v1/staff.ts`: additive — `GET /` (list) now also returns `twoFactorEnabled`,
    `mustChangePassword`, `lastSignInAt` (a correlated subquery against `audit_log` for the most
    recent `AUTH_LOGIN_SUCCEEDED` row, written with an explicit `audit_log.entity_id` per the
    column-qualification bug WT-2's handoff documents). `DELETE /:userId` now reads an optional
    `{reason}` body (`RevokeRequest`) and folds it into the audit row's `after` — never onto the
    `staff_members` row itself.
  - `src/routes/v1/memberships.ts`: same optional-reason treatment on `DELETE /:id` (tenant
    membership revoke), same "audit row only" placement.
  - `src/routes/v1/index.ts`: `import portal from "./portal"` + one mount line
    (`v1.route("/tenants/:tenantId/portal", portal)`).
  - `src/ops-shell.ts`: **fixed a real pre-existing bug.** `OPS_ROUTES` (the regex that decides
    whether a document is served as the staff SPA shell) was missing `/plans` — the Plans nav item
    has existed since WT-13 but a direct load of `/ops/plans` (refresh, bookmark, deep link) has
    been falling through to whatever the fallback document is instead of the ops shell, ever since
    Plans shipped. This slice adds both `/staff` (new) and `/plans` (pre-existing bug, unrelated to
    this slice's own feature) to the regex in the same line. Covered by two new assertions in
    `test/ops-shell.test.ts`.
  - `test/portal.test.ts` (new, 12 cases), `test/staff.test.ts` (+2 cases: new list fields,
    revoke-with-reason), `test/queries.ts` (+6 entries, one per new query shape in `portal.ts`),
    `test/review/phase-1-second-pass.test.ts` (`CUSTOMER_ONLY` predicate extended with a narrow
    regex for `/tenants/:tenantId/portal(/|$)` — not the whole `/api/v1/tenants` prefix, which stays
    staff-gated CRUD), `test/ops-shell.test.ts` (+2 assertions: `/ops/staff` and `/ops/plans` both
    now serve the shell).
- **contracts (`packages/contracts/src`):**
  - `portal.ts` (new): `PortalHome`, `PortalMember`, `PortalMembersScreen`, `PortalSubscription`,
    `PortalSubscriptionScreen`. Devices reuses the existing `FleetScreen` rather than a parallel
    type. `index.ts` gained one additive `export *` line.
  - `auth.ts`: `StaffMember` gained three additive fields (`twoFactorEnabled`, `mustChangePassword`,
    `lastSignInAt`); new `RevokeRequest` (`{reason?: string, 1-280 chars, trimmed}`) shared by both
    revoke routes above.
- **admin-web:**
  - `src/portal/` gained a shell (`portal-shell.tsx`: header, tenant switcher, tab nav, sign out)
    and five page files: `home-page.tsx`, `cloudboxes-page.tsx`, `members-page.tsx`,
    `subscription-page.tsx`, `activate-page.tsx`, plus `require-active-tenant.tsx` (a small guard
    used by the tenant-scoped pages). `portal-page.tsx`'s old single-page body was split: the
    tenant-switch list is now the reusable `TenantSwitchList` (used by the new Home page); the old
    `PortalPage` export is kept (unused by the router now) for anything still importing it.
  - `src/portal/router.tsx`: `/portal` becomes a layout route (`PortalShell`) with five children —
    `/portal`, `/portal/cloudboxes`, `/portal/members`, `/portal/subscription`, `/portal/activate` —
    registered with `createRoute()` in this same code-based router, not as file-based routes (see
    "Security assumptions / structural notes" below for why).
  - `src/api/portal.ts` (new): `portalHomeQuery`, `portalMembersQuery`, `portalDevicesQuery`,
    `portalSubscriptionQuery` — plain `queryOptions`, no mutations (all writes go through the
    existing `api/tenants.ts` / membership mutation hooks).
  - `src/api/onboarding.ts`: additive — `createActivationGrant()`, used by the new Activate page
    (calls the existing `POST /api/v1/onboarding/activation-grants`; no new server route).
  - `src/api/tenants.ts`: `removeMember()` gained an optional third `reason` parameter, forwarded as
    the DELETE body — used by the Members page's revoke-with-reason control.
  - `src/api/staff.ts` (new): `staffQuery`, `upsertStaff` (create or reset — same call), `revokeStaff`
    (optional reason).
  - `src/routes/_app/staff.tsx` (new): the Staff screen — table, Add sheet, Reset dialog, Revoke
    dialog, all client-side ranking mirrors of the server's own `ROLE_RANK` check (never the actual
    gate). `beforeLoad` redirects a session without `staff.manage` before the page renders anything.
  - `src/nav.ts`: one new line, `{ key: "staff", title: "Staff", to: "/staff", icon: Users }` under
    Govern.
  - `src/routeTree.gen.ts`: regenerated (TanStack Router file-route codegen) to include
    `/_app/staff`.
  - `src/routing.test.ts` (new, 3 cases — see "Tests" below).

---

## Migrations

None. No new dependency, no schema change. Every field read is already present in `tenants`,
`tenant_memberships`, `devices`, `subscriptions`, `plans`, `staff_members`, `staff_users`,
`audit_log`.

---

## API changes (`/api/v1`)

| Method | Path | Auth | Response | Notes |
|---|---|---|---|---|
| GET | `/tenants/:tenantId/portal` | customer, `requireTenantStanding('user')` | `PortalHome` | Tenant row, caller's own standing, plan, member/device counts |
| GET | `/tenants/:tenantId/portal/members` | customer, `requireTenantStanding('user')` | `PortalMembersScreen` | Active memberships of exactly this tenant |
| GET | `/tenants/:tenantId/portal/devices` | customer, `requireTenantStanding('user')` | `FleetScreen` | Delegates to WT-3's `loadFleet`, hard-scoped to this tenant |
| GET | `/tenants/:tenantId/portal/subscription` | customer, `requireTenantStanding('user')` | `PortalSubscriptionScreen` | Newest non-cancelled subscription, or `{subscription: null}` |
| GET | `/staff` | staff, `staff.manage` | `{items: StaffMember[]}` (unchanged shape + 3 additive fields) | unchanged route, additive fields |
| DELETE | `/staff/:userId` | staff, `staff.manage` | 204 | now reads optional `{reason}` body |
| DELETE | `/tenants/:tenantId/memberships/:id` | staff (owner/admin ranking) | 204 | now reads optional `{reason}` body |

No new audit event types. Revoke (both routes) folds `reason` into the existing audit row's
`after` only when supplied; `STAFF_ROLE_GRANTED`/`STAFF_ROLE_REVOKED` and the membership equivalents
are otherwise unchanged.

---

## Security assumptions

- **Tenant scoping comes from the path, never from anything else the caller supplies.**
  `requireTenantStanding('user')` re-resolves the caller's `tenant_memberships` row for
  `:tenantId` on every request (never cached, never trusted from a session flag). The
  `/portal/devices` route calls `loadFleet` directly with access hard-scoped to exactly that one
  tenant ID — deliberately bypassing the staff-facing `?tenant=` query-string endpoint, so there is
  no parameter on this route that could widen the caller's own scope.
- **Reading is open to any active member (owner, admin, user); mutating is not.** All four portal
  routes are read-only. Every write (invite, standing change, revoke, activation grant) stays on
  its existing owner's route, which already enforces Owner/Admin-only + standing ranking + the
  last-active-owner guard — this slice adds no new write path and no new permission logic. The
  portal UI hides controls a caller's standing wouldn't be allowed to use, but per agent-notes
  ("hiding a control is not disabling it") that is convenience only: the same request from `curl`
  gets the same 403 the button would have.
- **Staff role ranking is unchanged and still server-enforced.** The Staff screen UI mirrors
  `staff.ts`'s existing `ROLE_RANK` (grant no role above your own; act only on an account strictly
  below your own) purely to avoid offering a control the API would refuse — the server-side check
  in `staff.ts` is what actually matters and nothing about it changed in this slice.
- **The two front doors stay structurally separate.** `/portal/*` is a second, code-based
  `createRouter` instance (`portal/router.tsx`), never fed into the ops console's file-based route
  tree (`routeTree.gen.ts`) — asserted directly in `src/routing.test.ts`. `ops-shell.ts` is the
  server-side half of that same boundary: it decides which documents get served as the staff SPA
  shell at all, and the `/staff`+`/plans` fix above only affects that decision for the ops console's
  own two pages, not the customer surface.
- **Revoke reason is free text, not yet a catalogue.** `RevokeRequest.reason` is an optional
  trimmed string (1–280 chars) kept only in the audit row's `after`, never on the mutated row
  itself. See the reconciliation note in "Known follow-ups" below.

---

## Tests run and results

### Gate (this session, staged per-command per the delivery rules)

```
corepack pnpm check                                                              → exit 0
corepack pnpm typecheck                                                          → exit 0
corepack pnpm --filter @cloudbox/worker-api exec vitest run \
  --testTimeout=120000 --hookTimeout=120000                                     → exit 0
corepack pnpm --filter @cloudbox/admin-web exec vitest run \
  --testTimeout=120000                                                          → exit 0
corepack pnpm build                                                              → exit 0
```

(Exact file/test counts for each stage are in the terminal output at gate time; the isolated
pre-gate verification the crashed agent's session already produced was worker-api 661 tests,
admin-web 16 tests, all green, which this session's staged gate reconfirmed.)

### Test coverage (new/changed this slice)

- `apps/worker-api/test/portal.test.ts` (new, 12 cases): tenant scoping (a member of tenant A gets
  403 on all four routes for tenant B; Home/Members/Devices/Subscription only ever contain tenant
  A's own rows), permission boundary (401 anonymous; a staff-only session is 401, never
  `setup_required`), Subscription is `null` (not 404) for a tenant that never had a plan, Devices
  matches WT-3's fleet loader output exactly for that tenant.
- `apps/worker-api/test/staff.test.ts` (+2): the three new list fields (`lastSignInAt: null` and
  `mustChangePassword: true` on a freshly created member; `lastSignInAt` becomes a timestamp after a
  real password sign-in); revoke-with-reason lands only in the audit row's `after`.
- `apps/worker-api/test/queries.ts` (+6): one registered query per new query shape in `portal.ts`,
  each resolving through an index (query-plan regression coverage, not a table scan).
- `apps/worker-api/test/review/phase-1-second-pass.test.ts`: `CUSTOMER_ONLY` extended so the S-6
  "every route answers `setup_required` to a staff session mid-setup, except customer-only ones"
  review test correctly excludes the new portal routes by a narrow path regex.
- `apps/worker-api/test/ops-shell.test.ts` (+2): `/ops/staff` and `/ops/plans` both now serve the
  ops shell document (the second assertion pins the pre-existing Plans bug fixed in this slice).
- `apps/admin-web/src/routing.test.ts` (new, 3 cases): `/portal/*` has zero overlap with the ops
  console's file-based route tree and vice versa; the five portal screens are all present under
  `/portal/*` outside any console layout route; `/_app/staff`'s `beforeLoad` redirects a session
  without `staff.manage` and lets one with it through.

### Demo path

**Portal (13.1):**
```
1. Sign in at /login as a tenant Owner with two organisations
2. Home: Tenant ID prominent, plan-state banner, quick counts
3. Switch organisation from the header dropdown
4. CloudBoxes: the activated servers, online/offline, licence state
5. Members: invite by email, change a standing, remove with a reason
6. Subscription: plan, validity, effective users incl. add-ons, price
7. Activate a server: mint a grant, see the exact install line once
8. Sign in as a "user"-standing member: Members is read-only, no Add
```

**Staff (1.6):**
```
1. Sign in as super admin, open Govern > Staff
2. Add staff: email + role + generated password, shown once
3. Table shows the new row: Not enrolled, Pending, Never, just now
4. Reset: confirm dialog states the consequence, new password shown once
5. Revoke: confirm dialog with an optional reason
6. Sign in as an admin (below super_admin): cannot act on a peer admin or the super admin,
   can act on a read_only account
```

---

## Screenshot verdicts (`docs/evidence/wt-p13-portal/`)

All 16 reviewed with the Read tool; every one renders fully with no visible layout, data, or
console-chrome-leak issues.

| File | Verdict |
|---|---|
| `00-portal-home-pick-tenant.png` | Renders fully — no active tenant yet, "pick one" empty state + tenant-switch list, both organisations listed with public code/standing. |
| `01-portal-home.png` | Renders fully — Tenant ID card, active pill, plan/validity line, CloudBoxes/Members count tiles, tenant-switch list with the active one checked. |
| `02-portal-cloudboxes.png` | Renders fully — one device row, Offline + TPM pills, "No license", relative last-seen. |
| `03-portal-members-owner.png` | Renders fully — owner view: standing `<select>` and Remove control present on non-owner rows, plain badge on Owner rows. |
| `04-portal-subscription.png` | Renders fully — read-only key/value table: plan, status pill, validity pill with date range, effective managed users (base+add-on), price. |
| `05-portal-activate.png` | Renders fully — label field (optional) + primary action button, tenant name/code called out in the copy. |
| `06-portal-activate-confirm-dialog.png` | Renders fully — confirm dialog states the consequence (mints a one-time code, 15 min validity) over the dimmed page. |
| `07-portal-activate-grant-shown-once.png` | Renders fully — "shown once" install command with explicit expiry timestamp, download-installer link. |
| `08-portal-tenant-switcher.png` | Renders fully — header dropdown open, active tenant checked, both organisations visible. |
| `09-portal-members-readonly.png` | Renders fully — plain member session: standing shown as static badges only, no `<select>`/Remove — correctly read-only. |
| `10a-staff-setup-password.png` | Renders fully — unrelated first-run flow (staff password setup step 1/2), confirms the ops onboarding path still works alongside this slice. |
| `10b-staff-setup-authenticator-scan.png` | Renders fully — step 2/2, QR + manual key + 6-digit input. |
| `10c-staff-setup-backup-codes.png` | Renders fully — 10 backup codes, copy button, "I have saved these" checkbox gating the final action. |
| `10-staff-table.png` | Renders fully — Govern > Staff selected in sidebar, Plans also present in the sidebar (confirms the `ops-shell.ts` fix), table shows all six columns for the seeded super admin. |
| `11-staff-add-sheet.png` | Renders fully — Add staff sheet: empty email, Read only role default, pre-generated password field. |
| `12-staff-add-password-generated.png` | Renders fully — same sheet with an email typed in; generated password unchanged, ready to submit. |

No re-renders or partial/broken captures found in this set.

---

## Known follow-ups / decisions needed

- **Reconcile the free-text revoke reason with the reasons catalogue at integration.**
  `packages/contracts/src/reasons.ts` does not exist on this branch's base (`phase-2/devices` @
  `33862a5`); it is being built on `origin/wt/p2-reason-dropdowns`. This slice's `RevokeRequest`
  (plain optional string, 1–280 chars) on both `DELETE /staff/:userId` and
  `DELETE /tenants/:tenantId/memberships/:id` should be reconciled against that catalogue's shape
  (an enum/dropdown value vs. free text, or both) when the two branches merge — whichever lands
  second should adjust to match the other, since both touch the same revoke endpoints' request
  bodies. Not blocking for this PR; flagging for the integrator.
- **`ops-shell.ts` Plans bug:** fixed as a one-line, low-risk addition to the existing route regex
  (adding `/plans` alongside this slice's own `/staff`) rather than filed as a separate PR, since it
  is the same line this slice already had to touch. Called out here in case the integrator would
  prefer it isolated in its own commit for a cleaner blame trail (it already is — see "Commits"
  below).

No other outstanding blockers. No requests to another worktree beyond the reasons-catalogue
reconciliation above.

---

## Safe next action

This branch is ready for review as a draft PR against `phase-2/devices`. WT-0 (or whoever owns
integration) should merge this before `wt/p2-reason-dropdowns` if both are ready around the same
time, since the reconciliation note above is easier to resolve as a small follow-up on top of a
merged, plain free-text `reason` than the reverse.

---

## Appendix: Evidence

- Screenshots: `docs/evidence/wt-p13-portal/*.png` (16 files, see verdicts table above).
- Slice docs (author's own, pre-dating this handoff): `docs/slices/13.1-tenant-portal.md`,
  `docs/slices/1.6-staff-screen.md` — more detail on deviations and reused capabilities than
  repeated here.
- Gate output: captured in this session's terminal at the time each staged command ran (see PR
  description / CI for the authoritative re-run).
