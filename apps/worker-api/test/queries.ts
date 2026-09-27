// Registry for test/query-plans.test.ts (fast-data-hydration.md "two tests that stop
// regressions", test 1). Owner: WT-6 for the file and the test; every owner APPENDS one entry
// here per *shape* of query they add that reads from a tenant-scoped or otherwise large table —
// `tenants`, `devices`, `tenant_memberships`, `subscriptions`, `entitlements`,
// `enrollment_tokens`, `audit_log` — one entry per shape, not per call site.
//
// `sql` is the literal statement as D1 sees it (no Drizzle query-builder sugar — copy what
// Drizzle would generate, e.g. by logging it once, or write the equivalent by hand). `params`
// are bind values in the same order as the `?` placeholders; `EXPLAIN QUERY PLAN` never executes
// the statement, so the *values* rarely change the plan, but the placeholder count must match or
// D1 rejects the bind.
export type RegisteredQuery = {
  /** `<screen or module>: <what the query does>`, e.g. `"screens.fleet: devices by tenant"`. */
  name: string;
  sql: string;
  params?: unknown[];
};

export const queries: RegisteredQuery[] = [
  // ─── screens/overview.ts (loadOverview): one aggregate per table, one D1 round trip total ───
  {
    name: "screens.overview: tenants aggregate",
    sql: `SELECT count(*) AS total, coalesce(sum(case when "tenants"."status" = 'active' then 1 else 0 end), 0) AS active FROM "tenants"`,
  },
  {
    name: "screens.overview: devices aggregate",
    sql: `SELECT count(*) AS total, coalesce(sum(case when "devices"."status" = 'enrolled' then 1 else 0 end), 0) AS enrolled FROM "devices"`,
  },
  {
    name: "screens.overview: subscriptions aggregate",
    sql: `SELECT count(*) AS total, coalesce(sum(case when "subscriptions"."status" = 'active' then 1 else 0 end), 0) AS active FROM "subscriptions"`,
  },
  {
    name: "screens.overview: audit aggregate with last-event subquery",
    sql: `SELECT count(*) AS total, (select "audit_log"."created_at" from "audit_log" order by rowid desc limit 1) AS "lastEventAt" FROM "audit_log"`,
  },
  // ─── screens/audit.ts (loadAuditPage): keyset page, newest first ──────────────────────────
  {
    name: "screens.audit: keyset page ordered by rowid desc",
    sql: `SELECT rowid, id, event_type, entity_type, entity_id, actor_type, actor_id, actor_tenant_id, action, before_json, after_json, correlation_id, source, created_at FROM "audit_log" WHERE rowid < ? ORDER BY rowid DESC LIMIT ?`,
    params: [999_999_999, 51],
  },
  {
    name: "screens.audit: first page (no cursor) ordered by rowid desc",
    sql: `SELECT rowid, id, event_type, entity_type, entity_id, actor_type, actor_id, actor_tenant_id, action, before_json, after_json, correlation_id, source, created_at FROM "audit_log" ORDER BY rowid DESC LIMIT ?`,
    params: [51],
  },
  // ─── screens/fleet.ts (loadFleet): devices by tenant, license via a correlated subquery ──
  {
    name: "screens.fleet: devices by tenant with correlated latest-entitlement subquery",
    sql: `SELECT "devices"."id", "devices"."tenant_id", "devices"."name", "devices"."status", "devices"."hostname", "devices"."windows_build", "devices"."agent_version", "devices"."key_protection", "devices"."last_seen_at", "devices"."enrolled_at", "tenants"."public_code", "tenants"."display_name", (SELECT "entitlements"."valid_until" FROM "entitlements" WHERE "entitlements"."device_id" = "devices"."id" AND "entitlements"."revoked_at" IS NULL ORDER BY "entitlements"."generation" DESC LIMIT 1) FROM "devices" INNER JOIN "tenants" ON "tenants"."id" = "devices"."tenant_id" WHERE "devices"."tenant_id" = ? ORDER BY "devices"."enrolled_at" DESC`,
    params: ["ten_test"],
  },
  {
    name: "screens.fleet: tenant picker restricted to a tenant-standing caller's own tenants",
    sql: `SELECT "tenants"."id", "tenants"."public_code", "tenants"."display_name" FROM "tenants" WHERE "tenants"."id" IN (?) ORDER BY "tenants"."display_name"`,
    params: ["ten_test"],
  },
  {
    name: "screens.fleet: resolveFleetAccess — the caller's active tenant memberships",
    sql: `SELECT "tenant_memberships"."tenant_id" FROM "tenant_memberships" WHERE "tenant_memberships"."user_id" = ? AND "tenant_memberships"."status" = 'active'`,
    params: ["u_test"],
  },
  // ─── routes/v1/realtime.ts (resolveRealtimeAccess): a customer's active tenant memberships,
  // same index as screens.fleet's own lookup above but built through drizzle's `and()` (parens,
  // both sides parameterised) rather than a literal `sql` template ────────────────────────────
  {
    name: "realtime.fleet: resolveRealtimeAccess — the caller's active tenant memberships",
    sql: `select "tenant_memberships"."tenant_id" from "tenant_memberships" where ("tenant_memberships"."user_id" = ? and "tenant_memberships"."status" = ?)`,
    params: ["u_test", "active"],
  },
  // ─── screens/fleet.ts (loadFleetDetail): one device, its entitlement history, its audit trail ──
  {
    name: "screens.fleet: device detail by id, joined to its tenant",
    sql: `SELECT "devices"."id", "devices"."tenant_id", "devices"."name", "devices"."status", "devices"."device_key_thumbprint", "devices"."key_protection", "devices"."hostname", "devices"."windows_build", "devices"."agent_version", "devices"."last_seen_at", "devices"."last_health_json", "devices"."enrolled_at", "devices"."revoked_at", "tenants"."public_code", "tenants"."display_name" FROM "devices" INNER JOIN "tenants" ON "tenants"."id" = "devices"."tenant_id" WHERE "devices"."id" = ?`,
    params: ["dev_test"],
  },
  {
    name: "screens.fleet: entitlement history for one device",
    sql: `SELECT "entitlements"."id", "entitlements"."subscription_id", "entitlements"."generation", "entitlements"."issued_at", "entitlements"."valid_until", "entitlements"."revoked_at" FROM "entitlements" WHERE "entitlements"."device_id" = ? ORDER BY "entitlements"."generation" DESC`,
    params: ["dev_test"],
  },
  {
    name: "screens.fleet: audit trail for one device, newest first",
    sql: `SELECT rowid, id, event_type, entity_type, entity_id, actor_type, actor_id, actor_tenant_id, action, before_json, after_json, correlation_id, source, created_at FROM "audit_log" WHERE "audit_log"."entity_type" = 'device' AND "audit_log"."entity_id" = ? ORDER BY rowid DESC LIMIT ?`,
    params: ["dev_test", 25],
  },
  // ─── email/send.ts (loadEnabledProviders): one query, cached 60s per isolate ──────────────
  {
    name: "email.send: enabled providers ordered by priority",
    sql: `SELECT "id", "name", "kind", "from_address", "config_json", "secret_ciphertext", "secret_iv" FROM "email_providers" WHERE "email_providers"."enabled" = ? ORDER BY "email_providers"."priority" ASC`,
    params: [1],
  },
  // ─── screens/plans.ts (loadPlansScreen): every plan, plus a grouped subscription count ────
  {
    name: "screens.plans: subscription count grouped by plan_code",
    sql: `SELECT "subscriptions"."plan_code", count(*) FROM "subscriptions" GROUP BY "subscriptions"."plan_code"`,
  },
  // ─── WT-14 onboarding/plan.ts, self-service.ts, auth-routes.ts, license-keys.ts ─────────────
  {
    name: "onboarding.plan: newest non-cancelled subscription per tenant (portal, Connect, Fleet, activation)",
    sql: `select "subscriptions"."tenant_id", "subscriptions"."id", "subscriptions"."status", "subscriptions"."valid_from", "subscriptions"."valid_until", "subscriptions"."plan_code", "plans"."name", "plans"."max_devices" from "subscriptions" left join "plans" on "plans"."code" = "subscriptions"."plan_code" where ("subscriptions"."tenant_id" in (?) and "subscriptions"."status" <> ?) order by "subscriptions"."created_at" desc`,
    params: ["ten_test", "cancelled"],
  },
  {
    name: "onboarding.overview: the caller's active memberships with enrolled-device counts",
    sql: `select "tenants"."id", "tenants"."public_code", "tenants"."display_name", "tenants"."status", "tenant_memberships"."standing", (SELECT count(*) FROM "devices" WHERE "devices"."tenant_id" = "tenants"."id" AND "devices"."status" = 'enrolled') from "tenant_memberships" inner join "tenants" on "tenants"."id" = "tenant_memberships"."tenant_id" where ("tenant_memberships"."user_id" = ? and "tenant_memberships"."status" = ?) order by "tenants"."created_at"`,
    params: ["u_test", "active"],
  },
  {
    name: "auth.connect: active membership of an email in a tenant, by tenant public code",
    sql: `select "tenants"."id", "tenants"."public_code" from "tenants" inner join "tenant_memberships" on ("tenant_memberships"."tenant_id" = "tenants"."id" and "tenant_memberships"."status" = ?) inner join "customer_users" on ("customer_users"."id" = "tenant_memberships"."user_id" and "customer_users"."email" = ?) where "tenants"."public_code" = ? limit ?`,
    params: ["active", "e@example.test", "CBX-00001", 1],
  },
  {
    name: "connect.devices: the caller's active membership of one tenant",
    sql: `select "tenants"."public_code", "tenants"."display_name" from "tenant_memberships" inner join "tenants" on "tenants"."id" = "tenant_memberships"."tenant_id" where ("tenant_memberships"."tenant_id" = ? and "tenant_memberships"."user_id" = ? and "tenant_memberships"."status" = ?)`,
    params: ["ten_test", "u_test", "active"],
  },
  {
    name: "activation: redeem a pending subscription (conditional update by id)",
    sql: `update "subscriptions" set "status" = ?, "valid_from" = ?, "valid_until" = ?, "updated_at" = ? where ("subscriptions"."id" = ? and "subscriptions"."status" = ?) returning "id"`,
    params: ["active", "2026-01-01", "2027-01-01", "2026-01-01", "sub_test", "pending"],
  },
  {
    name: "license_keys: redeem claim by code hash",
    sql: `update "license_keys" set "status" = ?, "redeemed_at" = ?, "redeemed_by_email" = ? where ("license_keys"."code_hash" = ? and "license_keys"."status" = ? and "license_keys"."revoked_at" is null and ("license_keys"."expires_at" IS NULL OR "license_keys"."expires_at" > ?)) returning "id", "plan_code"`,
    params: ["redeemed", "2026-01-01", "e", "hash", "unredeemed", "2026-01-01"],
  },
  {
    name: "license_keys: list one batch with the redeeming tenant's code",
    sql: `select "license_keys"."id", "license_keys"."batch_id", "license_keys"."code_last4", "tenants"."public_code" from "license_keys" left join "tenants" on "tenants"."id" = "license_keys"."redeemed_tenant_id" where "license_keys"."batch_id" = ? order by "license_keys"."created_at" desc, "license_keys"."id" limit ?`,
    params: ["lkb_test", 1000],
  },
  {
    name: "license_keys: support lookup by last four symbols",
    sql: `select "license_keys"."id", "tenants"."public_code" from "license_keys" left join "tenants" on "tenants"."id" = "license_keys"."redeemed_tenant_id" where "license_keys"."code_last4" = ? order by "license_keys"."created_at" desc, "license_keys"."id" limit ?`,
    params: ["ABCD", 1000],
  },
  {
    name: "onboarding.tenants: self-created tenants without a plan (lifetime cap, review P2-6)",
    sql: `SELECT count(*) AS n FROM tenant_memberships m WHERE m.user_id = ? AND m.status = 'active' AND m.standing = 'owner' AND m.invited_by = ? AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.tenant_id = m.tenant_id AND s.status <> 'cancelled')`,
    params: ["u_test", "u_test"],
  },
  {
    name: "auth.start: codes sent to an address in 24 h + ceiling already audited (review P2-5)",
    sql: `SELECT (SELECT count(*) FROM audit_log WHERE entity_type = 'auth_email' AND entity_id = ? AND event_type = 'AUTH_OTP_SENT' AND created_at > ? AND json_extract(after_json, '$.outcome') IN ('sent', 'send_failed')) AS sent, (SELECT count(*) FROM audit_log WHERE entity_type = 'auth_email' AND entity_id = ? AND event_type = 'AUTH_START_CEILING' AND created_at > ?) AS ceiling`,
    params: ["e@example.test", "2026-01-01", "e@example.test", "2026-01-01"],
  },
  // ─── network/controller.ts (WT-9): one row per peer, looked up by its partial unique index ───
  {
    name: "network.controller: this device's peer rows for the Fleet Network tab",
    sql: `select "id", "kind", "status", "netbird_peer_id", "created_at", "updated_at" from "network_peers" where ("network_peers"."kind" = ? and "network_peers"."device_id" = ?) order by "network_peers"."updated_at" desc`,
    params: ["server", "dev_test"],
  },
  {
    name: "network.controller: upsert lookup — server row by device id",
    sql: `select "id" from "network_peers" where ("network_peers"."kind" = ? and "network_peers"."device_id" = ?)`,
    params: ["server", "dev_test"],
  },
  {
    name: "network.controller: upsert lookup — client row by (tenant, user)",
    sql: `select "id" from "network_peers" where ("network_peers"."kind" = ? and "network_peers"."tenant_id" = ? and "network_peers"."user_id" = ?)`,
    params: ["client", "ten_test", "u1"],
  },
  {
    name: "network.controller: upsert lookup — support marker row by tenant",
    sql: `select "id" from "network_peers" where ("network_peers"."kind" = ? and "network_peers"."tenant_id" = ?)`,
    params: ["support", "ten_test"],
  },
];
