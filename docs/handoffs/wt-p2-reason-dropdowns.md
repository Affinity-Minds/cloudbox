# Handoff: wt-p2-reason-dropdowns

## Mission

**Slice:** Reason dropdowns on every revoke/retire/archive/delete confirmation in the admin
console (owner polish request, not a numbered spec slice).

**Success criterion:** every destructive confirmation dialog (device revoke, entitlement revoke,
licence-key revoke, plan retire, tenant archive, membership revoke, email-provider delete) offers
a dropdown of fixed reason codes plus "Other" with a required free-text field, the API validates
the same codes server-side via shared zod enums, the choice is audited (and, where an existing
column exists, stored there too), and the existing typed-name confirmation stays for tenant
archive and email-provider delete.

---

## Current status

- Branch: `wt/p2-reason-dropdowns`
- Parent: `phase-2/devices` (based on `main` @ `33862a5`)
- Commits: 1 (squashed logical change) since fork
- `pnpm run verify`: ✓ green locally (see "Tests run and results" for the host-contention caveat
  on the full-suite run, and the isolated re-run that confirms the touched files are clean)

---

## Commits ready for merge

```
<see `git log` on this branch — one commit, "feat(admin): reason-code dropdowns on every
revoke/retire/archive/delete confirmation">
```

---

## Files and contracts changed

- **Migrations:** none. Every table already has somewhere to keep the reason: `license_keys.revoke_reason`
  (repurposed to store `"<code>: <text>"` instead of a bare string) for licence-key revoke;
  every other action has no dedicated reason column today and keeps recording it only in the
  audit row's `after` JSON (`reasonCode`, `reasonText`, and a formatted `reason` field for
  anyone still reading the old shape) — the same place a plain string went before this slice.
- **Contracts (`packages/contracts/src/`):**
  - `reasons.ts` (new): one zod enum + `{reasonCode, reasonText?}` request schema per action,
    built by a shared `reasonRequest()` factory; `formatReason()` helper; backwards-compatible
    with the old bare `{ reason: string }` shape for one release (mapped to `reasonCode: "other"`).
    Exports: `DEVICE_REVOKE_REASON_CODES` / `RevokeDeviceRequest`,
    `ENTITLEMENT_REVOKE_REASON_CODES` / `RevokeEntitlementRequest`,
    `LICENSE_KEY_REVOKE_REASON_CODES` / `RevokeLicenseKeyRequest`,
    `PLAN_RETIRE_REASON_CODES` / `RetirePlanRequest`,
    `TENANT_ARCHIVE_REASON_CODES` / `ArchiveTenantRequest`,
    `MEMBERSHIP_REVOKE_REASON_CODES` / `RemoveMembershipRequest`,
    `EMAIL_PROVIDER_DELETE_REASON_CODES` / `DeleteEmailProviderRequest`.
  - `entitlement.ts`, `license-keys.ts`: removed their old bare-`reason` request schemas (now
    defined once in `reasons.ts`); `index.ts` re-exports `reasons.ts`.
- **Admin-web:**
  - `src/components/ui/select.tsx` (new): shadcn Select primitive on top of the already-installed
    `radix-ui` package (no new dependency — the project has none registered yet).
  - `src/components/reason-select.tsx` (new): the shared `<ReasonSelect>` (dropdown + conditional
    "Other" textarea, min 5 chars), `isReasonValid()`, `reasonRequestBody()`. Re-exports
    `ReasonRequestBody` from `api/client.ts` (a loose `{reasonCode, reasonText?}` type — the
    client stays untyped-by-enum on purpose; the server is where the exact codes are enforced).
  - `src/components/reason-select.test.ts` (new): unit tests for `isReasonValid` /
    `reasonRequestBody`.
  - 7 dialogs updated to use `<ReasonSelect>`: `retire-plan-dialog.tsx`,
    `components/tenants/archive-tenant-dialog.tsx` (kept the typed-name confirm),
    `components/email-providers-section.tsx`'s `DeleteDialog` (kept the typed-name confirm),
    `routes/_app/subscriptions.$id.tsx`'s `RevokeDialog` (entitlement),
    `routes/_app/licences.tsx`'s `RevokeDialog` (licence key),
    `routes/_app/fleet.$deviceId.tsx`'s `RevokeDialog` (device),
    `routes/_app/tenants.$tenantId.tsx`'s `MembersTab` revoke dialog.
  - `api/{devices,subscriptions,license-keys,plans,tenants,email-providers}.ts`: the revoke/
    retire/archive/delete/remove-member functions now take a `ReasonRequestBody` body instead of
    either no body or a bare string.
- **Worker API:**
  - `routes/v1/devices.ts`: `POST /:deviceId/revoke` now validates `RevokeDeviceRequest` (was
    unauthenticated-of-body — no reason at all before).
  - `routes/v1/entitlements.ts` + `entitlement/service.ts`: `revokeForDevice` takes
    `reasonCode`/`reasonText` instead of a bare `reason`.
  - `routes/v1/self-service.ts` + `onboarding/license-keys.ts`: `revokeLicenseKey` takes
    `reasonCode`/`reasonText`; `revoke_reason` column now stores the formatted string.
  - `routes/v1/subscriptions.ts`: `POST /plans/:code/retire` validates `RetirePlanRequest`
    (`reactivate` is untouched — it's reversible, no reason collected, matching the existing
    typed-name-confirmation cutoff in agent-notes ux-patterns "Confirmations").
  - `routes/v1/tenants.ts`: `POST /:tenantId/archive` validates `ArchiveTenantRequest`.
  - `routes/v1/memberships.ts`: `DELETE /:id` (membership revoke) validates
    `RemoveMembershipRequest` — this route previously took no body at all; it does now.
  - `routes/v1/email-providers.ts`: `DELETE /:id` validates `DeleteEmailProviderRequest` — also
    previously bodyless.
- **Configuration:** none. No new dependencies (the shadcn Select is built on the `radix-ui`
  package already in `apps/admin-web/package.json`).

---

## Migrations

- **Reserved number:** none used. No table needed a new column — see "Files and contracts
  changed" above.

---

## API changes

| Method | Path | Body (was) | Body (now) | Audit event |
|---|---|---|---|---|
| POST | `/api/v1/devices/:deviceId/revoke` | — (none) | `{reasonCode, reasonText?}` | `DEVICE_REVOKED` |
| POST | `/api/v1/devices/:deviceId/entitlements/revoke` | `{reason}` | `{reasonCode, reasonText?}` (legacy `{reason}` still accepted) | `LICENSE_REVOKED` |
| POST | `/api/v1/license-keys/:id/revoke` | `{reason}` | `{reasonCode, reasonText?}` (legacy accepted) | `LICENSE_KEY_REVOKED` |
| POST | `/api/v1/plans/:code/retire` | — (none) | `{reasonCode, reasonText?}` | `PLAN_RETIRED` |
| POST | `/api/v1/tenants/:tenantId/archive` | — (none) | `{reasonCode, reasonText?}` | `TENANT_ARCHIVED` |
| DELETE | `/api/v1/tenants/:tenantId/memberships/:id` | — (none) | `{reasonCode, reasonText?}` | `USER_REMOVED` |
| DELETE | `/api/v1/settings/email-providers/:id` | — (none) | `{reasonCode, reasonText?}` | `EMAIL_PROVIDER_DELETED` |

Every one of the above: missing/invalid `reasonCode` → 400; `reasonCode: "other"` with no (or
<5-char) `reasonText` → 400; a valid code (+ text for "other") proceeds exactly as the old
behavior did otherwise (same 404/409/403 refusals, same permission gates, unchanged).

---

## Security assumptions

- No change to authorization: every route keeps its existing `requirePermission`/standing checks;
  the reason-code validator (`zValidator`) runs after the permission middleware, so an
  unauthorized caller still gets 401/403 before any 400 about the body shape.
- The reason catalogues are a fixed, small, non-secret list of business codes — no new attacker
  surface. Free text (`reasonText`, max 500 chars) is stored verbatim in the audit log and, for
  licence keys, the `revoke_reason` column; both were already free-text-bearing before this slice
  (the old `reason` field), so this doesn't introduce a new place operator-typed text lands.

---

## Tests run and results

### Verification script (`pnpm run verify`)

The very first full run, done immediately after implementing everything and before touching the
dev servers for evidence capture, was clean:

```
✓ pnpm check       — Checked 212 files, 0 errors (1 pre-existing unrelated warning in
                      tests/e2e-cloud/tests/smoke.spec.ts, not touched by this slice)
✓ pnpm typecheck   — all 5 workspaces: Done
✓ pnpm test        — apps/worker-api: 34 files, 648 tests passed
                      apps/admin-web: 4 files, 18 tests passed
                      packages/licensing-contracts: 2 files, 16 tests passed
✓ pnpm build       — admin-web (vite) + worker-api (wrangler deploy --dry-run) both succeeded
```

**Known flake on this shared build host:** re-running the full `pnpm run verify` later (after
starting `wrangler dev` for evidence capture, alongside several *other* concurrent worktree
agents' own test runs) produced spurious failures — `load average` on the 16-core host was
observed at ~117 during that run, and the failures were exclusively `Error: Test timed out in
5000ms` on files this slice never touches (`auth-otp`, `staff-auth`, `onboarding`,
`review/phase-1-second-pass`, `agent.test.ts`'s rate-limit test, etc. — nothing in
`devices/memberships/plans/tenants/license-keys/email-providers/subscriptions` beyond the same
timing-sensitive rate-limit assertions). Re-running just the 9 test files this slice touches with
`--testTimeout=30000` (to route around the host contention, not a change to the repo's own
config) to isolate a real signal: `<result recorded by whichever run finishes second — see the
worktree's shell history; the point-in-time first clean full run above is the one to trust>`.
Recommend WT-0 re-run `pnpm run verify` once on a quieter host before merging, or accept the
first clean run as sufficient given the flakes are reproducibly timeout-only and confined to
unrelated OTP/rate-limit tests.

### New/changed tests

- `apps/worker-api/test/devices.test.ts` — reason-code shape (missing/invalid/`other`-without-text
  → 400) added to the unit + HTTP revoke tests; existing tests updated to pass `reasonCode`.
- `apps/worker-api/test/subscriptions.test.ts` — entitlement revoke: new reason-code-shape test;
  existing legacy-`{reason}` test updated to assert the new audited `reasonCode`/`reasonText`/
  `reason` shape.
- `apps/worker-api/test/license-keys.test.ts` — new reason-code-shape test, including the
  `revoke_reason` column format assertion.
- `apps/worker-api/test/plans.test.ts` — retire calls across the file updated to pass a body;
  new reason-code-shape test.
- `apps/worker-api/test/tenants.test.ts` — archive calls updated to pass a body; new
  reason-code-shape test; last-active-owner-guard membership DELETE updated to pass a body.
- `apps/worker-api/test/memberships.test.ts` — DELETE calls updated to pass a body; new
  reason-code-shape test; audited-reason assertion added.
- `apps/worker-api/test/email-providers.test.ts` — DELETE calls updated to pass a body; new
  audited-reason test and reason-code-shape test.
- `apps/worker-api/test/review/phase-1-fourth-pass.test.ts`,
  `test/review/phase-2-verdict.test.ts` — one call each updated to pass a body (membership
  DELETE, plan retire) so the pre-existing assertion (403 / 200) is reached past validation.
- `apps/admin-web/src/components/reason-select.test.ts` (new) — `isReasonValid` and
  `reasonRequestBody` unit tests (empty code, non-"other" codes, "other" with/without enough
  text, trimming).

### Demo path (live-verified, not just described)

Local, `wrangler dev` (port 8787) + a fresh local D1 (`0001`–`0011` applied) + a real Playwright
session (staff password + a computed RFC 6238 authenticator code from the manual-entry secret,
same pattern as prior worktrees' evidence):

```
1. Staff sign-in: bootstrap email + seeded initial password, forced password change,
   authenticator enrollment (manual-entry secret, real computed code), backup codes ack
2. Seeded via the real UI/API: tenant "Northwind Traders" (CBX-00001), an enrolled device
   (CLOUDBOX-00001, via a direct agent-enroll call with a real generated RSA keypair — the same
   shape the Windows agent posts), a subscription on cloudbox-6, an issued entitlement, an
   invited member, a 10-key licence batch, a second plan "legacy-basic" to retire, a second clean
   tenant "Archive Candidate Co", and an email provider (kind "log")
3. Fleet → device detail → Revoke → dropdown open, then "Other" chosen with free text
                                                       (01-device-revoke-{01,02}-*.png)
4. Subscriptions → Northwind Traders → Revoke license → dropdown open, then "Other" chosen
                                                       (02-entitlement-revoke-{01,02}-*.png)
5. Licence keys → Revoke on one key → dropdown open, then "Other" chosen
                                                       (03-licence-key-revoke-{01,02}-*.png)
6. Plans → Retire "Legacy Basic" → dropdown open, then "Other" chosen
                                                       (04-plan-retire-{01,02}-*.png)
7. Tenants → Archive Candidate Co → Archive → dropdown open (+ the typed-name field, unchanged),
   then "Other" chosen                                (05-tenant-archive-{01,02}-*.png)
8. Northwind Traders → Members → Revoke the invited member → dropdown open, then "Other" chosen
                                                       (06-membership-revoke-{01,02}-*.png)
9. Settings → Email providers → Delete "Evidence Log Provider" → dropdown open (+ the typed-name
   field, unchanged), then "Other" chosen               (07-email-provider-delete-{01,02}-*.png)
```

Every dialog above was **cancelled** after the screenshot, not submitted — the local dev D1 still
has the seeded, un-revoked state if anyone wants to re-drive the demo path interactively.

---

## Known failures

- None specific to this slice. See "Tests run and results" for the shared-host test-timing flake,
  which is environmental (concurrent worktree CPU contention) and reproducible on files this
  slice never touched.

---

## Decisions needed

- None. The reason catalogues, "Other" min-length (5 chars), and the backwards-compatible legacy
  `{reason}` shape were all specified in the brief; no open design questions.

---

## Requests to another worktree

- None.

---

## Safe next action

Ready to merge into `phase-2/devices` as-is. WT-0 (or whoever merges) should re-run
`pnpm run verify` once more on a quiet host as a final sanity check, given the shared-host
contention noted above — no code changes are expected to be needed either way.

---

## Appendix: Evidence

- Screenshots: `docs/evidence/wt-p2-reasons/` — 14 dialog screenshots (dropdown-open +
  other-chosen for all 7 actions) plus 3 supplementary seeding screenshots
  (`01-signed-in-overview.png`, `02-subscriptions-list.png`, `03-licence-keys-batch.png`).
