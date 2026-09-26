# Phase 1 security review (WT-8)

Reviewed commit: `phase-1/identity` @ `21efc1a` on branch `review/phase-1-security`.
Scope for this pass: `apps/worker-api/src/{auth,authz,email}/**`, `routes/v1/{auth,staff}.ts`, `routes/v1/screens/*`,
`src/index.ts`, `src/http.ts`, `src/audit.ts`, migrations 0002 to 0004, `admin-web/src/auth/**`, `routes/login.tsx`,
`routes/_app.tsx`, `.github/workflows/deploy-cloudflare.yml`, `wrangler.jsonc`. Better Auth 1.7.6 source was read
where the app depends on its behaviour.

Negative tests: `apps/worker-api/test/review/phase-1-hardening.test.ts`. Each one asserts the **secure**
behaviour, so a failing test is an open finding. Do not change the assertions to make them pass.

```
pnpm --filter @cloudbox/worker-api test -- test/review
Tests  15 failed | 18 passed (33)   (full suite: 15 failed | 69 passed; the 51 existing tests still pass)
```

**Merge blockers (Critical/High): H-1, H-2.** There are no Critical findings.

---

## High

### H-1 The per-email send cap lets anyone lock any account out of sign-in, including the only super admin
- **Where:** `apps/worker-api/src/auth/index.ts:26-27` (`OTP_SENDS_PER_EMAIL = 5 / 15 min`), `:124-133` (the before hook refuses with 429).
- **Exploit path:** the cap counts `AUTH_OTP_SENT` rows for an address, whoever asked for them. Five unauthenticated send requests every 15 minutes are enough (one IP will do: the per-IP limit is 3/60 s). After that, every send for that address returns 429 **for everyone**, including the real owner on a fresh IP. The bootstrap super-admin address appears in the repo docs. Holding the lockout costs about 20 requests an hour. The owner is locked out once their current session ends, and the only way back in is a direct D1 edit.
- **Evidence:** the existing test `auth-otp.test.ts:233` "rate-limits OTP sends per email across IPs" shows the behaviour: the 6th request, from an unrelated IP, gets 429.
- **Fix:** stop a third party from spending the owner's quota. Key the tight cap on `(email, client IP /64)`, for example 5 per 15 min. Keep a separate per-email ceiling that is high enough to stop mail bombing but not low enough to lock out (for example 30 per hour), and set it with the reuse strategy in mind. Alternatively, when an unexpired code already exists for the address, return 200 **without** sending again instead of 429. Whichever you choose, the response must stay identical for known and unknown addresses.
- **Negative test to add:** send 5 codes for `victim@…` from IP A, then send from IP B: expect 200 and a delivered message. Then verify with that message's code: expect 200.
- **Fixed in `c573cc2`** (WT-1): OTP send caps keyed on (email, client IP or IPv6 /64) 5 / 15 min plus a per-email ceiling of 30 / h; over either cap the answer is the same 200 with nothing generated, sent or recorded, for known, unknown and staff addresses alike, and resends reuse the still-valid code (`storeOTP: "encrypted"`, `resendStrategy: "reuse"`), so a third party can neither lock the owner out nor invalidate the code in their inbox. Test: `auth-otp.test.ts` "H-1: a caller at another IP cannot lock the owner out" (the negative test above). The same rule applies to staff passwords in `7ebffc8` (5 failures per (email, client) / 15 min → 429 with the wrong-password body; per-account ceiling 100 / h). Staff no longer use email codes at all (ADR 0009).

### H-2 Unused emailOTP and Better Auth endpoints are live, and they bypass the controls the handoff describes
- **Where:** `src/index.ts:51-55` forwards every `GET/POST /api/auth/*` to Better Auth. `src/auth/index.ts:125` applies the sign-in-only rule and the per-email cap to `/email-otp/send-verification-otp` only.
- **What answers today** (Better Auth `plugins/email-otp/routes.mjs`):
  - `/email-otp/request-password-reset` and the deprecated `/forget-password/email-otp` send a "forget-password" code. They skip the "only sign-in codes" rule and the per-email cap, so only the per-IP limit remains. They send **only when the account exists**, which makes them an existence oracle (the mail arrives or it does not, and the response time differs by one mail send). The mail says "sign-in code", which misleads the recipient.
  - `/email-otp/reset-password` with that code writes an unaudited `account` row (`provider_id='credential'`) holding a password hash. That is a dormant second login method. It becomes live the day anyone enables `emailAndPassword`.
  - `/email-otp/check-verification-otp` is a second place to test a sign-in code. It does not consume the code and does not run the audited sign-in hook, so failures leave no `AUTH_LOGIN_FAILED`. Its attempt counter is updated by read-then-write instead of the atomic consume that sign-in uses (routes.mjs:236-263), which weakens the handoff's "3 attempts, atomic consume" guarantee.
  - `/email-otp/verify-email`, `/update-user`, `/revoke-session(s)` and `/revoke-other-sessions` change state without audit rows (see L-7).
- **Evidence:** review test `F-2: unused emailOTP endpoints are not reachable`. The endpoints answer 200/400 where they should answer 404 (5 failures). This also goes against agent-notes cloudflare-workers §17: "delete the plugin, don't hide the UI … Hidden endpoints still answer".
- **Fix:** in `src/index.ts`, before `authFor(c).handler`, allowlist the paths the product uses and return `{error:"not_found"}` 404 for all others:
  `POST /api/auth/email-otp/send-verification-otp`, `POST /api/auth/sign-in/email-otp`, `GET /api/auth/get-session`
  (`/sign-out` is already routed to the audited logout). Compare against the path after normalising the trailing slash. Also move the sign-in-only check into this allowlist so it cannot drift.
- **Negative test:** the F-2 block (it turns green with the fix). Extend it with `/update-user`, `/revoke-sessions`, `/revoke-other-sessions`, `/list-sessions`.

---
- **Fixed in `c573cc2`** (WT-1): exact-match allowlist in `src/index.ts`; every other `/api/auth/*` path (and any trailing-slash or case variant) answers 404 `{error:"not_found"}`. `7ebffc8` extends it with the staff password + authenticator endpoints (ADR 0009) and nothing else. F-2 is green; `auth-otp.test.ts` "H-2" adds `/update-user`, `/revoke-session(s)`, `/revoke-other-sessions`, `/list-sessions`, `/sign-up/email`, `/request-password-reset`, `/forget-password`, `/two-factor/get-totp-uri`, `/two-factor/send-otp`.

## Medium

### M-1 Eleven `/api/v1` routes answer without a session
- **Where:** stub routers in `routes/v1/{tenants,memberships,me,enrollment,devices,subscriptions,entitlements,audit}.ts` (for example `tenants.ts:8`).
- **Why it matters:** today they only return `{module,status:'stub'}`, so no data leaks. But nothing enforces the rule "every `/api/v1/*` route except `agent/*` and `auth/*` has a guard". Any stub that a later merge fills in without a guard ships open.
- **Evidence:** review test `F-4: every /api/v1 route outside the allowlist requires a session` walks `v1.routes`. These fail (200 instead of 401): `GET /tenants`, `/tenants/:tenantId/memberships`, `/me`, `/tenants/:tenantId/enrollment-tokens`, `/devices`, `/plans`, `/tenants/:tenantId/subscriptions`, `/subscriptions`, `/devices/:deviceId/entitlements`, `/audit`. The public allowlist is `GET /api/v1`, `GET /api/v1/foundation` and the key-gated `PATCH /api/v1/foundation/release`.
- **Fix:** WT-2/3/5 replace the stubs with guarded handlers, or delete a stub until its owner lands. Keep F-4 in the suite permanently as the route-coverage gate, and add `/api/v1/agent/*` to it with the device-bearer expectation when WT-3 lands.
- **Fixed in `c573cc2`** (WT-1, one edit in WT-0's `routes/v1/index.ts` with WT-0's leave): `requireStaff()` on the exact paths of the routers that are still stubs (`/tenants`, `/tenants/:tenantId/memberships`, `/me`, `/tenants/:tenantId/enrollment-tokens`, `/devices`, `/audit`); owners delete their line when the guarded router lands. F-4 is green and stays in the suite.

### M-2 The deploy job installs unpinned dependencies while the Cloudflare API token is in the environment
- **Where:** `.github/workflows/deploy-cloudflare.yml:22-24` (job-level `CLOUDFLARE_API_TOKEN`/`ACCOUNT_ID`), `:37` (`pnpm install --no-frozen-lockfile`), `:38` (`pnpm run verify` runs tests and builds with the token present). Actions are pinned by tag, not by SHA.
- **Path:** a new patch release of any transitive dependency within its semver range gets installed at deploy time. Any code it runs at build or test time (vite/vitest plugins, `allowBuilds` packages) can read an account-wide Cloudflare token.
- **Fix:** use `pnpm install --frozen-lockfile`. Move the two Cloudflare variables to step-level `env` on the wrangler steps only. Pin third-party actions by commit SHA. Use a token scoped to Workers, D1 and R2 for this account.
- **Check to add:** a CI step that fails when the workflow contains `--no-frozen-lockfile`, or when `CLOUDFLARE_API_TOKEN` is set outside the steps that run `wrangler`.
- **Fixed in `dc4a98a`** (WT-0).

### M-3 Unauthenticated callers can grow the append-only audit log and send mail without bound
- **Where:** `src/auth/index.ts:152-164` writes one `AUTH_LOGIN_FAILED` row per failed verify (attacker-chosen `entity_id`, up to 254 chars). `src/email/index.ts:316-326` writes one `AUTH_OTP_SENT` row per send to any address. Open sign-up creates a `user` row for any address that completes a verify. The `audit_log_no_delete` trigger (0002) means none of these rows can ever be pruned.
- **Path:** the per-IP limits are the only brake, and they bucket IPv6 by /64. A client with a routed IPv6 /48 has 65,536 buckets. D1 storage and Email Service reputation and quota are shared with the whole control plane.
- **Fix:** add a Cloudflare zone rate-limiting rule on `/api/auth/*` (not bypassable by isolate or IP spread in the same way). Add Turnstile on the send step (skill `cloudflare-turnstile`). Aggregate failed-verify auditing for addresses with no user row (one counter row per address per window) instead of one row per attempt. Revisit the open sign-up decision (below).
- **Negative test:** assert that N failed verifies for one unknown address produce at most one audit row per window.

---
- **Fixed in `c573cc2`** (WT-1): sign-in no longer creates users (closed sign-in, `f62d5e8`); every send-path row (sent, `unknown_email`, `staff_email`) is bounded by Better Auth's per-IP limit and the H-1 caps (suppressed requests write nothing); failed code verifies for an address with no user row are audited once per 15 min, not per attempt; failed password sign-ins are bounded by the per-IP sign-in limit and the H-1 password caps. Tests: `auth-otp.test.ts` "M-3". Zone rate limiting and Turnstile remain recommended (edge, not in the Worker).

## Low

- **L-1 `http://localhost:5173` is trusted in production.** `src/auth/index.ts:21`, reused by `src/auth/middleware.ts:68`. Add it only when `ENVIRONMENT !== "production"`. Test: a cookie-bearing write with `Origin: http://localhost:5173` under `ENVIRONMENT=production` gets 403. **Fixed in `c573cc2`**: `trustedOrigins(env)` adds the Vite origin only outside production; test in `authz.test.ts`.
- **L-2 Login CSRF on `/sign-in/email-otp`.** That endpoint has no `formCsrfMiddleware`, and Better Auth's origin check runs only when a cookie is present (agent-notes "origin check is gated on the cookie"). A cross-site form post can therefore sign a logged-out browser into an account the attacker controls. The impact today is small, because such an account has no staff role. Fix: run `isCrossSiteWrite` (untrusted `Origin`, or `Sec-Fetch-Site: cross-site`) in the `/api/auth/*` handler in `src/index.ts` whether or not a cookie is present. Test: a cookieless `application/x-www-form-urlencoded` POST with `Origin: https://evil.example` and `Sec-Fetch-Site: cross-site` gets 403 and no `Set-Cookie`. **Fixed in `c573cc2`**: every POST under `/api/auth/*` needs a trusted `Origin` (or `Sec-Fetch-Site: same-origin`, which Better Auth then still requires an Origin for), cookie or not; test in `auth-otp.test.ts`.
- **L-3 Client-supplied `X-Correlation-Id` is written into audit rows.** `src/http.ts:149-151` accepts it from unauthenticated callers, so they can plant correlation ids that collide with real requests. Fix: always mint the id, and store any inbound value in a separate `client_correlation_id` column. **Fixed in `c573cc2`**: the correlation id is always minted server-side (stored in audit rows, returned as `X-Request-Id`); a well-formed client `X-Correlation-Id` is only echoed on the response. No new column; test in `authz.test.ts`.
- **L-4 `PHASE0_ADMIN_KEY` stays valid after the deploy, and the comparison is not constant-time.** `deploy-cloudflare.yml:122-129` never deletes the secret. `src/index.ts:82` compares with `!==`. Fix: run `wrangler secret delete PHASE0_ADMIN_KEY` in an `if: always()` step at the end of the job, and compare HMAC digests (or use `crypto.subtle.timingSafeEqual`). **Fixed in `dc4a98a`** (WT-0).
- **L-5 `workers_dev: true`** (`wrangler.jsonc:6`) serves the same app on a second origin that zone WAF and rate-limiting rules do not cover. Set it to `false`. **Fixed in `dc4a98a`** (WT-0).
- **L-6 Development values are in the same config file as the production route.** `wrangler.jsonc` pairs the `box.affinityminds.in` custom domain with `ENVIRONMENT: "development"`. A manual `wrangler deploy` would ship production with the OTP-echo guard disarmed and the placeholder bootstrap email. Fix: move the route into `env.production` (or fail at startup when the host is the production host and `ENVIRONMENT !== "production"`). Also add a CI grep that fails if `OTP_DEV_ECHO` appears in `wrangler.jsonc`. **Fixed in `dc4a98a`** (WT-0).
- **L-7 Some state changes have no audit row.** `/update-user` (name, image), session revocations and `/email-otp/reset-password` change state without audit rows. H-2's allowlist removes them. If any are kept, give each an audit event. **Fixed in `c573cc2` / `7ebffc8`**: the unaudited endpoints are gone (H-2); every remaining state change is audited: `AUTH_OTP_SENT`, `AUTH_LOGIN_SUCCEEDED/FAILED`, `AUTH_LOGOUT`, `AUTH_PASSWORD_CHANGED`, `AUTH_2FA_ENROLLMENT_STARTED/ENABLED/DISABLED/BACKUP_CODES_REGENERATED`, `STAFF_PASSWORD_SET`. `get-session` only slides the session expiry and is not audited.
- **L-8 Race in the last-super-admin check.** `routes/v1/staff.ts:84-94,131,167` checks first and writes afterwards. Two super admins demoting each other at the same moment can leave none; recovery then depends on the bootstrap email. Fix: make the demotion or delete a single conditional statement that only matches while another super admin remains, then check `meta.changes`. (Reasoned from the code; not reproduced in a test.) **Fixed in `c573cc2`**: demotion (upsert `setWhere`) and revoke (`DELETE … WHERE`) carry the "another super admin remains" condition inside the statement and check `meta.changes`.
- **L-9 `safeRedirect` accepts `/\host`.** `admin-web/src/auth/session.ts:17-21`. It is not exploitable today because TanStack Router pushes the path and `history.pushState` refuses cross-origin URLs, but that protection is incidental. Fix: `new URL(value, location.origin).origin === location.origin`, plus a test for `/\evil.example` and `/\t/evil.example`. **Fixed in `c573cc2`**: backslashes and control characters are refused and the resolved URL must keep our origin; tests for `/\evil.example` and `/\t/evil.example` in `admin-web/src/auth/session.test.ts`.
- **L-10 A missing `BETTER_AUTH_SECRET` does not fail closed.** `src/env.ts:180` makes it optional, and `createAuth` does not assert it. Add it to `assertOtpEchoSafe` (renamed `assertAuthConfig`) for production. **Fixed in `c573cc2`**: `assertAuthConfig` (renamed) throws when `BETTER_AUTH_SECRET` is missing, in every environment; test in `auth-otp.test.ts`.
- **L-11 (doc accuracy) The sign-in rate limit is 3 per 60 s, not 3 per 10 s.** The emailOTP plugin's rule overrides the core special rule. Correct the WT-1 handoff. **Fixed** in `docs/handoffs/wt-p1-auth.md` (this PR): code send 3 / 60 s and code sign-in 3 / 60 s per IP; staff password sign-in 3 / 10 s and `/two-factor/*` 3 / 10 s per IP.

## Decision input: open sign-up
**Resolved in `f62d5e8` / ADR 0009:** sign-in never creates users (`disableSignUp`, plus our own masking); rows come only from admin actions (`ensureUserByEmail`) and the bootstrap rule.

Any address that verifies a code gets a `user` row. Today that gives a signed-in, non-staff principal access to
403 pages, to the Better Auth self-service endpoints (closed by H-2), and to mint user rows (M-3). It becomes riskier once
WT-2 lands: every tenant route must use `requireTenantStanding`, and `/me/*` must never let a membership-less user
enumerate tenants. I recommend `disableSignUp: true`, with rows created only by the bootstrap and by invitations
(staff `POST /staff` already creates users). The "unknown email" path stays uniform because the plugin already
answers 200 without sending for unknown addresses when sign-up is disabled. Measure the timing gap with a delayed
mailer stub before you rely on that.

## WT-1 claims checked and holding
- The sign-in code is consumed atomically: the Drizzle adapter's `consumeOne` uses `DELETE … RETURNING`. Codes are stored hashed, a resend rotates the code, and 3 attempts burn it (existing tests).
- Bootstrap grant: one `INSERT … SELECT … WHERE NOT EXISTS … ON CONFLICT DO NOTHING`. D1 serialises writes, so two isolates cannot both grant.
- Permissions are rows. Deleting a `role_permissions` row denies on the next request, and a tenant id sent in the body is ignored in favour of the path (`authz.test.ts`).
- Logout deletes the session row and a reused cookie gets 401. `POST /api/auth/sign-out/` (trailing slash) does not bypass the audited logout (review test F-6 passes).
- `OTP_DEV_ECHO` with `ENVIRONMENT=production` throws in `createAuth` (fails closed), and `sendOtpEmail` checks again. Codes appear in no audit row. The mail body contains only the code and boilerplate. A send failure does not change the HTTP response.
- The audit triggers from 0002 survive 0003 (`ALTER TABLE ADD COLUMN` does not drop triggers).
- No `vars` entry authenticates. `.dev.vars` is gitignored. The deploy runs the version-stamp equality check, and its gating shell steps use `set -euo pipefail`.
- Cookies are host-only (existing test). `HttpOnly`, `SameSite=Lax` and `Secure`/`__Secure-` on https are Better Auth defaults. Review test F-8 asserts them only if a cookie is re-issued, so it is not conclusive on its own.
- The honeypot works as designed. It is a header, so it stops only naive bots, and it is no substitute for M-3's controls.

## What I could not test, and why
- **Edge behaviour:** real `cf-connecting-ip`, cross-isolate timing, WAF, and how the `workers.dev` origin behaves. The Workers pool is not the edge (agent-notes §15), and nothing is deployed yet.
- **Concurrency-dependent issues** (H-2's non-atomic attempt counter, L-8): I reasoned about them from the source and did not reproduce them in a test.
- **Browser-enforced behaviour:** SameSite handling, fetch-metadata headers and pushState origin rules (L-2, L-9) need a real browser (Playwright against `wrangler dev`).
- **Email Service delivery** and `E_SENDER_NOT_VERIFIED` in production. The `production` GitHub environment's protection rules and the actual scope of the Cloudflare token are not visible from the repo.
- **WT-2/WT-3/WT-5 code** is not merged yet. The second pass will extend this document.

---

# Second pass

Reviewed commit: `phase-1/identity` @ `a3fc5f0`, merged into `review/phase-1-security`. New surface since the first pass:
- closed sign-in
- staff email + password + TOTP (Better Auth `emailAndPassword` + `twoFactor`)
- forced first-sign-in setup and `setup_required`
- `POST /staff` with `initialPassword` (also resets existing staff)
- password lockout
- the `/api/auth` allowlist
- the bootstrap password seed and its workflow step

Better Auth 1.7.6 source read: `plugins/two-factor/{index,verify-two-factor,totp/index,backup-codes/index}.mjs`, `plugins/email-otp/*`.

New negative tests: `apps/worker-api/test/review/phase-1-second-pass.test.ts`. As before, each test asserts the secure behaviour.

```
pnpm --filter @cloudbox/worker-api test
Test Files  1 failed | 12 passed (13)
Tests       8 failed | 302 passed (310)
```
All 8 failures are in the second-pass file and each is a finding below. Test `describe` labels differ from finding ids for the checks that held: in the test file, `S-6 (holds)` is the setup-gate walk, `S-7 (holds)` the allowlist enumeration, `S-8 (holds)` the audit secret scan, and `S-9` is finding S-7 (bootstrap seed). Every first-pass review test (`phase-1-hardening.test.ts`) passes unmodified.

**Merge blockers (High): S-1, S-2.** There are no Critical findings.

## Second-pass findings

### S-1 (High) Anyone can lock any staff account, including every super admin, out of password sign-in
- **Where:** `apps/worker-api/src/auth/index.ts:158-161` (`PASSWORD_FAILURE_CAPS.perEmail` = 100 / h) and `:375-381` (over either cap, every request is refused with 429 **before** the password is checked, including a correct one).
- **Exploit path:** failures for a staff email are counted from `AUTH_LOGIN_FAILED` rows, whoever caused them. An attacker spreads 100 wrong passwords over 20 or more clients (the per-(email, client) cap of 5 does not stop this; the per-IP limit is 3 / 10 s). That is one free IPv6 /48 from a tunnel broker, or a few dollars of residential proxies. After that, the owner's correct password from anywhere gets 429 for the next hour. Repeating it every hour locks the account out indefinitely. Recovery needs another super admin's reset, or a D1 edit if every super admin is targeted. Existing sessions (7 days) are the only thing that keeps working.
- **Evidence:** test `S-1 … 100 wrong passwords from 100 unrelated clients do not stop the owner's correct password` fails with `expected 429 to be 200`. Those are 100 real API requests, 1 per client.
- **Fix:** the per-account ceiling must never refuse a correct password without a challenge a human can pass. Above the ceiling, require a valid Turnstile token on `/sign-in/email` (the skill `cloudflare-turnstile`; the login page already has a hidden-field pattern), and keep refusing only the (email, client) pairs that are over their own cap. For enrolled staff the password is only the first factor: Better Auth's TOTP account lockout (10 failures / 15 min) already limits the second step. An alternative is to drop the hard ceiling and alert on it instead (an audit event plus notification).
- **Negative test:** S-1. It passes once a correct password from a clean client is accepted above the ceiling, or once the test sends a valid Turnstile token.
- **Fixed in `5178503`** (WT-1): the per-account ceiling is gone. Failed passwords are limited only per (email, client /64), 5 / 15 min (429 with the wrong-password body, for that client only), plus Better Auth's per-IP limit; the account is protected beyond that by the authenticator step. No Turnstile or other challenge was added (none may deny the owner). Test S-1 passes.

### S-2 (High) The per-email OTP ceiling silently drops a customer's code: first-pass H-1 is back through the ceiling
- **Where:** `src/auth/index.ts:45-48` (`perEmail` 30 / h) and `:328-335` (over the ceiling: answer 200, generate nothing, send nothing).
- **Exploit path:** 30 send requests for a customer address from 10 or more clients (3 each, under both the per-IP and per-(email, client) limits) use up that address's hourly ceiling. For the rest of the hour every send, including the owner's from a fresh IP, answers "sent" and delivers nothing. The code the attacker's sends kept alive (reuse strategy) expires 5 minutes after the last one. About 30 requests per hour keep a customer out with no error shown to them.
- **Note on origin:** my first-pass H-1 fix text suggested exactly this ceiling ("for example 30 per hour") without checking that silently suppressing sends is itself a lockout. That was my error; WT-1 implemented what I recommended.
- **Evidence:** test `S-2 … 30 sends from 10 unrelated clients, then the owner still receives a code` fails with `expected 30 to be greater than 30`: the owner's request sent nothing.
- **Fix:** same shape as S-1. Above the per-email ceiling, send when the request carries a valid Turnstile token and suppress only token-less requests. The ceiling then stops mail bombing by bots without locking out a person. The response body must stay identical in every case (anti-enumeration).
- **Negative test:** S-2.
- **Fixed in `5178503`**: the 30 / h per-email ceiling is gone; only the per-(email, client) send cap remains, so the owner at a new client always gets a code. Tests S-2 and WT-1 `auth-otp.test.ts` "S-2" pass.

### S-3 (Medium) An authenticator code can be used more than once
- **Where:** Better Auth `plugins/two-factor/totp/index.mjs` (`createOTP(…).verify(code)`, no record of the last accepted time step). Configured at `src/auth/index.ts:580-584`.
- **Exploit path:** someone who has the password and one observed or phished code (shoulder-surfing, a real-time phishing proxy, a screen share) can complete another sign-in with the same code for the rest of its validity window, which is about 30 to 90 s with the default ±1-step tolerance. The same applies to the fresh-code check on `/two-factor/disable` (`src/auth/index.ts:443-450`).
- **Evidence:** test `S-3 … the same authenticator code cannot complete two sign-ins` fails: the replay answers 200.
- **Fix:** in the `after` hook for `/two-factor/verify-totp`, and in the disable pre-check, record the accepted time step per user, for example `INSERT INTO settings(key, …) VALUES ('totp_step:'||user_id||':'||step, …) ON CONFLICT DO NOTHING`, or a small `totp_used(user_id, step)` table in a reserved migration. Refuse when the row already exists, and do the check in the `before` hook so no session is issued. Alternatively, ask upstream for Better Auth's replay option if one exists in a later version.
- **Negative test:** S-3.
- **Fixed in `5178503`**: an accepted sign-in code, and the fresh code on `/two-factor/disable`, is claimed per user for 120 s in one atomic statement (`rate_limit`, hashed key); reuse fails like a wrong code, checked before Better Auth runs and again after (a lost race deletes the session it created). Enrolment codes are not claimed. Tests S-3 and WT-1 "fresh code … cannot be replayed" pass.

### S-4 (Medium) Any client can mint a 30-day authenticator bypass, and an admin reset does not revoke it
- **Where:** `/two-factor/verify-totp` and `/two-factor/verify-backup-code` are allowlisted (`src/index.ts:60-61`). Better Auth honours `trustDevice: true` from the request body (`verify-two-factor.mjs:41-58`), and on later password sign-ins skips the second factor for that device (`two-factor/index.mjs:252-271`). The admin UI sends `trustDevice: false` (`admin-web/src/api/auth.ts:58,61`), but the server does not enforce it. The reset, `setInitialStaffPassword` (`src/auth/users.ts:192-220`), removes the `two_factor` row and the sessions, but not the `trust-device-*` verification rows.
- **Exploit path:** a device that once completed TOTP with `trustDevice: true` needs only the password for 30 days, and the cookie renews itself on each use. Example: a keylogged or stolen laptop. The admin resets the member, and the member types the new password on the same machine. The attacker now has the new password, and the old trust cookie still skips the newly enrolled authenticator.
- **Evidence:**
  - test `S-4 … the server does not issue a trust-device cookie` fails: a `trust_device` cookie is issued.
  - test `S-4 … an admin reset … revokes trusted devices` fails with `expected 1 to be +0`: one trust row survives.

  The same test shows that sessions **are** ended by the reset (both jars get 401 on `/api/v1/auth/session`).
- **Fix:** in `src/index.ts`, reject (400) or strip `trustDevice` on the two verify paths, or set `trustDeviceMaxAge` to a value that disables it. In `setInitialStaffPassword` and after a successful `/change-password`, also run `DELETE FROM verification WHERE identifier LIKE 'trust-device-%' AND value = ?userId`.
- **Negative test:** both S-4 tests.
- **Fixed in `5178503`**: the before hook forces `trustDevice: false` on both verify paths, so no trust cookie is ever issued; an admin reset and every password change delete `trust-device-*` rows. Both S-4 tests pass.

### S-5 (Medium) The reset path gives the resetter a working login for any account, including another super admin
- **Where:** `src/routes/v1/staff.ts:98-112` (any `staff.manage` holder may set `initialPassword` on any existing staff member) and `:76-86` (role changes, including to `super_admin`, have no hierarchy check).
- **Exploit path:**
  - **(a)** Super admin A resets super admin B with a password A chose. B's second factor and sessions are removed. A signs in as B, changes the password, and enrols A's own authenticator. From then on every audit row attributes A's actions to B. The only trace is one `STAFF_PASSWORD_SET` row whose actor is A.
  - **(b)** Permissions are rows. If `staff.manage` is ever granted to `admin`, an admin can promote itself to `super_admin` in one request, and can take over super admins through (a).
- **Evidence:**
  - test `S-5 … a super admin cannot reset another super admin's password` fails: the reset answers 200.
  - test `S-5 … with staff.manage granted to 'admin' … cannot promote itself` fails: the self-promotion answers 200.
  - `(holds) an admin without staff.manage cannot reset a super admin` passes: 403.
- **Fix:**
  - Refuse `initialPassword` when the target's role ranks at or above the actor's, unless the target is the actor. Refuse granting a role above the actor's own.
  - For super-admin recovery, keep the bootstrap path, or require a second super admin's approval.
  - Better still, do not let the resetter choose or see the new credential. Email the target a one-time setup link through the existing Email Service binding, so the reset cannot be used to take over an account.
- **Negative test:** S-5 (three cases).
- **Fixed in `5178503`**: role ranking on `POST /api/v1/staff`: no role above the caller's; a role change or password reset only for accounts strictly below the caller (a super admin cannot reset or demote another super admin, nobody changes their own role; own password via `/change-password`). The emailed setup link is not implemented (would need Email Service for staff). All three S-5 tests pass.

### S-6 (Medium) Customer codes can be brute-forced slowly, and failed attempts across codes never lock the account
- **Where:** `src/auth/index.ts:589-596` (3 attempts per code; `reuse` keeps a code alive while sends continue; a burned code is deleted and the next send issues a fresh one with 3 new attempts).
- **Path:** the ceiling allows 30 sends / h per address. That is up to 90 guesses per hour against a 10⁶ space, about 0.2 % per day and roughly 50 % over a year of sustained effort, from a modest pool of clients. Nothing limits failed verifies across codes for one account. Customers have no data routes yet, but WT-2 makes them tenant owners.
- **Fix:** add a per-account ceiling on failed code verifies (for example 10 per 24 h), counted from `AUTH_LOGIN_FAILED` rows for the address. Above it, require Turnstile, which fits the S-2 fix, and alert on it.
- **Test to add:** simulate 10 burned codes for one address (by seeding rows), then a correct code without Turnstile is refused and a notification or audit row is written. Not added in this pass, because it needs the product decision on the challenge.
- **Fixed in `5178503`**: failed code sign-ins are capped at 10 / h per (email, client /64) across codes; above it every code from that client fails like a wrong one without being checked or consumed. No per-account cap (S-1/S-2 lesson). Test: `auth-otp.test.ts` "S-6".

### S-7 (Low) The bootstrap seed records `mustChangePassword: true` but does not set it
- **Where:** `src/auth/users.ts:267-301`. When the bootstrap email already holds `super_admin` and the seed has not run, which happens whenever `BOOTSTRAP_SUPER_ADMIN_PASSWORD` is added after the fact, the owner's password is silently replaced by the GitHub secret. `must_change_password` and the authenticator are left as they were, so the audit row is false.
- **Evidence:** test `S-9 … seeding a password onto an existing super admin sets must_change_password` fails with `expected +0 to be 1`, and the seed's `STAFF_PASSWORD_SET` row is present.
- **Fix:** seed only when the bootstrap user has no credential account. Otherwise mark the seed done without touching the password. When the seed does run, also set `must_change_password = 1`.
- **Fixed in `5178503`**: the seed never overwrites an existing password (it only marks itself done); when it does seed, it sets `must_change_password = 1`, so the `STAFF_PASSWORD_SET` row is true. Test S-9 passes.

### S-8 (Low) Other residuals
- **Non-staff password failures:** every non-staff failure on `/sign-in/email` writes one audit row and runs one scrypt hash (`src/auth/index.ts:384-394`). Only the per-IP limit bounds this (first-pass M-3 class). Apply the once-per-window rule the OTP path already has, and put Turnstile in front (S-1).
- **`revokeOtherSessions` is chosen by the client:** the UI sends `revokeOtherSessions: true` (`admin-web/src/api/auth.ts:67`), but the server accepts `false`. Force it in the `before` hook for `/change-password`.
- **Bootstrap window:** until the owner's first sign-in, the bootstrap account can be claimed by anyone who holds the GitHub `production` environment secret. They could complete the forced setup with their own authenticator. The Worker secret also stays set after seeding. Sign in right after the first deploy, then run `wrangler secret delete BOOTSTRAP_SUPER_ADMIN_PASSWORD` once `auth.bootstrap_password_seeded` exists.
- **Shared NAT:** the per-(email, client) password cap locks out a staff member who shares a NAT, CGNAT or office IPv4 with the attacker. S-1's Turnstile fix covers this.
- **Fixed in `5178503`** (Worker parts): non-staff password failures are audited once per 15 min per address and count toward the same per-(email, client) limit (beyond it nothing is hashed or recorded); within the limit the hash is kept so timing does not separate staff from non-staff addresses. `revokeOtherSessions` is forced to true server-side. Bootstrap window and shared NAT: operational notes in the WT-1 handoff (delete the Worker secret after the owner's first sign-in).

## Verdicts on the first-pass "Fixed in" notes

| Finding | Verdict | Evidence |
|---|---|---|
| H-1 OTP lockout | **Fixed in `5178503`** (ceiling removed, S-2). Was: **Partially fixed.** Per-(email, client) cap and reuse hold; the per-email ceiling reintroduces the lockout (S-2). | WT-1 test "H-1: a caller at another IP…" passes; S-2 fails |
| H-2 hidden endpoints | **Fixed.** Exact-match allowlist; every other Better Auth endpoint, enumerated from `auth.api`, answers 404 to GET and POST. | F-2 passes; S-7 (all enumerated endpoints) passes |
| M-1 open stubs | **Fixed.** | F-4 passes |
| M-2 deploy supply chain | **Partially fixed.** Cloudflare token is now step-scoped. `pnpm install --no-frozen-lockfile` remains (`deploy-cloudflare.yml:34`, `ci.yml:33,62`), and actions are still tag-pinned. | grep of workflows |
| M-3 unbounded rows | **Fixed in `5178503`** (password failures now deduplicated like codes; counters hold no rows per attempt). Was: **Partially fixed.** Accepted design: bounded by per-IP limits. Code-verify failures are deduplicated; password failures are not (S-8). | reading + WT-1 "M-3" tests |
| L-1 dev origin trusted | Fixed | `trustedOrigins(env)`; WT-1 test |
| L-2 login CSRF | Fixed. `isSameOriginWrite` covers every `/api/auth/*` write, with or without a cookie. | reading + WT-1 test |
| L-3 correlation id | Fixed | `http.ts` always mints |
| L-4 Phase 0 key | **Partially fixed.** The retire step is not `if: always()` and ends in `|| true`, so a failed prove step or a failed delete leaves the key live. `src/index.ts:115` still compares with `!==`. | `deploy-cloudflare.yml:193-198` |
| L-5 workers.dev | Fixed | `wrangler.jsonc` |
| L-6 dev values next to the prod route | Fixed: `ENVIRONMENT` now defaults to `production`. The suggested CI grep for `OTP_DEV_ECHO` was not added (minor). | `wrangler.jsonc` |
| L-7 unaudited writes | Fixed. No secret material in any audit row after a full lifecycle. | S-8 (audit scan) passes |
| L-8 last-super-admin race | Fixed. The condition is inside the `UPDATE … WHERE` / `DELETE … WHERE`, and D1 serialises writes. | reading |
| L-9 `safeRedirect` | Fixed | WT-1 admin-web tests |
| L-10 missing secret | Fixed | `assertAuthConfig` |
| L-11 doc | Fixed | handoff |

## New surface, claims that held
- **`setup_required`:** every `/api/v1` route except `GET /auth/session` and `POST /auth/logout` answers 403 `setup_required` to a staff member mid-setup. S-6 walks every v1 route. `/api/auth` setup endpoints are the intended exception.
- **Setup order:** enabling an authenticator before changing the initial password is refused (`PASSWORD_CHANGE_REQUIRED`; WT-1 test "in order").
- **Non-staff password sign-in:** it fails exactly like a wrong password and costs a hash (WT-1 test). Staff cannot use email codes (WT-1 test).
- **Backup codes:** single use, with an atomic compare-and-set on the encrypted list (Better Auth; WT-1 test "a backup code works once").
- **Challenge limits:** 5 wrong codes per challenge burn it, and Better Auth's account lockout (10 / 15 min) applies.
- **Admin reset:** ends every session of the target (S-4, second test, session part).
- **Bootstrap:** grant and seed are race-safe (single conditional statements plus a claim row). The workflow sets the Worker secret only when it is absent and never echoes it.

## Blocking list for the Phase 1 merge
1. **S-1** per-account password ceiling lockout.
2. **S-2** per-email OTP ceiling lockout. This is the remaining part of H-1.

Recommended before merge, not blocking: S-3, S-4, S-5 (Medium), M-2's frozen lockfile, L-4's `if: always()`.

## Second pass, not tested and why
- **Turnstile and edge rate limiting:** they sit at the edge or in the browser, so the Workers pool cannot show them.
- **S-6 brute-force rate:** it is probabilistic, so I worked it out on paper instead of running it.
- **TOTP clock-skew tolerance:** the exact width (±1 step) was read from `@better-auth/utils/otp` defaults, not measured.
- **Deploy scope:** the real `production` environment protection rules and the Cloudflare token scope are not visible from the repo.
- **WT-2 and WT-3:** tenant, membership and device routes are still stubs here. Tenant-boundary and enrollment checks wait for their branches.
