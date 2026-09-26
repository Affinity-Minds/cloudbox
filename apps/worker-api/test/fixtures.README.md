# `test/fixtures.ts` — shared seed helpers

Owner: WT-6. Every worktree's tests should consume these instead of inventing their own insert
statements, so a schema change (owner WT-0) only breaks one file.

All helpers take the raw `D1Database` binding — usually `env.DB` from `cloudflare:test`, or a
`countingD1(env.DB)` wrapper when the test also asserts a round-trip ceiling — and insert
through the Drizzle schema in `src/db/schema.ts`, so the columns they write can never drift from
what a migration actually creates. Each helper returns the row it inserted, camelCase, so a test
never has to re-query for the id it just created.

Import from `./fixtures` (this file lives at `apps/worker-api/test/fixtures.ts`):

```ts
import { env } from "cloudflare:test";
import { seedDevice, seedMembership, seedStaff, seedSubscription, seedTenant } from "./fixtures";

const staff = await seedStaff(env.DB, { email: "admin@example.com", role: "admin" });
const tenant = await seedTenant(env.DB, { displayName: "Acme" }); // status defaults to "active"
const membership = await seedMembership(env.DB, {
  tenantId: tenant.tenantId,
  userId: staff.userId,
  standing: "owner",
});
const device = await seedDevice(env.DB, { tenantId: tenant.tenantId });
const subscription = await seedSubscription(env.DB, { tenantId: tenant.tenantId }); // plan cloudbox-6 by default
```

## `seedStaff(db, { email, role, name?, createdBy? })`

Inserts the Better Auth `user` row (id, name, email only — Better Auth's own timestamp and
`email_verified` columns take their SQL defaults) plus the matching `staff_members` row. `role`
is one of the four staff roles (`super_admin`, `admin`, `support`, `read_only`); role→permission
grants come from `role_permissions`, seeded by migration 0003 — this helper does not touch that
table. Returns `{ userId, email, name, role, createdAt }`.

Better Auth generates its own (unprefixed) user ids at runtime, so this helper does too — do not
expect a `usr_`-style prefix.

## `seedTenant(db, { displayName?, status?, planCode?, publicCode? })`

Inserts a `tenants` row. `status` defaults to `"active"` (not the schema's own `"provisioning"`
default) because most tests want a usable tenant; pass `status: "provisioning"` explicitly for
lifecycle tests. `publicCode` defaults to a unique `CBX-######` value that matches the
`TenantPublicCode` shape but is **not** drawn from the real `settings.tenants.next_code` counter
— that allocation is the tenants API's job (WT-2), not a fixture's. Returns
`{ tenantId, publicCode, displayName, status, planCode, createdAt, updatedAt }`.

## `seedMembership(db, { tenantId, userId, standing, invitedBy? })`

Inserts a `tenant_memberships` row (`status` always `"active"` — revoke it yourself if a test
needs a revoked membership). `standing` is `"owner" | "admin" | "user"`. Returns
`{ membershipId, tenantId, userId, standing, createdAt }`.

## `seedDevice(db, { tenantId, name?, hostname?, status?, keyProtection? })`

Inserts a `devices` row with a fake-but-valid-shaped `device_public_key_jwk` and a unique
`device_key_thumbprint` (both required NOT NULL/UNIQUE columns — real values come from the agent
enrollment flow, WT-3, which this fixture does not implement). Returns
`{ deviceId, tenantId, name, status, deviceKeyThumbprint, hostname, enrolledAt }`.

## `seedSubscription(db, { tenantId, planCode?, status?, validFrom?, validUntil?, maxManagedUsers?, features?, offlineGraceDays?, renewalWarningDays? })`

Inserts a `subscriptions` row. Every default mirrors the `cloudbox-6` plan seeded by migration
0003 (`planCode: "cloudbox-6"`, 6 managed users, `["remote_access","managed_backup","fleet"]`, 7
grace days, 30 warning days), `status: "active"`, `validFrom: now`, `validUntil: now + 365d`.
Pass `planCode` if the test needs a different plan row seeded first — this helper does not
create plan rows. Returns
`{ subscriptionId, tenantId, planCode, status, validFrom, validUntil, createdAt, updatedAt }`.

## `signInAs(env, { email, name?, staffRole? })` — re-exported, not implemented here

Owned by WT-1, in `apps/worker-api/test/auth-fixtures.ts`. Creates the user if missing (email
verified, as after a real OTP sign-in), upserts a `staff_members` row when `staffRole` is given,
and returns a real Better Auth session through the library's own test-utils plugin — never a
hand-minted `session` row. Returns `{ cookie, userId, headers }`, where `headers` is ready to
pass straight to `app.request(path, { headers }, env)` (it carries the cookie plus a same-origin
`Origin`, since Better Auth's CSRF check inspects `Origin` on writes):

```ts
import { signInAs } from "./fixtures";

const { headers } = await signInAs(env, { email: "reader@example.test", staffRole: "read_only" });
const response = await app.request("/api/v1/tenants", { headers }, env);
```

Note the first argument is the `Bindings` (`env`), not a user id — `signInAs` creates the user
itself rather than taking one `seedStaff` already created. Use one or the other for a given
test, not both, unless the test specifically needs a `staff_members` row to already exist before
sign-in.

## `countingD1(db)` — re-exported, not re-implemented

Re-exported from `./counting-d1` so a test only needs one import line. See that file's own
comment, and `platform/fast-data-hydration.md`'s query-count-ceiling pattern, for what it counts.

## Conventions for adding a new seed helper

- Accept the raw `D1Database`, call `createDb(d1)` internally — do not accept a pre-built `Db`,
  so a test can hand it a `countingD1(...)` wrapper without extra plumbing.
- Insert through `src/db/schema.ts` table objects, never raw SQL, so a Drizzle schema change is
  the only place a break can originate.
- Generate ids with `newId(<kind>)` from `src/ids.ts` (or the Better Auth convention — no
  prefix — for `user`/`session`/`account` rows), never hand-roll a prefix.
- Return the row's fields the caller is likely to need next (mainly the id), not the full raw
  D1 row.
- Give every optional field a sensible, documented default so a test can seed a *usable* row
  (e.g. an `"active"` tenant, not a bare `"provisioning"` one) with one line, and override only
  what the test is actually about.
