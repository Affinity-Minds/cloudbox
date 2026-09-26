# Handoff — WT-1 `wt/p1-auth` (email OTP authentication + staff authorisation)

## Mission

**Slices:** 1.1 Email OTP authentication, 1.2 Staff authorisation model.

**Success criterion:** a staff member signs in with a six-digit emailed code through Better Auth on
D1, gets a host-only session cookie, every protected route is authorised server-side from D1 rows
per request, staff roles are managed through an audited API, and logout invalidates the session.

---

## Current status

- Branch: `wt/p1-auth`, parent `phase-1/identity`.
- Phase A (middleware spine) `dd29e12`: PR #4, merged into `phase-1/identity` (`9e59505`).
- Phase B: draft PR https://github.com/Affinity-Minds/cloudbox/pull/6
- Phase B: staff API, login UI, route guard, user menu, evidence, this handoff.
- `pnpm run verify`: green (see "Tests run" for the worktree-path caveat on `pnpm check`).

## Commits ready for merge

```
dd29e12 feat(auth): Better Auth email OTP + authz spine (WT-1 phase A)      [merged]
688f8a0 feat(staff): GET/POST/DELETE /api/v1/staff gated by staff.manage, audited
6c5d752 feat(admin-web): OTP login, route guard, sidebar user menu with sign-out
a27a703 Merge remote-tracking branch 'origin/phase-1/identity' into wt/p1-auth
42a8cc9 docs: WT-1 handoff; issue log
(+ this PR-link fix-up)
```

---

## Files and contracts changed

- **worker-api**
  - `src/auth/index.ts`: `authOptions(env, {correlationId, baseURL})`, `createAuth(env, ctx?)`, `authFor(c)`, `assertOtpEchoSafe`, constants `TRUSTED_ORIGINS`, `HONEYPOT_HEADER` (`x-cloudbox-hp`), `OTP_SENDS_PER_EMAIL`.
  - `src/auth/middleware.ts`: `requireUser()`, `requireStaff()`, `guard(check)`, `getPrincipal(c)`.
  - `src/auth/rate-limit-table.ts`: Drizzle table for Better Auth's `rateLimit` model.
  - `src/authz/permissions.ts`: `requirePermission(key)`, `requireTenantStanding(min)`, `getTenantStanding(c, tenantId)`.
  - `src/email/index.ts`: `sendOtpEmail(env, {to, code}, {correlationId})`, `otpEmailBody(code)`.
  - `src/routes/v1/auth.ts` (`GET /session`, `POST /logout`, exported `logout`), `src/routes/v1/staff.ts`.
  - `src/index.ts`: Better Auth mounted at `/api/auth/*`; `POST /api/auth/sign-out` routed to the audited logout.
  - `src/routes/v1/screens/overview.ts` → `requirePermission("tenant.view")`, `screens/audit.ts` → `requirePermission("audit.view")`. The screens index (`screens/index.ts`) has no handler of its own, so nothing to gate there; `GET /api/v1/foundation` (Phase 0 page) is still public, untouched.
  - `vitest.config.ts`: test-only `BETTER_AUTH_SECRET`, `OTP_DEV_ECHO: "0"`.
  - `test/auth-fixtures.ts`: `signInAs(env, {email, name?, staffRole?}) → {cookie, userId, headers}`.
- **admin-web**: `src/api/auth.ts`, `src/auth/session.ts`, `src/auth/user-menu.tsx`, `src/routes/login.tsx`, `src/routes/_app.tsx` (`beforeLoad` only), `src/components/app-sidebar.tsx` (one import + `<UserMenu />` in the footer, where WT-0's comment placed it).
- **contracts**: none changed; uses `OtpSendRequest`, `SessionResponse`, `CreateStaffRequest`, `StaffMember`, `Email`.
- **Configuration**: see "Deploy needs".

## Migrations

- Reserved number `0004`: `infra/cloudflare/migrations/0004_auth_rate_limit.sql`, table `rate_limit(id, key UNIQUE, count, last_request)`, needed because Better Auth rate limits are stored in D1 (`rateLimit.storage = "database"`) so every isolate shares them. Applied locally (wrangler dev) and in the test pool. The Drizzle meta snapshot was not regenerated (the table is not in `db/schema.ts`).

## API changes

| Method | Path | Auth | Permission | Request | Response | Audit |
|---|---|---|---|---|---|---|
| POST | `/api/auth/email-otp/send-verification-otp` | — | — | `{email, type:"sign-in"}` (+ honeypot header must be empty) | `200 {success:true}` always; 400 invalid/honeypot; 429 | `AUTH_OTP_SENT {messageId}` / `{errorCode}` (+`echoed` in dev) |
| POST | `/api/auth/sign-in/email-otp` | — | — | `{email, otp}` | `200 {token,user}` + `Set-Cookie`; 400 `INVALID_OTP`/`OTP_EXPIRED`; 403 `TOO_MANY_ATTEMPTS`; 429 | `AUTH_LOGIN_SUCCEEDED` / `AUTH_LOGIN_FAILED {reason}`; bootstrap `STAFF_ROLE_GRANTED` |
| GET | `/api/v1/auth/session` | session | — | — | `SessionResponse` (`activeTenantId: null` until WT-2) | — |
| POST | `/api/v1/auth/logout` (and `/api/auth/sign-out`) | session | — | — | `204` + cookie cleared | `AUTH_LOGOUT` |
| GET | `/api/v1/staff` | session | `staff.manage` | — | `{items: StaffMember[]}` | — |
| POST | `/api/v1/staff` | session | `staff.manage` | `CreateStaffRequest` | `201` new / `200` changed or unchanged `StaffMember`; 409 `last_super_admin` | `STAFF_ROLE_GRANTED {before, after}` |
| DELETE | `/api/v1/staff/:userId` | session | `staff.manage` | — | `204`; 404; 409 `cannot_revoke_self` / `last_super_admin` | `STAFF_ROLE_REVOKED` |

Other Better Auth endpoints under `/api/auth/*` (e.g. `get-session`, `update-user`) answer as the library defines; email+password is disabled, and the OTP send hook refuses every type but `sign-in`.

---

## How WT-2/3/5 use the middleware

```ts
import { requireStaff, requireUser, getPrincipal } from "../../auth/middleware";
import { requirePermission, requireTenantStanding, getTenantStanding } from "../../authz/permissions";

tenants.get("/", requirePermission("tenant.view"), handler);              // staff grant (a row)
memberships.post("/", requireTenantStanding("admin"), handler);           // :tenantId from the mount path
```

- Attach per route (mount prefixes nest; never `use("*")`). Every guard sets `c.var.user` = `{id, email, name, staffRole}`.
- Errors: 401 `{error:"unauthenticated"}`, 403 `{error:"forbidden"}`.
- Cost: 2 D1 round trips per request (session+user join, one grants query), cached for that request only; `getPrincipal(c)` reuses them (`{user, sessionId, permissions: Set}`). Nothing is cached across requests, so revoking a session, a staff row or a `role_permissions` row takes effect on the next request. Add `AUTH_ROUND_TRIPS` to loader ceilings the way `test/screens.test.ts` does.
- `requireTenantStanding(min)` reads only `c.req.param("tenantId")`, only `status='active'` memberships, owner > admin > user, one indexed query per tenant per request (`getTenantStanding` for the handler). It does **not** let staff through: a route that both staff and tenant members may call needs its own `guard((p, c) => p.permissions.has("tenant.view") || …)` (export `guard` from `auth/middleware.ts`).
- Cookie-authenticated POST/PATCH/DELETE with a foreign `Origin` (or `Sec-Fetch-Site: cross-site`) is refused with 403 before any handler. Requests without `Origin` (tests, server-to-server) pass.
- Tests: `const s = await signInAs(env, {email, staffRole?})` then `app.request(path, {method, headers: {...s.headers, "content-type": "application/json"}, body}, env)`. `s.headers` carries the cookie and a same-origin `Origin`. The session is created by Better Auth's `testUtils` plugin on a test-only instance built from the runtime `authOptions` (same secret, adapter, cookie name), not hand-minted. WT-6's `fixtures.ts` `signInAs(userId)` contract can wrap this.
- Agent routes (`/agent/*`, WT-3) use device credentials, not these guards.

## Security assumptions

- Better Auth 1.7.6 owns sessions, cookies and OTP storage; no custom crypto. OTPs: 6 digits, 5 min, single use (atomic consume), 3 attempts then burned, stored hashed, a resend rotates (only the newest code verifies).
- Cookies are Better Auth defaults: host-only (no `Domain`), httpOnly, SameSite=Lax, `Secure` + `__Secure-` prefix on https. Session 7 days, refreshed daily (defaults).
- Rate limits: per IP (`cf-connecting-ip`) in D1: OTP send 3/60 s, sign-in 3/10 s, rest of `/api/auth` 60/min; per email: 5 sends / 15 min, counted from `AUTH_OTP_SENT` audit rows.
- Anti-enumeration: sign-up on first verify is enabled, so every address gets the same 200 and a code; send failures never change the response (recorded in audit instead). `AUTH_LOGIN_FAILED` records the reason code, never the submitted code.
- Honeypot: the login form sends its hidden field as `x-cloudbox-hp`; any value → plain 400 `{error:"invalid_request"}` before Better Auth runs.
- `trustedOrigins`: `https://box.affinityminds.in`, `http://localhost:5173`, plus the request's own origin (Better Auth, via explicit `baseURL` = request origin).
- `OTP_DEV_ECHO=1` logs the code only when `ENVIRONMENT !== "production"`; with `ENVIRONMENT=production` and `OTP_DEV_ECHO=1`, `createAuth` throws (auth fails closed).
- Bootstrap: the first verified sign-in of `BOOTSTRAP_SUPER_ADMIN_EMAIL` while no `super_admin` row exists inserts one in a single `INSERT … WHERE NOT EXISTS` statement (race-safe) and audits `STAFF_ROLE_GRANTED`, actor `system/bootstrap`.
- The admin-web route guard only routes the browser; the server authorises every call.

## Deploy needs (all already handled by `deploy-cloudflare.yml` as merged)

- Secret `BETTER_AUTH_SECRET` (created once by the workflow).
- Vars `ENVIRONMENT=production`, `BOOTSTRAP_SUPER_ADMIN_EMAIL` (repo variable, = soren@affinityminds.net), `EMAIL_FROM=no-reply@em.affinity.ai.in`. `OTP_DEV_ECHO` must be absent.
- Binding `EMAIL` (`send_email`); the sender domain `em.affinity.ai.in` must be onboarded to Cloudflare Email Service or sends fail with `E_SENDER_NOT_VERIFIED` (visible as `AUTH_OTP_SENT {errorCode}` in the audit log; the API still answers 200).
- Migration `0004` applied by `wrangler d1 migrations apply --remote` (already in the workflow).
- Local: `apps/worker-api/.dev.vars` (gitignored) with `BETTER_AUTH_SECRET=<openssl rand -base64 32>`, `OTP_DEV_ECHO=1`, `BOOTSTRAP_SUPER_ADMIN_EMAIL=<you>`.

---

## Tests run and results

Worker (`@cloudflare/vitest-pool-workers`, real D1): **51 passed / 51** in 6 files
- `auth-otp.test.ts` (16): send → verify → session → logout with a stubbed mailer; identical response for known/unknown email; mail failure still 200 with `errorCode` audited; invalid, reused, expired codes; resend supersedes; 3 wrong attempts burn the code; per-IP send limit (D1 `rate_limit` rows); per-email send limit across IPs; per-IP verify limit; honeypot 400; only sign-in codes; bootstrap grant once and audited; no bootstrap once a super admin exists; production never echoes and `createAuth` refuses `OTP_DEV_ECHO` in production.
- `authz.test.ts` (12): 401 without / with forged session; session body with row-derived permissions; non-staff session; logout revokes (same cookie → 401) and is audited; `/api/auth/sign-out` routed to audited logout; cross-site write refused; 401/403/200 matrix; admin denied `staff.manage` by seed; **super admin denied after deleting its `role_permissions` row** (probe route and the real `/screens/audit`); revoked staff row effective next request; tenant standing from the path (cross-tenant 403 even with a body `tenantId`, revoked membership 403, owner/admin ranks).
- `staff.test.ts` (8): 401/403 gates; list; grant to a never-signed-in email then first sign-in through the real OTP flow carries the role; role change audited with before/after and idempotent; revoke audited and effective next request, then 404; self-revoke and last-super-admin demotion 409; body validation 400; cross-site grant 403.
- `screens.test.ts` (5): both screens 401/403 then 200 for a signed-in `read_only` staff; loader round trips ≤ 3 (+2 auth) and 1 (+2 auth).
- `foundation.test.ts` (7), `migrations.test.ts` (3): unchanged apart from dropping the auth/staff stub expectations.

admin-web (vitest 5): **3 passed / 3** (`safeRedirect` refuses `//host`, absolute URLs and `/login`; auth error text mapping).

Verify: in a worktree under `.claude/worktrees/`, `biome check .` processes 0 files (see `docs/ISSUE_LOG.md`), so I ran the same four stages with an explicit biome path list:

```
biome check apps packages biome.json package.json tsconfig.base.json → Checked 96 files, no fixes
pnpm typecheck → ok
pnpm test      → admin-web 3/3, worker-api 51/51
pnpm build     → vite ✓ built; wrangler deploy --dry-run ok
```

## Demo path

Verified locally with `wrangler dev` (port 8788) + local D1 (migrations 0001–0004) + Playwright; screenshots in `docs/evidence/wt-p1-auth/`:

```
1. Open /            → redirected to /login?redirect=%2F                          (01-login-email.png)
2. Enter soren@affinityminds.net → "Send code"                                   (02-login-code.png)
3. Code arrives by email (production) or as "[otp-dev-echo] <email> <code>" in wrangler dev / wrangler tail
4. Wrong code → "That code is not right" and the boxes clear                    (03-login-code-invalid.png)
5. Paste the code into the first box → auto-submit → overview                   (04-signed-in-overview.png)
6. Sidebar user menu shows the email and "Super Admin", with Sign out           (05-user-menu.png)
7. GET /api/v1/staff → 200 {"items":[{"email":"soren@affinityminds.net","role":"super_admin","createdBy":"system",…}]}
8. Sign out → /login; GET /api/v1/auth/session → 401 {"error":"unauthenticated"}  (06-after-logout.png)
```

Also `07-login-code-mobile.png` (390 px) and `otp-email.txt` (the email body as rendered by the local `send_email` binding, code redacted). Audit rows written during the run: `AUTH_OTP_SENT`, `AUTH_LOGIN_FAILED`, `AUTH_LOGIN_SUCCEEDED`, `STAFF_ROLE_GRANTED` (actor system), `AUTH_LOGOUT`.

Not yet verified live on `box.affinityminds.in` (needs the merge + deploy and the Email Service sender domain).

## Known failures

- [ ] No staff management screen: the API is complete but `nav.ts` (WT-0) has no Staff entry, so no UI was added (see requests).
- [ ] Live email delivery unverified until `em.affinity.ai.in` is confirmed onboarded in Cloudflare Email Service.

## Decisions needed

- [ ] **Open sign-up.** Any address that verifies a code gets a `user` row (no staff row, no membership → 403 everywhere). This keeps anti-enumeration trivially uniform and lets WT-2 invite by email. Alternative: `disableSignUp: true` plus pre-created users (bootstrap email and invitations), at the cost of a second code path for "unknown email" that must stay indistinguishable. Current choice: open sign-up.
- [ ] **Non-staff users in the console.** The route guard lets any signed-in user into `/_app` (they see 403 panels). Decide whether tenant members get a separate portal or a "no staff access" page (WT-2 scope).

## Requests to another worktree

- [ ] WT-0: move `rateLimit` from `apps/worker-api/src/auth/rate-limit-table.ts` into `db/schema.ts` verbatim and regenerate the Drizzle snapshot (the `auth generate` output for `rateLimit.storage="database"` includes it).
- [ ] WT-0: add a `staff` nav entry (Govern → "Staff", `/staff`, gated in the UI by `staff.manage` from `/api/v1/auth/session`); WT-1 (or whoever follows) adds the table screen on the existing API.
- [ ] WT-0: the sidebar header hardcodes "Super Admin" under the product name; show the session role or drop it (the user menu now shows the real role).
- [ ] WT-0: fix `biome.json` so `pnpm check` works inside `.claude/worktrees/*` (e.g. make the `.claude` exclusion root-relative).
- [ ] WT-2: fill `activeTenantId` in `GET /api/v1/auth/session` (`src/routes/v1/auth.ts`, one line) when `/me/active-tenant` lands.
- [ ] WT-6: wrap `test/auth-fixtures.ts` `signInAs` into the `fixtures.ts` contract (`signInAs(userId) → {Cookie}`) if you keep that shape.

## Safe next action

Merge PR #6 (Phase B) into `phase-1/identity`; WT-2/3/5 already build on the Phase A middleware, and nothing in Phase B changes those signatures.
