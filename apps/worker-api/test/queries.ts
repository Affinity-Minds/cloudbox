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
];
