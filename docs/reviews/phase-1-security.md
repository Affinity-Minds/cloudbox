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
- **L-6 Development values are in the same config file as the production route.** `wrangler.jsonc` pairs the `box.affinity.ai.in` custom domain with `ENVIRONMENT: "development"`. A manual `wrangler deploy` would ship production with the OTP-echo guard disarmed and the placeholder bootstrap email. Fix: move the route into `env.production` (or fail at startup when the host is the production host and `ENVIRONMENT !== "production"`). Also add a CI grep that fails if `OTP_DEV_ECHO` appears in `wrangler.jsonc`. **Fixed in `dc4a98a`** (WT-0).
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

---

# Third pass / verdict

Reviewed commit: `origin/phase-1/identity` including WT-1's `5178503` (PR #10), merged into `review/phase-1-security`.
New test file: `apps/worker-api/test/review/phase-1-third-pass.test.ts`.

```
pnpm --filter @cloudbox/worker-api test
Test Files  1 failed | 13 passed (14)
Tests       1 failed | 314 passed (315)
```
Every first- and second-pass review test passes unmodified. The one failure is the new T-2 test below.

## Verification of the S-fixes
| Finding | Verdict | How checked |
|---|---|---|
| S-1 password ceiling lockout | **Closed.** There is no per-account ceiling left anywhere in `src/auth/**`; the only password limit is the per-(email, client) `pw-fail` counter, which returns 429 only to the client over its own limit. The owner at a fresh client always reaches the password check. | grep of `src/auth`; S-1 test (100 real failures from 100 clients, then the owner's correct password gets 200) |
| S-2 OTP ceiling lockout | **Closed.** The send cap is per (email, client) only (`src/auth/index.ts:53,100-116,328`). The owner at a fresh client always gets a code. | S-2 test passes |
| S-3 TOTP replay | **Closed for sign-in and disable.** `before` refuses a code already claimed for the user. `after` claims `(user, code)` for 120 s in one conditional upsert (`counters.ts:53-61`), and the race loser's session is deleted before the refusal (`index.ts:587-601`). 120 s covers the ±1-step window. Enrolment confirmation is not claimed, which is harmless. | reading + S-3 test |
| S-4 trusted devices | **Closed.** `trustDevice` is forced to `false` in `before` on both verify paths. Trusted-device rows are deleted on admin reset and on every password change. | both S-4 tests pass |
| S-5 reset/role ranking | **Closed.** No grant above your own rank. Role change or reset is allowed only on targets strictly below you, so no self role change, no self reset through `/staff`, and no peer super-admin reset. Revoke is unranked but keeps the last-super-admin guard. That is acceptable while only `super_admin` holds `staff.manage`. If `staff.manage` is ever granted to a lower role, rank the revoke too. | S-5 tests (3) pass; reading `staff.ts:73-87` |
| S-6 slow code guessing | **Only per client.** `OTP_FAILURE_CAP` is 10 / h per (email, client). Nothing bounds guessing per account. See T-1. | reading |
| S-7 bootstrap seed | Closed. It never overwrites an existing password and sets `must_change_password`. | S-9 test passes |
| S-8 residuals | Closed. Non-staff password failures are audited once per window. `revokeOtherSessions` is forced server-side. | reading |
| M-2 / L-4 (first pass) | Closed. `--frozen-lockfile` in both workflows. The retire step is `if: always()` without `|| true`. The Phase 0 key comparison is constant-time. Actions are still pinned by tag rather than SHA; that is minor and not blocking. | workflow diff |

**WT-1's deviation: non-staff password attempts still run a hash. This is the right call.** Skipping the hash would let a caller tell staff addresses from others by response time. A scrypt verify takes tens of milliseconds, which is easy to measure. The cost is Worker CPU per attempt. Better Auth's per-IP `/sign-in` limit (3 / 10 s, applied before any hook) and the per-(email, client) counter bound that cost per client. The distributed version is the ordinary login-endpoint cost problem, and it belongs at the edge: a Cloudflare WAF rate-limiting rule on `/api/auth/sign-in/*`, keyed per IPv6 /48.

## New findings
### T-1 (High, blocks the first customer-authorised route) Distributed guessing of customer codes has no per-account bound
- **Where:** `src/auth/index.ts:53` (sends 5 / 15 min per client) and `:60-66, 356-364` (failed checks 10 / h per client). The client key is Better Auth's `getIP`, which masks IPv6 to /64 (`advanced.ipAddress` has no `ipv6Subnet`).
- **Path:** every /64 gets its own 10 checked guesses per hour against a 10⁶ space. A routed /48 (free from tunnel brokers) is 65,536 /64s, which is about 655,000 guesses an hour, or roughly a 48 % chance of taking over a given customer account per hour. A /56 still gives about 6 % per day.
  - Each burned code needs a new send, so the victim receives a flood of mail but cannot stop it.
  - A failed mail send does not stop the code being stored, because `resolveOTP` stores it first.
- **Why it does not block this tree:** today a customer session reaches nothing. Every `/api/v1` route except the session and logout endpoints is staff- or permission-gated (review tests F-4 and S-6 walk all of them).
- **Why it blocks WT-2:** it must be fixed before any route authorises a customer (WT-2 `me`, memberships, tenant standing).
- **Fix (cheap first, then complete):**
  1. Set `advanced.ipAddress.ipv6Subnet: 48`. The per-IP limits and every `counters.ts` key then treat a /48 as one client, which cuts the attacker's multiplier from 65,536 to 1 per /48.
  2. Add an account-level failed-check budget (for example 20 per 24 h per address, counted in `counters.ts`). Above it, a verify must carry a valid Turnstile token. A human owner passes, so this is not a lockout (the S-1/S-2 lesson). Requests without a token fail like a wrong code, without being checked.
  3. Add a Cloudflare WAF rate-limiting rule on `/api/auth/*` as defence in depth.
- **Test to add:** after 20 checked failures for one address from 20 clients, a 21st wrong guess from a new client does not increment the code's attempt count (it is not checked). With a valid Turnstile token (test secret), the owner's correct code gets 200. Not added in this pass, because the budget value and the Turnstile wiring are product decisions.
- **Fixed in `229781c`** (WT-1): (1) `advanced.ipAddress.ipv6Subnet: 48`, so Better Auth's per-IP limits and every `counters.ts` key treat a /48 as one client. (2) Per-address budget of 30 failed code checks per hour across all clients (`src/auth/challenge.ts`); above it, sending and checking codes for that address need a valid Turnstile token (siteverify, hostname must equal the request host), otherwise 403 `{error:'challenge_required', detail:{siteKey}}`, identical for known and unknown addresses. A person passes, so it is not a lockout. Without `TURNSTILE_SECRET_KEY` the fallback is a 15-minute per-account cooldown (429 `account_cooldown`, audited `AUTH_ACCOUNT_COOLDOWN`): the only per-account denial in the system, until Turnstile is configured. (3) WAF rule recommended in the WT-1 handoff. Tests: `auth-stepup.test.ts` (5).

### T-2 (Medium) Other clients can burn the owner's code before the owner uses it
- **Where:** Better Auth `atomicVerifyOTP` allows 3 attempts per code no matter which client makes them (`allowedAttempts: 3`, `src/auth/index.ts`).
- **Path:** three wrong guesses from any three clients burn the code sitting in the owner's inbox, and the owner's correct entry then gets 403 `TOO_MANY_ATTEMPTS`. To keep burning every new code takes about 3 attempts every ~30 s. With 10 failures / h per client, that is roughly 36 clients (/64) an hour to keep one customer out. That is costlier than S-1/S-2 were, but still cheap with IPv6.
- **Evidence:** test `T-2 … three wrong guesses from three unrelated clients do not invalidate the owner's code` fails with `expected 403 to be 200`.
- **Fix:** the T-1 fixes cover most of it: /48 keying multiplies the cost by 65,536, and an account budget with Turnstile above it stops token-less burning. Once the per-client and per-account budgets bound guessing, it is also safe to raise `allowedAttempts` (for example to 10).
- **Fixed in `229781c`**: `allowedAttempts` 5, and a guess from a client that never requested a code for the address is checked with Better Auth's own decryption and constant-time compare without spending the code's attempts (it counts against the per-client cap and the account budget). The T-2 test passes; `auth-otp.test.ts` "five wrong codes from clients that requested it…" covers the requester side.

## Verdict
- **Phase 1 as merged at this SHA: no open High with present impact; OK to merge to main.** S-1 and S-2, the previous blockers, are closed and verified by the review tests.
- **Condition:** T-1 is High and blocks the merge of any route that authorises a customer (WT-2). Fix it together with WT-2, or before.
- **Should fix soon:** T-2 (Medium), and pinning actions by commit SHA (Low).

---

# Fourth pass / merge verdict

> **WT-1 note on test edits (owner decisions after this pass).** Staff and customers became two identity systems with separate mounts and tables (ADR 0002). The review tests were changed only where the owner's decision moved what they address, never in what they assert: staff endpoints `/api/auth/…` → `/api/ops/auth/…` (second pass), table names `user`/`verification` → `staff_users`/`customer_verifications`/`staff_verifications` (second pass), the bootstrap trigger `/api/auth/get-session` → `/api/ops/auth/get-session` (S-9), S-6 skips the customer-only `/api/v1/me/*` routes (a staff session is not read there: 401, asserted in `permission-matrix.test.ts`), and U-3 also accepts 401 for a customer session on a staff screen (it is not read at all).

Reviewed commit: `origin/phase-1/identity` @ `c043a8b`, which includes WT-1 `229781c` (PR #14), WT-2 (tenants and memberships) and WT-3. It is merged into `review/phase-1-security`.
New test file: `apps/worker-api/test/review/phase-1-fourth-pass.test.ts`.

```
pnpm --filter @cloudbox/worker-api test
Test Files  1 failed | 22 passed (23)
Tests       4 failed | 433 passed (437)
```
Every earlier review test passes, including T-2. The 4 failures are the fourth-pass findings below.

## T-1 / T-2 fixes: what holds
- **IPv6 /48 keying:** `advanced.ipAddress.ipv6Subnet: 48` is set, so Better Auth's limits and every `counters.ts` key share the same /48 client.
- **Account budget and step-up** (`src/auth/challenge.ts`):
  - It is the same for every address. It counts only failures, which anyone can cause for any address, so `challenge_required` depends only on a counter the caller controls and does not reveal which addresses exist.
  - Siteverify checks `success` and that `hostname` equals the request host.
  - Turnstile tokens are single use at Cloudflare, so a token cannot be replayed for a second address. A token is not bound to one address, but it buys exactly one request, which is acceptable.
- **Foreign guesses:** they do not consume the owner's attempts. T-2 passes.
- **Cooldown as an interim measure:** 30 failures from 30 /48s or IPv4 addresses per hour does give a repeatable 15-minute lockout of any customer while `TURNSTILE_SECRET_KEY` is unset. **This is acceptable only as an interim, and only if it is closed at go-live.** The deploy workflow currently just logs "not set" (`deploy-cloudflare.yml:167`). Make that step fail when `ENVIRONMENT` is `production` and customer sign-in is enabled, or at least emit `::warning::` and list it in the go-live checklist. Not blocking.

## New findings
### U-1 (High, blocks the merge) A Unicode case variant of the email skips every CloudBox code-sign-in control
- **Where:**
  - `src/auth/index.ts`, `before` hook for `/sign-in/email-otp`: `if (!email.success) return;`
  - `src/auth/challenge.ts:82-83`: `if (!email.success) return null;`
  - The `after` hook records failures for the address `"invalid"`, so a variant failure counts toward nothing.
- **Why it works:** the contracts `Email` parser (zod `z.email()`) is ASCII-only, so `"Kate@x"` fails it. Better Auth's `signInEmailOTP` does not validate the address; it only calls `toLowerCase()`, and `"K".toLowerCase() === "k"`. The request therefore reaches the real `kate@x` code while skipping:
  - the per-client failure cap (S-6)
  - the account budget, cooldown and Turnstile step-up (T-1)
  - the "never requested a code" guard (T-2)
- **Exploit path:** any customer address containing `k`. The attacker requests codes under the real address, which is capped per client. Then they guess using the variant from as many clients as they like. Only Better Auth's per-IP limit (3 / 60 s per IPv4 or /48) and 5 attempts per code remain, so with a pool of IPv4 proxies the T-1 arithmetic applies again. A correct guess signs in as the customer, and since WT-2 merged, that is a tenant member or owner.
- **Evidence:**
  - `U-1 … wrong guesses for 'Kate' (Kelvin sign) do not consume the owner's attempts` fails with `expected 403 to be 200`: the variant burned the owner's code.
  - `U-1 … the variant does not sign in past the account cooldown / step-up` fails. The real address gets 429 `account_cooldown`, while the variant **signs in (200)** with the code from a client that never requested it.
- **Fix:** fail closed on unparseable addresses. In the `/api/auth/*` middleware in `src/index.ts`, for `/email-otp/send-verification-otp`, `/sign-in/email-otp` and `/sign-in/email`, parse `body.email` with the contracts `Email` and answer 400 `invalid_request` if it fails. In the hooks, change `if (!email.success) return` / `return null` to throw. The staff password path is not affected, because Better Auth validates the raw address before lowercasing it; add it to the middleware check anyway.
- **Negative test:** both U-1 tests.
- **Fixed in `fef2e5b`** (WT-1, completed with the identity split in `8020566`): the contracts `Email` now normalises before validating (`normalizeEmail`: NFKC, trim, lower-case), so `"Kate"` becomes `kate` and every counter, cap, budget and guard keys on the one spelling. The `/api/auth/*` and `/api/ops/auth/*` gate (`src/index.ts`) parses `body.email` on send-code, code sign-in and password sign-in, answers 400 `{error:'invalid_request'}` when it does not parse, and hands Better Auth a request whose `email` is the normalised value; the hooks throw instead of returning. Both U-1 tests pass unmodified.

### U-2 (Medium) Tenant standing is not ranked: a tenant admin can make itself owner and remove the owner
- **Where:** `src/routes/v1/memberships.ts:119-158` (PATCH) and `:160-192` (DELETE), plus POST with `standing: "owner"`. `requireTenantManageOrAdmin` admits `admin` and `owner` equally, and nothing compares the caller's standing with the target's or the new one. There is no last-owner guard.
- **Exploit path:** a tenant admin PATCHes its own membership to `owner` and then revokes the real owner. The result is a takeover inside that tenant. It does not cross tenants.
- **Evidence:**
  - `U-2 … a tenant admin cannot make itself owner` fails: 200.
  - `U-2 … cannot revoke the tenant's only owner` fails: 200.
  - `(holds) a tenant user cannot change its own standing` passes: 403.
- **Fix:** mirror the staff ranking from S-5 for tenant members (staff with `tenant.manage` bypass it). A member may only grant a standing at or below its own. It may change or revoke only memberships strictly below its own. Keep a last-active-owner guard inside the `UPDATE` / `DELETE` statement, as in L-8.
- **Fixed** by WT-2 (`d4f26af`, standing ranking + last-active-owner guard), merged into `wt/p1-auth` in `24a674e` and adapted to customer identities (`customer_users`). Both U-2 tests pass.

## Tenant boundary (WT-2 glance): holds
The test `U-3 (holds)` checks all three:
- A member of tenant A gets 403 on `GET /screens/tenants/:idB` (the screen needs staff `tenant.view`).
- A member of A gets 403 on `POST /me/active-tenant {tenantId: B}` (membership is re-resolved server-side, and `getActiveTenantId` re-checks it on every read).
- A member of A gets 403 on `POST /tenants/:idB/memberships` (standing is read from the path `tenantId`).

A tenant `user` cannot change its own standing.

## Merge verdict
**Do not merge Phase 1 to main yet: U-1 (High) is open.** The fix is small (validate the address before anything else, and fail closed in the hooks), and the two U-1 tests show when it is done. After U-1 is fixed, merging is acceptable with these follow-ups:
- **U-2** (Medium): tenant takeover by a tenant admin. Fix it before customers get self-service member management in the UI.
- Make the deploy fail or warn loudly while `TURNSTILE_SECRET_KEY` is missing in production.
- Pin actions by commit SHA (Low).

---

# Fifth pass / final verdict

Reviewed commit: `origin/phase-1/identity` @ `13186f4`. It rebuilds identity as two Better Auth instances, one for staff and one for customers. Each has its own tables, cookies (`cbx_ops_session` / `cbx_session`), secrets, mounts (`/api/ops/auth/*` / `/api/auth/*`) and plugin lists. The branch also moves the staff console under `OPS_BASE_PATH` (`src/ops-shell.ts`), fixes U-1 and fixes U-2. It is merged into `review/phase-1-security`, which is now at `54a1136`.
New test file: `apps/worker-api/test/review/phase-1-fifth-pass.test.ts`.

```
pnpm --filter @cloudbox/worker-api test                        → 26 files, 469 passed (before the new file)
vitest run test/review/phase-1-fifth-pass.test.ts             → 4 passed, 1 failed (W-1, Low)
drizzle-kit generate                                          → "No schema changes, nothing to migrate"
```

## WT-1's edits to the review tests: verified
`git diff c5dd820..HEAD -- apps/worker-api/test/review` touches only `phase-1-second-pass.test.ts` and `phase-1-fourth-pass.test.ts`. Almost every change is an address change: `/api/auth/*` became `/api/ops/auth/*` on the staff paths, and `verification` / `"user"` became `customer_verifications` / `staff_users` / `staff_verifications`. Two changes touch assertion scope, and both are sound:
1. **`U-3` screen read:** `[403, 404]` became `[401, 403, 404]`. A customer cookie is no longer read on a staff screen at all, so 401 is the correct denial. It is still a denial.
2. **`S-6 (holds)` setup-gate walk:** now skips `/api/v1/me*`. Those routes are customer-only and never read a staff session, so a staff member mid-setup gets 401 there. The new test `V-1 … a super admin has no tenant standing and no customer routes` covers this independently and passes.

No `expect` was weakened in U-1, U-2, S-1…S-5, S-7…S-9, T-2 or F-2/F-4/F-6/F-8. All of them pass, including both U-1 Kelvin-sign tests (the NFKC + trim + lowercase `Email`, which fails closed) and both U-2 tenant-ranking tests.

## Separation attacks: all hold
- **A customer cookie cannot reach `requirePermission`:** it uses `guardFor("staff", …)` (`authz/permissions.ts:44-47`). A tenant owner's customer session gets 401 on `/staff`, `/screens/audit`, `/screens/overview` and `/plans` (test V-1).
- **A staff cookie cannot reach `requireTenantStanding` or `getTenantStanding`:** `guardFor("customer", …)` applies, `getTenantStanding` returns null for any non-customer surface, and the per-request cache key is now `userId:tenantId`. A super admin gets 401 on `/me/tenants` and `/me/active-tenant` (V-1). The FKs back this up at the database level: `staff_members → staff_users` and `tenant_memberships → customer_users` (0003).
- **Routes open to both audiences** (`guard` = "either": memberships, enrollment; `requireSession`: session, logout): each candidate principal is checked on its own, with its own permissions or standing. Scopes never combine. With both cookies, a `read_only` staff member plus a tenant `user` still gets 403 on an invite and 403 on `/staff` (V-1). The fleet screen uses `getPrincipal`: staff first, with no fallback to the customer principal, which fails closed.
- **`?as=staff|customer`** exists only on `GET /api/v1/auth/session` and logout. It only chooses which of the caller's own cookies to report or end, so it cannot be abused.
- **`OPS_BASE_PATH`:** one segment only, `^/[A-Za-z0-9_-]{1,128}$`, trimmed. Empty, `/`, traversal, dots, percent-encoding and multi-segment values all fall back to `/ops` (V-2).
- **Ops-shell marker:** it is injected server-side, only on known console routes, and escaped. A client that forges it only changes its own UI. Every staff API call is still authorised by the staff cookie and staff tables. Being hard to find is not a security control here, and the review does not treat it as one. `/api/ops/auth/*` answers under any base path.
- **Bootstrap seeding:** `ensureBootstrapSuperAdmin` → `ensureStaffUserByEmail` → staff tables only. Staff grants use `ensureStaffUserByEmail`, and memberships use `ensureCustomerByEmail`. The deprecated alias `ensureUserByEmail` maps to customers and has no caller in `src/` (grep).
- **Secrets:** separate `STAFF_AUTH_SECRET` and `CUSTOMER_AUTH_SECRET`. `assertAuthConfig(env, surface)` fails closed when the one for that surface is missing.
- **Migrations 0003/0004, rewritten in place:** they match the Drizzle schema (no drift). Production only ever applied 0001/0002 (`origin/main` holds only those two), so rewriting them is safe for production. Any dev or staging D1 that applied the old 0003/0004 must be recreated.

## New findings (none blocking)
- **W-1 (Low):** `OPS_BASE_PATH` accepts `/api` and `/assets` (`ops-shell.ts:11`). With `/api`, the console becomes unreachable, because `/api/*` goes to the Worker's API and 404s. It is a misconfiguration trap, not a security hole. Fix: reserve `api` and `assets` (and any top-level static directory) in `opsBasePath`. Test: `V-2 (Low) …` (fails today).
- **W-2 (Low, defence in depth):** the tenant branch of `resolveFleetAccess` (`screens/fleet.ts:22-34`) queries memberships by `principal.user.id` without checking `principal.surface === "customer"`. The FK makes a staff id in `tenant_memberships` impossible, so this cannot be exploited today. Add the surface check so it does not depend on the schema.

## Final verdict
**Phase 1 may merge to main. No Critical or High findings are open.** Every earlier blocker is closed and verified by the review tests: H-1, H-2, S-1, S-2, T-1, U-1. U-2 (tenant ranking) is also closed.

Follow-ups, none blocking:
- W-1, W-2 (Low).
- Make the deploy fail or warn loudly while `TURNSTILE_SECRET_KEY` is missing in production (fourth pass).
- Pin workflow actions to commit SHAs.
- Recreate any dev or staging D1 that applied the old 0003/0004.
