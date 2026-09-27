# Handoff — WT-14 `wt/p2-self-onboarding` (self-service onboarding, device self-activation, plan redemption, licence keys, Connect sign-in contract)

## Mission

**Slices:** 2.6 (new; `docs/slices/2.6-self-onboarding.md`). Decision record: ADR 0011.

**Owner decisions implemented** (2026-09-27 03:50 IST, plus the two follow-ups):
- A. Self-service start path `/api/auth/start/*` (customer system only, Turnstile always), `/start` UI.
- B. Tenant self-creation (caller = owner, `provisioning`, no subscription).
- C. Device self-activation grants for the Setup app (WT-10); staff codes stay as fallback.
- D. No trial; **two events**: plan assignment (`pending`, no dates) → plan redemption at the first
  server activation (+ licence generation), heartbeat auto-issuance as catch-up, `no_active_plan`.
- E. Connect sign-in contract, cloud side (WT-11 builds the client).
- Server licence keys: staff batches → buyer redemption at `/start`.

**Done means:** a buyer can go `/start` → code → organisation (or licence key) → Setup app grant →
`/agent/enroll` → licensed server, with no staff action when a plan or key exists; every write audited;
`/login` still closed.

## Current status

- Branch `wt/p2-self-onboarding`, parent `phase-2/devices` (merged forward to `3476492`, WT-2's
  "primary contact becomes the first Owner").
- `corepack pnpm run verify`: **green, exit 0** (see Tests).
- Draft PR against `phase-2/devices` (see report). Not merged.

## Commits ready for merge

```
feat(wt-14): self-service start path, tenant self-creation, activation grants, plan redemption + auto-issuance, Connect sign-in, licence keys (API)
feat(wt-14): tests, /start + portal tenant cards, licence keys console, Fleet plan line; pending subscriptions in the staff UI
docs(wt-14): ADR 0011, slice 2.6, licence-key runbook, handoff, evidence
```

## Files and contracts changed

**New (mine):**
- `apps/worker-api/src/onboarding/`: `auth-routes.ts` (start + Connect flows), `activation.ts`
  (redemption + licence generation), `plan.ts` (tenant plan state), `license-keys.ts` (+
  `license-keys-table.ts`, the Drizzle table, kept out of `db/schema.ts` like WT-12's), `common.ts`
  (client key, limits, tenant-code allocation, owned-tenant statements, active-tenant write).
- `apps/worker-api/src/routes/v1/self-service.ts` (`/onboarding/*`, `/connect/*`, `/license-keys/*`).
- `packages/contracts/src/onboarding.ts`, `connect.ts`, `license-keys.ts`.
- `apps/admin-web/src/portal/start-page.tsx`, `portal/tenant-cards.tsx`, `routes/_app/licences.tsx`,
  `api/onboarding.ts`, `api/license-keys.ts`.
- Tests: `test/onboarding.test.ts`, `test/license-keys.test.ts`, `test/migration-0010.test.ts`.
- Docs: ADR 0011, slice 2.6, `runbooks/license-keys.md`, this handoff, 2 `ISSUE_LOG` entries,
  `docs/evidence/wt-p2-onboarding/`.

**Edited outside my own files (all small, additive; listed so owners can review):**
| File | Owner | Change |
|---|---|---|
| `src/db/schema.ts` | WT-0 | `subscriptions`: `pending` status, nullable dates, dates CHECK (needed by 0010; coordinator instruction) |
| `src/routes/v1/index.ts` | WT-0 | one line: `v1.route("/", selfService)` |
| `src/index.ts` | WT-1 | 4 allowlist entries for `/api/auth/start/*` + `/api/auth/connect/*`, email-normalisation + step-up sets, mount `onboardingAuth` before the Better Auth catch-all |
| `src/auth/index.ts` | WT-1 | `AuthRequestContext.flow` (`start`/`connect`) + `connectTenantId`; start flow sends to/creates unknown addresses and audits `CUSTOMER_SIGNUP`; Connect success audit carries `surface`, `tenantId`; `disableSignUp` false only for `start` |
| `src/auth/challenge.ts` | WT-1 | `verifyTurnstile` accepts Cloudflare testing-key answers outside production only (local demo) |
| `src/ops-shell.ts` | WT-1 | `/licences` is a console route; **review W-1:** `opsBasePath` rejects `/api`, `/assets`, `/login`, `/portal`, `/start` |
| `src/routes/v1/agent.ts` | WT-3 | enroll → activation (redeem + issue), heartbeat → auto-issuance when no live entitlement; response fields additive |
| `src/routes/v1/enrollment.ts` | WT-3 | `createEnrollmentToken` optional `source`, `auditAfter` |
| `src/routes/v1/screens/fleet.ts` | WT-3 | detail loader adds `plan` (same batch, 3 round trips) |
| `src/entitlement/service.ts` | WT-5 | `Actor.type`/`Actor.source` (default `user`/`api`); **review P2-1:** inside `issueForDevice` only, the entitlement insert is one `INSERT … SELECT … WHERE count(other licensed devices) < max_devices` (`changes !== 1` → `device_limit_reached`), and the audit row is written after it (was: pre-count, then batch insert + audit) |
| `src/entitlement/status.ts` | WT-5 | lifecycle handles `pending` (no dates) → `expiry: "pending"`, not issuable |
| `src/routes/v1/subscriptions.ts` | WT-5 | create: no dates → `pending` (plan assignment), dates → old behaviour; PATCH: dates required unless pending (`dates_required`) |
| `packages/contracts/src/subscriptions.ts` | WT-5 | `pending` status + expiry, nullable dates, create request dates optional |
| `packages/contracts/src/agent.ts` | WT-3/4 | optional `licenseState`, `message` on `EnrollResponse` and `HeartbeatResponse`; `AgentLicenseState`, `NO_ACTIVE_PLAN_MESSAGE` |
| `packages/contracts/src/devices.ts` | WT-3 | `FleetDetailScreen.plan` optional |
| `packages/contracts/src/common.ts` | WT-0 | id prefixes `lkey_`, `lkb_` |
| `admin-web`: `nav.ts` | WT-0 | `licences` entry (after `subscriptions`; WT-13 adds `plans`) |
| `admin-web`: `portal/router.tsx` | WT-1 | `/start` route |
| `admin-web`: `portal/portal-page.tsx` | WT-2 | renders `<TenantCards/>` above the tenant switcher |
| `admin-web`: `routes/_app/fleet.$deviceId.tsx` | WT-3 | License tab: read-only "Tenant plan" line |
| `admin-web`: `subscription-bits.tsx`, `subscriptions.$id.tsx` | WT-5 | `pending` pills, null dates render "—", dialogs tolerate missing dates |
| `test/permission-matrix.test.ts`, `test/review/phase-1-hardening.test.ts`, `…/phase-1-second-pass.test.ts` | WT-6/WT-8 | route sweeps: `/onboarding/config` is public by design; `/onboarding/*`, `/connect/*` are customer-only; the three onboarding POSTs are customer self-service. No assertion changed. |
| `test/queries.ts` | WT-6 | 8 registry entries |

**Reused, not duplicated:** Better Auth customer instance (no new auth), WT-1 counters and Turnstile
siteverify, WT-3 enrollment tokens and `/agent/enroll`, WT-5 `issueForDevice`/`currentEntitlementForDevice`,
WT-3 `loadFleet`, WT-2 `getActiveTenantId`. **Duplicated minimal logic (not exported by the owner):**
WT-2's tenant-code `allocateNextTenantCode` statement and the active-tenant settings upsert
(`onboarding/common.ts`). `ensureCustomerByEmail` is not needed: the session user already exists.

## Migrations

`0010_self_onboarding.sql` (reserved number):
- rebuilds `subscriptions` (`PRAGMA defer_foreign_keys`, ids copied, index recreated): status
  `pending`, `valid_from`/`valid_until` nullable, CHECK dates unless pending;
- creates `license_keys` (+ unique `code_hash`, indexes on batch, status, last four).
- Upgrade test: `test/migration-0010.test.ts` (existing subscription + entitlement survive,
  `PRAGMA foreign_key_check` empty, CHECKs enforced).
- The Drizzle snapshot (`meta/0000_snapshot.json`) was **not** regenerated (WT-13 changes `plans` in
  parallel; a regenerated JSON would conflict). See Requests to WT-0.

## API changes

See `docs/slices/2.6-self-onboarding.md` (full table). Summary:

| Endpoint | Gate | Audit |
|---|---|---|
| `POST /api/auth/start/send-code` `{email}` | Turnstile always; 5/(email,client)/15 min, 20/client/h; 10/24 h to an address with no account | `AUTH_OTP_SENT` (WT-1's), `AUTH_START_CEILING` |
| `POST /api/auth/start/verify` `{email, code}` | Turnstile always; 30/client/h | `AUTH_LOGIN_SUCCEEDED {surface:"start"}`, `CUSTOMER_SIGNUP` (first time) |
| `POST /api/auth/connect/send-code` `{tenantCode, email}` | closed; identical answer; 3 / 60 s per client (429 `rate_limited`) | `AUTH_OTP_SENT {outcome:"not_member"}` once per window |
| `POST /api/auth/connect/verify` `{tenantCode, email, code}` | closed; `CONNECT_INVALID` for anything wrong; 3 / 60 s per client | `AUTH_LOGIN_SUCCEEDED {surface:"connect", tenantId}` |
| `GET /api/v1/onboarding/config` | public | — |
| `GET /api/v1/onboarding/overview` | customer | — |
| `POST /api/v1/onboarding/tenants` | customer; 10/h; ≤ 5 self-created tenants without a plan (409 `tenant_limit_reached`) | `TENANT_CREATED`, `USER_INVITED` (source `self_onboarding`) |
| `POST /api/v1/onboarding/redeem` | customer; 20/client/h, 10/customer/h | `LICENSE_KEY_REDEEMED`, `TENANT_CREATED`, `USER_INVITED` (`license_redemption`), `SUBSCRIPTION_CHANGED` (`license_key`) |
| `POST /api/v1/onboarding/activation-grants` | customer, Owner/Admin; tenant `provisioning`/`active`/`trial` (else 403 `tenant_not_active`); 20/h | `ENROLLMENT_TOKEN_CREATED` (source `self_activation`) |
| `GET /api/v1/connect/devices` | customer, active member | — |
| `POST /api/v1/license-keys/batches` | `license.issue` | `LICENSE_KEYS_GENERATED` (no keys) |
| `GET /api/v1/license-keys` | `license.issue` or `subscription.view` | — |
| `POST /api/v1/license-keys/:id/revoke` | `license.revoke` | `LICENSE_KEY_REVOKED` |
| `POST /api/v1/agent/enroll` | token | + `SUBSCRIPTION_REDEEMED` (first activation), `LICENSE_ISSUED` (actor system, source `activation`) |
| `POST /api/v1/agent/heartbeat` | device | + the same with source `auto` when no live entitlement |

## Exact calls for WT-10 (Setup app) and WT-11 (Connect)

All POSTs send `Content-Type: application/json` and `Origin: https://box.affinity.ai.in` (the
customer auth writes refuse anything else, login-CSRF rule); keep the `cbx_session` cookie
(`__Secure-cbx_session` on https) between calls.

**WT-10, owner already has an account** (invited by staff or signed up before):
```
POST /api/auth/email-otp/send-verification-otp  {"email":"…","type":"sign-in"}   → 200 {success:true}
POST /api/auth/sign-in/email-otp                 {"email":"…","otp":"123456"}     → 200 + cookie
```
**WT-10, new owner** (render the Turnstile widget in the installer's web view with the site key from
`GET /api/v1/onboarding/config`; one fresh token per call):
```
POST /api/auth/start/send-code  {"email":"…"}                 x-cloudbox-turnstile: <token>  → 200 {success:true}
POST /api/auth/start/verify     {"email":"…","code":"123456"} x-cloudbox-turnstile: <token>  → 200 + cookie
POST /api/v1/onboarding/redeem  {"code":"CBX-LIC-…","displayName":"…","timezone":"Asia/Kolkata"} → 201 {tenantId, tenantCode}
  or POST /api/v1/onboarding/tenants {"displayName":"…","timezone":"…"}                           → 201 {tenantId, tenantCode}
```
**WT-10, activation:**
```
GET  /api/v1/onboarding/overview → tenants[] (use standing owner/admin; show tenantCode + plan.state)
     UI: "Activate this machine as a server for tenant CBX-xxxxx? Are you sure?"
POST /api/v1/onboarding/activation-grants {"tenantId":"ten_…","deviceLabel":"<hostname>"}
     → 201 {grant:"CBX-ENROLL-XXXX-XXXX", enrollmentTokenId, tenantId, tenantCode, expiresAt(+15 min)}
CloudBox.Agent.exe install --enroll-token <grant>
     agent → POST /api/v1/agent/enroll (unchanged request) → 201 {…, licenseState, message?}
     licenseState "licensed" → GET /api/v1/agent/entitlement; "no_active_plan" → show `message`;
     "device_limit_reached" → show `message`. Keep heartbeating: a plan attached later is redeemed
     and issued on the next heartbeat (heartbeat → licenseState "licensed", entitlementGeneration n).
```
Errors: 401 (no session), 403 `forbidden` (not Owner/Admin of that tenant, or not a member),
403 `tenant_not_active`, 429 `rate_limited`, 403 `challenge_required {siteKey}` (start path without a valid token).

**WT-11 (Connect):**
```
POST /api/auth/connect/send-code {"tenantCode":"CBX-00001","email":"…"}               → 200 {"success":true} (always)
POST /api/auth/connect/verify    {"tenantCode":"CBX-00001","email":"…","code":"123456"}
     → 200 {token, user:{id,email,name,…}, tenantId, tenantCode} + cookie; active tenant = that tenant
     → 400 {"code":"INVALID_OTP","message":"Invalid OTP"} for a wrong code, unknown tenant, unknown email, non-member
     → 429 {"error":"rate_limited"} after 3 calls per path per client within 60 s (members and strangers alike)
GET  /api/v1/connect/devices[?tenantId=]
     → {tenantId, tenantCode, tenantName, plan:{state,…,message}, devices:[{deviceId,name,hostname,online,lastSeenAt,licenseState}]}
```
Zod contract: `packages/contracts/src/connect.ts`. The account step-up (403 `challenge_required`
above an address's failure budget) applies to both Connect paths exactly as at `/login`.

## WT-8 phase-2 review (`docs/reviews/phase-2-onboarding-security.md`), fixed in `8c388e1`

| Finding | Fix |
|---|---|
| P2-1 (High) concurrent activations exceed `max_devices` | limit enforced inside the entitlement INSERT (WT-5's `issueForDevice`, that function only); activation and heartbeat both go through it |
| P2-2 Connect member/non-member oracle | per-client limit 3 / 60 s per path before the membership lookup; member send always answers `{success:true}`; every member-path verify refusal is the `CONNECT_INVALID` constant |
| P2-5 start-path mail flood to new addresses | 10 codes / 24 h to an address with no customer row, then the same 200 and nothing sent; `AUTH_START_CEILING` audited once per day |
| P2-3 testing keys when `ENVIRONMENT` unset | only `ENVIRONMENT === "development"` |
| P2-4 grants for suspended tenants | only `provisioning`/`active`/`trial`; else 403 `tenant_not_active` |
| P2-6 unbounded tenant self-creation | lifetime cap 5 self-created tenants without a plan per customer (409 `tenant_limit_reached`); sequential codes accepted (public by design) |
| P2-8 key typed with lower case / spaces | canonicalised (upper-case, strip spaces and dashes, re-group) before the format check |
| W-1 (Phase 1) `OPS_BASE_PATH=/api` | reserved first segments fall back to `/ops` |

P2-7 (Drizzle snapshot) is WT-0's; P2-9 (typo'd primary contact) is WT-2's. All review tests pass unmodified.

## Security assumptions

- The only customer-row creation without an admin is `/api/auth/start/verify` with a right code and
  a valid Turnstile token; `/login` and Connect remain closed (tests assert zero rows).
- Turnstile: `hostname` must equal the request host; Cloudflare's testing keys are honoured only
  when `ENVIRONMENT !== "production"`.
- Connect: membership is resolved before any code is generated or checked; non-members get the
  success/wrong-code bodies byte for byte (tests compare them). Anonymous audit rows for non-members
  are bounded (one per (email, client) per 15 min). Response timing differs slightly (no send).
- Activation grants are ordinary WT-3 enrollment tokens (hash at rest, single use, 15 min); the
  Owner/Admin check re-reads `tenant_memberships` per request; tenant A's members get 403 on B.
- Plan redemption is a single conditional UPDATE (`status = 'pending'`), so concurrent first
  activations redeem once; issuance races end in WT-5's `generation_conflict`, handled as licensed.
- Licence keys: 100 bits, hash only, identical refusal for used/expired/revoked/unknown, per-client
  and per-customer attempt limits; the claim is a conditional UPDATE checked before the batch, with
  a compensating release if the batch fails (same pattern as WT-3's enroll).
- Never logged or audited: OTP codes, licence keys, enrollment grants, entitlement tokens.

## Tests run + exact results

```
$ corepack pnpm run verify
biome check .            Checked 196 files. No fixes applied. (1 pre-existing warning, tests/e2e-cloud)
pnpm typecheck           contracts, licensing-contracts, worker-api, admin-web, tests/e2e-cloud: Done
packages/licensing-contracts   Test Files 2 passed (2)    Tests 16 passed (16)
apps/admin-web                 Test Files 2 passed (2)    Tests 5 passed (5)
apps/worker-api                Test Files 31 passed (31)  Tests 560 passed (560)   (after the review fixes, 8c388e1)
pnpm build               admin-web ✓ built; worker-api wrangler deploy --dry-run OK
EXIT 0
```

New suites (all green): `onboarding.test.ts` (25): start path requires Turnstile on send and verify
(no token, wrong hostname, no secret → closed), creates exactly one customer row and one
`CUSTOMER_SIGNUP`, wrong code creates nothing, `/login` still creates none, per-(email, client) and
per-client limits; tenant self-creation (owner membership, `provisioning`, no subscription, audits,
several tenants, overview plan state), staff session 401; grants (15-min TTL, label, `self_activation`
audit, end to end through `/agent/enroll`, single use), Owner/Admin only, tenant boundary A→B 403;
two-event model: staff assignment is `pending` with no dates; first activation redeems with
`valid_from ≈ now`, `valid_until = +term` and issues (`activation`), second device does not
re-redeem, third hits `device_limit_reached`; `term_days` read when present, 365 otherwise; no plan →
enrolled + `no_active_plan` on enroll and heartbeat, plan attached afterwards → next heartbeat
redeems (`auto`) and issues once; auto-issue against an already-active subscription; expired,
suspended, cancelled and trial → no auto-issue; Fleet detail and portal plan state; Connect send
identical for unknown tenant / unknown email / non-member / malformed code / member, verify
non-member and unknown tenant identical to a wrong code, member signs in with `surface: connect`,
active tenant set, device list, tenant boundary 403; Turnstile testing keys only outside production;
`/ops/licences` is a console route. `license-keys.test.ts` (8): N unique keys, hashes only, nothing in
audit; 500 in one call, 501 refused; CSV; list never leaks code/hash, filters; read_only cannot
generate, customer 401, admin cannot revoke, super_admin revokes once; redemption happy path
(tenant, owner, pending subscription, key marked, four audit events with sources); used / expired /
revoked / made-up keys identical; session required, per-session and per-client limits.
`migration-0010.test.ts` (1). Query-plan registry: 8 new entries, all indexed.

## Demo path (wrangler dev + fresh local D1 + Playwright; `docs/evidence/wt-p2-onboarding/`)

`.dev.vars`: `.dev.vars.example` + `TURNSTILE_SITE_KEY=1x00000000000000000000AA`,
`TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA` (Cloudflare testing keys),
`ENTITLEMENT_SIGNING_JWK` from `generate-signing-key.ts`. `wrangler d1 migrations apply --local`
into a fresh `--persist-to` dir, `wrangler dev --var ENVIRONMENT:development`.

```
07-ops-licences-generate-dialog.png      staff: Generate 5 keys for "Store A — October"
08-ops-licences-keys-shown-once.png      keys shown once, Copy all / Download CSV
01-start-email-turnstile.png             /start: email + Turnstile widget (always shown)
02-start-code.png                        six-box code step, widget re-issuing a token
03-start-organisation.png                create an organisation / have a licence key?
04-start-licence-key.png                 key + name + time zone
05-portal-tenant-id-pending-plan.png     Tenant ID CBX-00001 "give this to your team", plan pending activation
06-portal-no-active-plan.png             self-created tenant without a plan: the owner banner
activation-and-connect-demo.txt          grant → enroll (licensed / no_active_plan) → heartbeat → entitlement; Connect send/verify/devices
09-portal-plan-active-after-activation.png  plan active, dates set at activation, 1 server
10-ops-licences-after-redemption.png     key redeemed by owner@acme-dental.test → CBX-00001
11-ops-licences-revoke-dialog.png        revoke with a typed reason
12-ops-fleet-license-no-active-plan.png  Fleet → License tab: "Tenant plan: no active plan — No active plan found…"
13-ops-fleet-license-plan-redeemed.png   Fleet → License tab: active plan, licensed
```

## Known failures

- None in verify. Physical Windows acceptance of the Setup/Connect flows is WT-10/WT-11's.

## Deviations

- **Licence key format:** `CBX-LIC-XXXXX-XXXXX-XXXXX-XXXXX` (four groups of **five**). The brief's
  `XXXX-XXXX-XXXX-XXXX` (16 symbols, 80 bits) contradicts its own "20 symbols ≈ 100 bits"; 4×5
  keeps four groups and 100 bits.
- **`license_keys.batch_id`** added (not in the brief's column list): labels can repeat; the batches
  table groups by it.
- **`GET /license-keys`** also admits `subscription.view` so Support can look keys up by last four
  (runbook); generation stays `license.issue`, revoke `license.revoke`.
- **Trial is not "active"** for auto-issuance (status `active` only, per decision D); a staff-created
  trial override still issues manually through WT-5's route.
- **Heartbeat-path redemption** is audited with source `auto` (activation-path: `activation`).
- **`licenseState: "device_limit_reached"`** added next to `no_active_plan` (with its own message)
  for a server over the plan's `max_devices`; `licensed` is also reported.
- **Turnstile on both start calls** (send and verify): the brief says "always requires"; the UI
  re-issues a token between calls.
- **`verifyTurnstile` testing-key allowance** outside production (so the local demo can run with
  Cloudflare's testing keys, whose siteverify answers hostname `example.com`).
- Route mounts: one line in `routes/v1/index.ts` mounts a composite router at `/`; the
  auth-mount paths are four entries in `src/index.ts`'s allowlist (the gate 404s anything else).

## Decisions needed

- None blocking. Optional: should a staff-created **trial** count as an active plan for
  auto-issuance? (Today: no, per "no trial".)

## Requests to another worktree

- [ ] **WT-0:** move `license_keys` (`src/onboarding/license-keys-table.ts`) into `db/schema.ts`
  and regenerate the Drizzle snapshot after WT-13's `plans.term_days` lands (the snapshot does not
  yet reflect 0010's `subscriptions` change). Set `TURNSTILE_SITE_KEY`/`TURNSTILE_SECRET_KEY` for
  production before announcing `/start` (without the secret the start path is closed).
- [ ] **WT-2:** `routes/v1/tenants.ts` `OPEN_SUBSCRIPTION_STATUSES` should include `pending` (an
  assigned, unredeemed plan should block archiving like any open subscription).
- [ ] **WT-13:** `plans.term_days` is read with `SELECT *` and a 365 fallback
  (`onboarding/activation.ts planTermDays`); nothing else needed. Nav: `licences` sits after
  `subscriptions`; put `plans` wherever you planned, the merge is two adjacent lines.
- [ ] **WT-5:** the "New subscription" dialog still always sends dates (staff override). A "Plan
  only (starts at activation)" option would call the same endpoint without dates.
- [ ] **WT-10 / WT-11:** call sequences above.
- [ ] **WT-8:** review ADR 0011's exception to closed sign-in, the Connect identical-response
  guarantee, and the licence-key redemption claim.

## Safe next action

Review the draft PR against `phase-2/devices`; merge after WT-13 (for `term_days`) or before it (the
fallback covers it). Then set the production Turnstile keys.
