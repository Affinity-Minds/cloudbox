# ADR 0011 — Self-service onboarding, device self-activation, plan redemption at activation, licence keys

**Status:** Accepted (owner decisions, 2026-09-27 03:50 IST, plus the two follow-ups the same night:
the two-event plan model and server licence keys)
**Supersedes:** staff-first tenant creation as the *only* way in (spec §55.1 "Invite email → OTP");
the "sign-in never creates an account" rule of ADR 0002/0009 gets exactly one exception, below.
**Context:** WT-14 (`wt/p2-self-onboarding`), spec §9, §10, §14.2, §28, §55
**Stakeholders:** WT-1 (customer identity), WT-2 (tenants/memberships), WT-3 (enrollment, agent API),
WT-5 (subscriptions/entitlements), WT-10 (Windows Setup app), WT-11 (CloudBox Connect), WT-13 (plans)

## Context

Until now every customer row, tenant and enrollment code came from staff. The owner wants a
buyer to be able to start alone: sign up, create their organisation (or redeem a licence key a
store sold them), and activate their own server from the Setup app, with no staff step on the
normal path, and without a trial.

## Decision

### 1. One self-service start path creates customer identities (customer system only)
- `POST /api/auth/start/send-code {email}` and `POST /api/auth/start/verify {email, code}` on the
  customer Better Auth instance (`flow: "start"`): the same emailOTP plugin, codes, storage,
  limits and hooks as `/login`, except that an address with no customer row is sent a code and a
  verified code creates the row (`CUSTOMER_SIGNUP`, source `self_onboarding`).
- **Both calls always require a Turnstile token** (`x-cloudbox-turnstile`, siteverify, hostname must
  be ours; single use, so the widget re-issues between calls). Without `TURNSTILE_SECRET_KEY` the
  start path is closed. Cloudflare's published *testing* keys are accepted outside production only.
- Limits on top of Better Auth's per-IP ones: 5 sends per (email, client) per 15 min, 20 sends per
  client per hour (across addresses), 30 verifies per client per hour.
- `/login` is unchanged: closed, unknown addresses get the same answer and nothing is stored.

### 2. Tenant self-creation
`POST /api/v1/onboarding/tenants {displayName, timezone}` (customer session) creates a tenant
(`provisioning`, next `CBX-#####` code, primary contact = the session email, **no subscription**)
and the caller's `owner` membership in one batch, audited `TENANT_CREATED` + `USER_INVITED`
(source `self_onboarding`), same row shapes as WT-2's staff create (primary contact = first owner).
A customer may own several tenants (10 creations per hour per customer).

### 3. Device self-activation replaces staff codes on the normal path
`POST /api/v1/onboarding/activation-grants {tenantId, deviceLabel?}` (customer session, Owner or
Admin of that tenant) mints a normal WT-3 enrollment token (label `self-activation by <email>`,
TTL 15 min, audited `ENROLLMENT_TOKEN_CREATED` source `self_activation`) and returns it once. The
Setup app passes it to `CloudBox.Agent.exe install --enroll-token`. `/agent/enroll` accepts it like
any code. Staff enrollment codes remain as the fallback.

### 4. No trial. Two events: plan assignment, then plan redemption at activation
1. **Assignment** — staff attach a plan (`POST /tenants/:id/subscriptions` without dates) or a buyer
   redeems a licence key: a subscription in the new status **`pending`**, with no dates.
2. **Redemption** — at the tenant's first successful server activation (`/agent/enroll` with any
   token): `valid_from = now`, `valid_until = now + plans.term_days` (WT-13's column; 365 when
   absent), status `active`, audited `SUBSCRIPTION_REDEEMED` (actor system, source `activation`,
   device id). One conditional UPDATE: only the first activation redeems.
3. **Licence generation** — right after, the device's entitlement is issued through WT-5's
   `issueForDevice` (`LICENSE_ISSUED`, actor system, source `activation`). Further servers under
   `max_devices` just get entitlements.
4. **Catch-up on heartbeat** — whenever a device holds no live entitlement, `/agent/heartbeat` runs
   the same redemption + issuance (source `auto`). A plan attached after activation is therefore
   redeemed and issued on the next heartbeat. "Active" means status `active` and inside its dates:
   `trial`, `past_due`, `suspended`, `cancelled` and expired subscriptions are never auto-issued.
5. Nothing active → the device still enrolls; enroll and heartbeat carry
   `licenseState: "no_active_plan"` and `message: "No active plan found. Please contact the
   CloudBox admin."`; the portal (Owners/Admins) and the Fleet License tab show the same.
   Over the plan's server limit → `licenseState: "device_limit_reached"`.
- Staff can still create a dated subscription (`status` trial/active + both dates): the override
  starts immediately, as before.

### 5. Server licence keys (reseller channel)
- `license_keys` (migration 0010): `CBX-LIC-XXXXX-XXXXX-XXXXX-XXXXX`, 20 Crockford base32 symbols
  from `crypto.getRandomValues` (100 bits). Only the SHA-256 is stored, plus the last four symbols
  for support. Plaintext exists once, in the generation response (JSON, or CSV with `Accept:
  text/csv`).
- Staff: `POST /license-keys/batches` (`license.issue`, ≤ 500 per batch, audited
  `LICENSE_KEYS_GENERATED` without keys), `GET /license-keys` (`license.issue` or
  `subscription.view`, never the code or hash), `POST /license-keys/:id/revoke` (`license.revoke`).
- Buyer: `POST /api/v1/onboarding/redeem {code, displayName, timezone}` (customer session) claims
  the key with one conditional UPDATE, then in one batch creates the tenant, the owner membership
  and a `pending` subscription for the key's plan and links the key (audits `LICENSE_KEY_REDEEMED`,
  `TENANT_CREATED`, `USER_INVITED` source `license_redemption`, `SUBSCRIPTION_CHANGED` source
  `license_key`). Used, expired, revoked and unknown keys all answer the same 400
  `invalid_license_key`. 20 attempts per client and 10 per customer per hour.

### 6. Connect sign-in contract (cloud side)
`POST /api/auth/connect/send-code {tenantCode, email}` and `.../verify {tenantCode, email, code}`
run the normal customer code flow only for an **active member of that tenant**; unknown tenant,
unknown email and non-members get the identical answers (send: `200 {success:true}` with nothing
sent; verify: the exact wrong-code body). Success sets the active tenant and is audited
`AUTH_LOGIN_SUCCEEDED {surface: "connect", tenantId}`. `GET /api/v1/connect/devices` lists that
tenant's enrolled devices with online state and licence state. Contract: `packages/contracts/src/connect.ts`.

## Alternatives rejected
- **A trial on sign-up:** owner decision, no trial; plans come from staff or a licence key.
- **Dates set at assignment:** a plan sold through a store could expire on the shelf; redemption
  at activation starts the clock when the customer can use it.
- **A second customer Better Auth instance / a custom code store for sign-up:** the start path is
  the same instance with one option flipped (`disableSignUp`), so codes, sessions, cookies and
  limits stay Better Auth's (no custom auth or token formats).
- **Opening `/login` to unknown addresses:** keeps every probe and typo out of `customer_users`;
  only a human who passes Turnstile and reads the mailbox creates a row.
- **Licence keys stored reversibly:** a leaked table would leak sellable keys; hashes plus the last
  four symbols are enough for support.

## Consequences
- `subscriptions` gains `pending` and nullable `valid_from`/`valid_until` (table rebuild in 0010,
  CHECK: dates required unless pending). WT-5's lifecycle reports `expiry: "pending"`.
- Heartbeats of unlicensed devices cost one extra query; licensed ones none.
- The anti-enumeration rule now has two surfaces with a deliberate exception: `/start` (open, behind
  Turnstile) versus `/login` and Connect (closed).
- Tenant codes are consumed by self-service too; per-customer creation is rate-limited.
