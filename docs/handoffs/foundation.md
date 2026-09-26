# Foundation contract — Phase 1–3 (owner: WT-0)

Fixed names. Fan-out worktrees build against these and never guess. Changes go through WT-0 only.

## Branches and merge order
`main` ← `phase-1/identity` (integration). Worktrees `wt/p1-auth` (WT-1), `wt/p1-tenants` (WT-2), `wt/p2-enrollment` (WT-3), `wt/p2-agent` (WT-4), `wt/p3-entitlement` (WT-5), `wt/p1-qa` (WT-6), `wt/p1-docs` (WT-7) branch from the `phase-1/identity` foundation commit. Reserved migration numbers: `0003` foundation (WT-0), `0004` WT-1, `0005` WT-2, `0006` WT-3, `0007` WT-5. Use a reserved number only for a genuine need and say so in your handoff.

## Stack (installed by the foundation commit; do not add dependencies yourself)
worker-api: `hono`, `@hono/zod-validator`, `zod`, `drizzle-orm`, `better-auth`, `jose`; dev `drizzle-kit`, `@cloudflare/vitest-pool-workers`, `vitest`, `wrangler`.
admin-web: React 19 + Vite, `tailwindcss` v4 (`@tailwindcss/vite`), shadcn/ui (`src/components/ui/*`, blocks `sidebar-07`, `data-table`), `@tanstack/react-router` (file-based via `@tanstack/router-plugin`), `@tanstack/react-query`, `@tanstack/react-table`, `react-hook-form` + `@hookform/resolvers`, `input-otp`, `lucide-react`, `date-fns`, `sonner`.
packages/contracts: zod schemas shared by API and UI. Import as `@cloudbox/contracts`.

## Bindings, vars, secrets (`apps/worker-api/wrangler.jsonc`)
Bindings: `DB` (D1 `cloudbox-db`), `ARTIFACTS` (R2 `cloudbox-artifacts`), `FLEET_PRESENCE` (DO), `ASSETS`, `EMAIL` (`send_email`). Vars: `BUILD_SHA`, `BUILD_TIME`, `ENVIRONMENT` (`development|production`), `EMAIL_FROM` (`no-reply@em.affinity.ai.in`), `BOOTSTRAP_SUPER_ADMIN_EMAIL`, `OTP_DEV_ECHO` (`"1"` only outside production). Secrets (Wrangler, set by the deploy workflow, never in repo): `BETTER_AUTH_SECRET`, `ENTITLEMENT_SIGNING_JWK`, `PHASE0_ADMIN_KEY`. Type them all in `Bindings` in `src/env.ts`.

## Database (migration `0003_identity_tenancy_devices.sql`, Drizzle schema `src/db/schema.ts`)
Timestamps are ISO-8601 UTC text. Ids are prefixed ULIDs/UUIDs: `ten_`, `dev_`, `sub_`, `lic_`, `tok_`, `mem_`, `cred_`.
- Better Auth (generated, default names): `user`, `session`, `account`, `verification`.
- `staff_members(user_id PK → user.id, role CHECK('super_admin','admin','support','read_only'), created_by, created_at)`
- `permissions(key PK, description)`; `role_permissions(role, permission_key → permissions.key, PK(role, permission_key))`. Seeded catalogue: `tenant.view tenant.manage subscription.view subscription.manage device.view device.manage device.command device.break_glass license.issue license.renew license.revoke network.view network.manage backup.view backup.restore update.view update.release update.deploy audit.view staff.manage settings.manage`. Seed: super_admin = every key; admin = all except `staff.manage`, `device.break_glass`, `license.revoke`; support = every `*.view` + `device.command`; read_only = every `*.view`.
- `tenants(id, public_code UNIQUE, display_name, legal_name, status CHECK('trial','provisioning','active','past_due','suspended','cancelled','archived'), primary_contact_email, support_contact_email, billing_contact_email, timezone, maintenance_window_json, renewal_warning_days INT DEFAULT 30, backup_policy_json, plan_code, notes, created_at, updated_at, archived_at)`. `public_code` format `CBX-00001`, from counter row `settings.key='tenants.next_code'`.
- `tenant_memberships(id, tenant_id → tenants.id, user_id → user.id, standing CHECK('owner','admin','user'), status CHECK('active','revoked') DEFAULT 'active', invited_by, created_at, UNIQUE(tenant_id, user_id))`
- `enrollment_tokens(id, tenant_id, token_hash UNIQUE, label, created_by, expires_at, redeemed_at, redeemed_device_id, revoked_at, created_at)`
- `devices(id, tenant_id, name, status CHECK('enrolled','revoked','transferred'), device_public_key_jwk, device_key_thumbprint UNIQUE, key_protection CHECK('tpm','software'), hostname, windows_build, agent_version, last_seen_at, last_health_json, enrolled_at, revoked_at)`; index `(tenant_id, status)`.
- `device_credentials(id, device_id, token_hash UNIQUE, created_at, revoked_at)`
- `plans(code PK, name, max_devices INT, max_managed_users INT, features_json, offline_grace_days INT, renewal_warning_days INT)`; seed `cloudbox-6` (1 device, 6 users, features `["remote_access","managed_backup","fleet"]`, grace 7, warning 30).
- `subscriptions(id, tenant_id, plan_code → plans.code, status CHECK('trial','active','past_due','suspended','cancelled'), valid_from, valid_until, max_managed_users, features_json, offline_grace_days, renewal_warning_days, created_at, updated_at)`; index `(tenant_id, status)`.
- `entitlements(id, subscription_id, device_id, generation INT, claims_json, token, issued_by, issued_at, valid_until, revoked_at, UNIQUE(device_id, generation))`
- `signing_keys(kid PK, alg, public_jwk, status CHECK('active','retired'), created_at)`
- `audit_log` + columns `actor_tenant_id`, `correlation_id`, `source`. `actor_type` ∈ `user|device|system|bootstrap-admin`.
Every tenant-scoped query filters by `tenant_id` and has an index. No N+1.

## Server layout (`apps/worker-api/src`)
- `env.ts` (Bindings type), `db/schema.ts` (WT-0 only), `db/client.ts` (`drizzle(env.DB, {schema})`), `audit.ts` → `audit(db, {eventType, entityType, entityId, actor:{type,id,tenantId?}, before, after, correlationId?, source?})`.
- `auth/index.ts` `createAuth(env)` (WT-1), `auth/middleware.ts` `requireUser()`, `requireStaff()` (WT-1).
- `authz/permissions.ts`: `PERMISSIONS` const (catalogue above), `requirePermission(key)`, `requireTenantStanding(min: 'owner'|'admin'|'user')` (WT-0 signatures throwing 501; WT-1 implements). Tenant id comes from the path param `:tenantId`, resolved server-side every request.
- `email/index.ts` `sendOtpEmail(env, {to, code})` (WT-1).
- `routes/v1/index.ts` mounts, one line each: `auth, staff, tenants, memberships, me, enrollment, devices, agent, subscriptions, entitlements, screens, audit`. Each module file exports a `Hono<{Bindings, Variables}>`. Stubs return `{module, status:'stub'}` until the owner fills them.
- `screens/*.ts`: one loader per screen, ≤3 D1 round trips via `db.batch`.
- Error shape: `{ error: 'unauthenticated' | 'forbidden' | 'not_found' | 'invalid_request' | 'conflict' | <snake_case> , detail? }` with matching status. All `/api/v1/*` responses carry `X-API-Version: v1`.
- Request variables: `c.var.user` (Better Auth user + staff role), `c.var.device` (for `/agent/*`), `c.var.correlationId`.

## HTTP routes (all `/api/v1/...`; owner in brackets)
- `POST /auth/*` Better Auth handler mounted at `/api/auth/*` [WT-1]; `GET /auth/session`, `POST /auth/logout` [WT-1]; `GET/POST/DELETE /staff` [WT-1]
- `GET /screens/tenants`, `GET /screens/tenants/:tenantId`, `POST /tenants`, `PATCH /tenants/:tenantId`, `POST /tenants/:tenantId/archive`, `POST/PATCH/DELETE /tenants/:tenantId/memberships[/:id]`, `GET /me/tenants`, `POST /me/active-tenant` [WT-2]
- `POST/GET/DELETE /tenants/:tenantId/enrollment-tokens[/:id]`, `POST /agent/enroll`, `POST /agent/heartbeat`, `GET /agent/entitlement`, `POST /agent/uninstalled`, `GET /screens/fleet`, `GET /screens/fleet/:deviceId`, `POST /devices/:deviceId/revoke` [WT-3]
- `GET /plans`, `POST /tenants/:tenantId/subscriptions`, `PATCH /subscriptions/:id`, `POST /devices/:deviceId/entitlements/issue|renew|revoke`, `GET /screens/subscriptions[/:id]` [WT-5]
- `GET /screens/overview`, `GET /screens/audit` [WT-0]

## Agent API contract (WT-3 server, WT-4 client) — unchanged from PLAN_5AM.md §7
`POST /agent/enroll {token, device:{hostname, windowsBuild, agentVersion, keyProtection:'tpm'|'software', publicKeyJwk:{kty:'RSA', n, e}}}` → 201 `{deviceId, tenantId, tenantCode, deviceName, deviceToken}`; 400 invalid/expired/used token (same message), 409 key already enrolled. `POST /agent/heartbeat` Bearer deviceToken `{health: AgentHealth}` → `{serverTime, entitlementGeneration: number|null, commands: []}`. `GET /agent/entitlement` → `{entitlement: <compact JWE>, generation}` or 404. `POST /agent/uninstalled` → 204. Schemas in `packages/contracts/src/agent.ts` (`EnrollRequest`, `EnrollResponse`, `AgentHealth`, `HeartbeatResponse`).

## admin-web layout (`apps/admin-web/src`)
`main.tsx` (router + QueryClient providers), `routes/__root.tsx`, `routes/login.tsx` [WT-1], `routes/_app.tsx` (auth guard `beforeLoad` [WT-1], sidebar-07 shell from `nav.ts` [WT-0]), `routes/_app/index.tsx` overview [WT-0], `routes/_app/tenants.tsx` + `tenants.$tenantId.tsx` [WT-2], `routes/_app/fleet.tsx` + `fleet.$deviceId.tsx` + `enrollment.tsx` [WT-3], `routes/_app/subscriptions.tsx` + `subscriptions.$id.tsx` [WT-5], `routes/_app/audit.tsx`, `settings.tsx` [WT-0]. `nav.ts` keys: `overview, tenants, fleet, enrollment, subscriptions, audit, settings`. `api/client.ts` (`api<T>(path, init)` with `credentials:'include'`, throws `ApiError{status, error}`), `api/<module>.ts` per owner. Build stamp from `/api/version` in the sidebar footer. Page type: operational console.

## Tests
Worker: vitest with `@cloudflare/vitest-pool-workers` (WT-6 finalises; foundation ships a working config with migrations applied from `infra/cloudflare/migrations`). Fixtures contract (`apps/worker-api/test/fixtures.ts`, WT-6 implements, others consume): `seedStaff(db, {email, role})`, `seedTenant(db, {...})`, `seedMembership(db, {tenantId, userId, standing})`, `seedDevice(db, {tenantId})`, `signInAs(userId) → {Cookie}` (creates a Better Auth session through the library), `countingD1(env.DB)`. Until WT-6 lands, write tests against these names and mark them `test.todo` if the fixture is missing.

## Shared-file rules
Only WT-0 edits: `db/schema.ts`, migration `0003`, `routes/v1/index.ts` (others add exactly one line), `nav.ts`, `package.json` files, `pnpm-lock.yaml`, workflows, `wrangler.jsonc`, `docs/BUILD_STATE.md`, this file. Never `git stash`.
