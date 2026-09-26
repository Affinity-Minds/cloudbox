# Handoff — WT-1 `wt/p1-auth` (identity: customers and staff, authorisation)

## Mission

**Slices:** 1.1 authentication, 1.2 staff authorisation, plus the owner's decisions of 2026-09-27:
- closed sign-in
- staff password + authenticator (ADR 0009)
- separate, discreet staff surface
- **two identity systems with nothing shared** (ADR 0002)
- WT-8 security reviews: passes 1–4 (`docs/reviews/phase-1-security.md`)

**Done means:**
- Customers sign in at `/login` with an emailed code.
- Staff sign in under the discreet `OPS_BASE_PATH` with password and authenticator, and are forced through setup at first sign-in.
- The two systems share no table, secret, cookie or endpoint.
- Every protected route is authorised server-side from its own system's rows, per request.
- Every auth state change is audited.

## Current status

- Branch `wt/p1-auth` (parent `phase-1/identity`). Earlier rounds merged as PR #4, #6, #9, #10, #14.
- This round: draft PR "WT-1: separate customer and discreet staff sign-in surfaces" (see report).
- It includes `origin/wt/p1-tenants` (WT-2, U-2) and `origin/review/phase-1-security` (fourth pass).
- `pnpm run verify`: green. `python3 scripts/check-workflows.py`: ok.

## URLs the owner uses

| Who | URL |
|---|---|
| Customers | `https://box.affinityminds.in/login` → `/portal` |
| Staff | `https://box.affinityminds.in/ops/login` → console at `https://box.affinityminds.in/ops` |

Staff: until `OPS_BASE_PATH` is changed to a random slug, the console stays at `/ops`. Nothing on the customer surface links to it.

## Two identity systems (ADR 0002)

| | Customers | Staff |
|---|---|---|
| Mount | `/api/auth/*`: `email-otp/send-verification-otp`, `sign-in/email-otp`, `get-session`, `sign-out` | `/api/ops/auth/*`: `sign-in/email`, `two-factor/{verify-totp,verify-backup-code,enable,generate-backup-codes,disable}`, `change-password`, `get-session`, `sign-out` |
| Instance | `createCustomerAuth(env)`, plugin `emailOTP` only | `createStaffAuth(env)` (= `createAuth`), `emailAndPassword` + `twoFactor` only |
| Tables | `customer_users`, `customer_sessions`, `customer_accounts`, `customer_verifications`, `customer_rate_limit` | `staff_users`, `staff_sessions`, `staff_accounts`, `staff_verifications`, `staff_two_factor`, `staff_rate_limit` |
| Cookie | `cbx_session` | `cbx_ops_session` |
| Secret | `CUSTOMER_AUTH_SECRET` | `STAFF_AUTH_SECRET` |
| Referenced by | `tenant_memberships.user_id` | `staff_members.user_id` |
| Create identities | `ensureCustomerByEmail(env, email)` (memberships) | `ensureStaffUserByEmail` (POST /staff, bootstrap) |

**Guards** (`src/auth/middleware.ts`, `src/authz/permissions.ts`):
- `requireStaff()` and `requirePermission(key)` read only the staff cookie and staff tables.
- `requireUser()` and `requireTenantStanding(min)` read only the customer cookie and customer tables.
- `requireSession()` and `guard(check)` (either system, each evaluated on its own) are for session, logout and routes open to staff *or* tenant members (WT-2 memberships, WT-3 enrollment and fleet).
- A customer cookie on a staff route gets 401. A staff cookie on a customer route (e.g. `/api/v1/me`) gets 401. Both are asserted in `permission-matrix.test.ts`.
- `GET /api/v1/auth/session?as=staff|customer` and `POST /api/v1/auth/logout?as=…` are pinned to one system.

## Discreet staff surface

**Configuration:** `OPS_BASE_PATH` is a Worker var, one segment. It defaults to `/ops`; the owner may set a long random slug (`wrangler.jsonc` var, no rebuild).

**How the Worker serves the SPA** (`run_worker_first: true`, `src/ops-shell.ts`):
- Only at known console routes under the base, the document gets:
  - the marker `<meta name="cloudbox-ops-base">`
  - `<meta name="robots" content="noindex">`
  - `X-Robots-Tag: noindex, nofollow` and `no-store`
- Every other path, including unknown ones under the base, gets the byte-identical ordinary SPA document.
- There is no robots.txt entry. `/api/ops/*` responses carry `X-Robots-Tag`.

**How the SPA picks a router:**
- With the marker: the staff router (file routes, `basepath = OPS_BASE_PATH`) mounts: login, setup, and the console.
- Without it: the customer router (`src/portal/router.tsx`: `/login`, `/portal`, `/` → `/portal`) mounts.
- The `/api/version` build-stamp poll is unchanged.

## Limits and step-up (unchanged in substance, now per system)

A client is an IPv4 address or an IPv6 /48 (`ipv6Subnet: 48`).

**Customers** (`/api/auth`):
- **Per IP (Better Auth):** 3 sends / 60 s, 3 code sign-ins / 60 s.
- **Per (email, client):** 5 sends / 15 min, and 10 failed checks / h.
- **Code attempts:** 5 per code, spendable only by clients that requested it (T-2).
- **Per-address budget:** 30 failed checks / h across all clients. Above it a Turnstile token is required (403 `challenge_required`). **Without `TURNSTILE_SECRET_KEY`, the fallback is a 15-minute per-account cooldown (`AUTH_ACCOUNT_COOLDOWN`). This is the only per-account denial in the system, until Turnstile is configured.**
- Addresses are NFKC-normalised and lower-cased before validation. An unparseable one is refused with 400 at the gate (U-1).

**Staff** (`/api/ops/auth`), no Turnstile:
- **Per IP (Better Auth):** password sign-in 3 / 10 s, `/two-factor/*` 3 / 10 s.
- **Password lockout:** 5 failures per (email, client) in 15 min → 429 with the wrong-password body. No per-account lock (S-1).
- **Authenticator:** Better Auth's challenge limit (5) and account lockout (10 failures → 15 min). An accepted sign-in or disable code cannot be replayed for 120 s (S-3). Trusted devices are off (S-4).

Counters live in each system's rate-limit table under SHA-256 keys (`src/auth/counters.ts`); the table is chosen from the counter kind.

## Migrations

- `0003` and `0004` were rewritten in place (production has only 0001/0002; confirmed with `git log origin/main -- infra/cloudflare/migrations`).
  - `0003`: the identity tables of both systems, and `staff_members`/`tenant_memberships` foreign keys to them.
  - `0004`: `staff_two_factor`, `staff_rate_limit`, `customer_rate_limit`.
- The Drizzle snapshot (`meta/0000_snapshot.json`) was regenerated; `pnpm db:generate` reports no changes.
- `0008` (WT-12) is untouched.
- **Every existing local/test D1 must be recreated.**

## Deploy needs

- **Secrets** (the workflow syncs each once):
  - `STAFF_AUTH_SECRET`, `CUSTOMER_AUTH_SECRET`
  - `BOOTSTRAP_SUPER_ADMIN_PASSWORD` (GitHub environment secret, ≥ 12 chars)
  - `TURNSTILE_SECRET_KEY` (WT-0 step)
- **Retired:** `BETTER_AUTH_SECRET` (a workflow step deletes it).
- **Vars:** `ENVIRONMENT=production`, `BOOTSTRAP_SUPER_ADMIN_EMAIL`, `EMAIL_FROM`, `TURNSTILE_SITE_KEY`, `OPS_BASE_PATH` (`/ops` by default). `OTP_DEV_ECHO` must be absent.
- `wrangler.jsonc`: `assets.run_worker_first: true` (the Worker serves the SPA through `ops-shell.ts`).
- **After the first deploy:** sign in as the owner at `/ops/login` (forced password change and authenticator), then delete the `BOOTSTRAP_SUPER_ADMIN_PASSWORD` Worker secret.
- **Local:** `apps/worker-api/.dev.vars.example` lists every key.

### Ops recommendations (edge; the Worker's limits stay authoritative)

1. **WAF rate-limiting rule on the auth endpoints**
   - Paths: `box.affinityminds.in/api/auth/sign-in/*`, `/api/auth/email-otp/*`, `/api/ops/auth/*`.
   - Counting characteristic: IP, with IPv6 grouped by /48.
   - For example 30 requests per 10 min, then block for 10 min.
2. **WAF custom rule for the staff surface**
   - Paths: `${OPS_BASE_PATH}` and `${OPS_BASE_PATH}/*`, and `/api/ops/*`.
   - Either an **IP / country allowlist** (managed challenge or block for everything else), or at least a managed challenge on first visit.
   - Pre-clearance must stay **off** (agent-notes cloudflare-workers trap 1).
3. **Turnstile widget** for `box.affinityminds.in` only, managed mode, pre-clearance off.

## Tests (worker-api 469/469, admin-web 5/5, licensing-contracts 16/16)

- **`permission-matrix.test.ts`, "two identity systems never cross":**
  - a staff cookie on `/api/v1/me` gets 401
  - a customer cookie on `/api/v1/screens/tenants`, `POST /api/v1/tenants`, `/api/v1/staff` and `/api/v1/screens/audit` gets 401
  - neither mount exposes the other's endpoints (404)
  - a staff email on the customer mount mints nothing and creates no customer identity
- **`authz.test.ts`:**
  - each guard reads only its own session
  - with both cookies present, each route uses only its own
- **`ops-shell.test.ts`:**
  - only known console routes under the base are marked and noindex
  - unknown paths under the base are byte-identical to any other path
  - `OPS_BASE_PATH` is honoured, and a malformed value falls back to the default
  - `/api/ops/*` responses are noindex, with the ordinary 404
- **Carried over and updated for the split:** `staff-auth`, `bootstrap`, `auth-otp`, `auth-stepup`, `staff`, `screens`.
- **WT-2/3/5/6 suites:** 401 instead of 403 for a customer session on staff routes (owner decision).
- **Every WT-8 review test is green**, passes 1–4, including U-1 and U-2.
- **Review test edits:** some review tests were edited only where the owner's decisions moved what they address, never what they assert. The list is at the top of the review doc's fourth pass.
- **admin-web:** `withBase`, `safeRedirect`, step-up error mapping.
- **e2e smoke** (`tests/e2e-cloud`):
  - `/` → customer email step, with no password field and no link to the ops base
  - `${OPS_BASE_PATH}/login` → staff form with `X-Robots-Tag`
  - an optional customer OTP → portal run

## Demo path (local wrangler dev + fresh local D1 + Playwright; `docs/evidence/wt-p1-auth/`)

```
01 /login: customer email step (no password field, no links)   02 code step   03 /portal
04 /ops/login: staff email + password (X-Robots-Tag: noindex)
05 /ops/setup-password   06 /ops/setup-authenticator QR   07 backup codes (shown once)
08 console under /ops with the user menu (Super Admin)
09 second sign-in: authenticator step (next time step; the enrolment code is not replayed)
10 /ops/zzz: the same "Page not found" as any unknown path
```

## Decisions / deviations

- **Review tests edited** to follow the owner's decisions (paths, table names, customer-only routes); every assertion is unchanged. See the note in the review doc.
- **Staff email on the customer surface:** with two systems, the customer surface no longer consults staff tables. A person who is both staff and a tenant member has a separate customer identity (created by a membership), and receives codes for it.
- **Bootstrap** runs only on the staff mount (`/api/ops/auth/*`), and only into `staff_users`.
- `ensureUserByEmail` remains as a deprecated alias of `ensureCustomerByEmail` (review tests import it).
- **U-2** is WT-2's fix (ranking + last-owner guard), merged and adapted to `customer_users`.
- **Files outside WT-1's area, edited under the owner's decisions or WT-0's leave:**
  - `db/schema.ts`, migrations `0003`/`0004` and their snapshot
  - `wrangler.jsonc`: `OPS_BASE_PATH`, `run_worker_first`
  - the deploy workflow's secret steps, `.dev.vars.example`
  - WT-2's `memberships.ts` and `screens/tenants.ts`
  - WT-6's `fixtures.ts` (`seedStaff` → `staff_users`)
  - `test/*` expectations for 401
  - the e2e smoke test

## Requests to other worktrees

- [ ] WT-0: set the WAF rules above; set `OPS_BASE_PATH` to a random slug when the owner wants it.
- [ ] WT-2: new customer identities only via `ensureCustomerByEmail`; tenant-member UI stays on the customer surface (`/portal`), never under the ops base.
- [ ] WT-3/WT-5: staff screens only under the ops console; customer-facing views, if any, on the customer surface.
- [ ] WT-6: `signInAs(env, {email, staffRole?})` returns a staff-system session when `staffRole` is given, else a customer-system session; `seedStaff` writes `staff_users`.

## Safe next action

Merge the PR into `phase-1/identity` and deploy. Then sign in at `/ops/login` as the owner, complete the forced setup, and delete the `BOOTSTRAP_SUPER_ADMIN_PASSWORD` Worker secret.
