import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * `env.UPGRADE_DB` is not reset between tests within one file (only between files — verified
 * empirically: isolatedStorage is not on for this pool config), and the first `describe` block
 * below deliberately dirties it. Tests that need a genuinely empty D1 call this first so they
 * are correct regardless of test order within the file, not just today's order.
 */
async function tableNames(db: D1Database): Promise<string[]> {
  const tables = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
    )
    .all<{ name: string }>();
  return tables.results.map((t) => t.name);
}

/**
 * Drops every user table, in as many passes as it takes: FK constraints reject dropping a
 * referenced table before its dependents, and `sqlite_master`'s order is not dependency order.
 * Each pass drops whatever it can and retries the rest; it gives up only if a whole pass drops
 * nothing (a real cycle, which none of these schemas have).
 */
async function resetD1(db: D1Database): Promise<void> {
  let remaining = await tableNames(db);
  while (remaining.length > 0) {
    const failed: string[] = [];
    for (const name of remaining) {
      try {
        await db.prepare(`DROP TABLE "${name}"`).run();
      } catch {
        failed.push(name);
      }
    }
    if (failed.length === remaining.length) {
      throw new Error(`resetD1: stuck dropping ${failed.join(", ")}`);
    }
    remaining = failed;
  }
}

// A release test must start from the previous release's data (agent-notes cloudflare-workers).
describe("migration 0003 upgrades a Phase 0 database", () => {
  it("applies on top of 0001/0002 with existing audit rows and seeds the catalogue", async () => {
    const db = env.UPGRADE_DB;
    const phase0 = env.TEST_MIGRATIONS.filter((m) => /^000[12]_/.test(m.name));
    const identity = env.TEST_MIGRATIONS.filter((m) => m.name.startsWith("0003_"));
    expect(phase0).toHaveLength(2);
    expect(identity).toHaveLength(1);

    await applyD1Migrations(db, phase0);
    await db
      .prepare(
        `INSERT INTO audit_log (id, event_type, entity_type, entity_id, actor_type, actor_id, action, after_json)
         VALUES ('phase0-release', 'foundation.release.changed', 'setting', 'foundation.release',
                 'bootstrap-admin', 'github-actions', 'update', '{"status":"deployed","sha":"abc"}')`,
      )
      .run();

    await applyD1Migrations(db, identity);

    const tables = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all<{ name: string }>();
    expect(tables.results.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "user",
        "session",
        "account",
        "verification",
        "staff_members",
        "permissions",
        "role_permissions",
        "tenants",
        "tenant_memberships",
        "enrollment_tokens",
        "devices",
        "device_credentials",
        "plans",
        "subscriptions",
        "entitlements",
        "signing_keys",
        "audit_log",
        "settings",
      ]),
    );

    const preserved = await db
      .prepare(
        "SELECT actor_id, actor_tenant_id, correlation_id, source FROM audit_log WHERE id = 'phase0-release'",
      )
      .first();
    expect(preserved).toEqual({
      actor_id: "github-actions",
      actor_tenant_id: null,
      correlation_id: null,
      source: null,
    });

    const grants = await db
      .prepare("SELECT role, COUNT(*) AS n FROM role_permissions GROUP BY role ORDER BY role")
      .all<{ role: string; n: number }>();
    expect(Object.fromEntries(grants.results.map((g) => [g.role, g.n]))).toEqual({
      admin: 18,
      read_only: 7,
      super_admin: 21,
      support: 8,
    });

    const counter = await db
      .prepare("SELECT value_json FROM settings WHERE key = 'tenants.next_code'")
      .first<{ value_json: string }>();
    expect(counter?.value_json).toBe("1");

    const plan = await db.prepare("SELECT * FROM plans WHERE code = 'cloudbox-6'").first();
    expect(plan).toMatchObject({ max_devices: 1, max_managed_users: 6, offline_grace_days: 7 });
  });

  it("keeps audit_log append-only after the ALTERs", async () => {
    await expect(
      env.DB.prepare(
        "UPDATE audit_log SET action = 'tampered' WHERE id = 'phase0-initial-schema'",
      ).run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      env.DB.prepare("DELETE FROM audit_log WHERE id = 'phase0-initial-schema'").run(),
    ).rejects.toThrow(/append-only/);
  });

  it("enforces status CHECK constraints", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO tenants (id, public_code, display_name, status) VALUES ('ten_bad', 'CBX-99999', 'Bad', 'bogus')",
      ).run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});

// `env.UPGRADE_DB` starts empty for every test (isolatedStorage resets per test — see
// test/fixtures.README.md and the foundation.test.ts precedent), so it doubles as the "apply
// from empty" fixture here without needing a third D1 binding.
describe("every migration file applies from empty, in order", () => {
  it("creates the full schema with nothing pre-existing", async () => {
    const db = env.UPGRADE_DB;
    await resetD1(db);
    expect(env.TEST_MIGRATIONS.length).toBeGreaterThanOrEqual(4);

    await applyD1Migrations(db, env.TEST_MIGRATIONS);

    const tables = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all<{ name: string }>();
    expect(tables.results.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "settings",
        "audit_log",
        "user",
        "session",
        "account",
        "verification",
        "staff_members",
        "permissions",
        "role_permissions",
        "plans",
        "tenants",
        "tenant_memberships",
        "enrollment_tokens",
        "devices",
        "device_credentials",
        "subscriptions",
        "entitlements",
        "signing_keys",
        "rate_limit",
      ]),
    );

    // Applying out of order (or skipping one) is what "in order" actually guards against: 0003's
    // ALTERs on audit_log, and its seed INSERTs into tables 0001/0002 don't own, would fail loudly
    // if 0001/0002 hadn't run first. Reaching here at all is the assertion; the row counts below
    // confirm the seeds actually landed, not just the tables.
    const plan = await db.prepare("SELECT COUNT(*) AS n FROM plans").first<{ n: number }>();
    expect(plan?.n).toBe(1);
    const permissionCount = await db
      .prepare("SELECT COUNT(*) AS n FROM permissions")
      .first<{ n: number }>();
    expect(permissionCount?.n).toBe(21);
  });

  it("fails loudly, not silently-partially, if a migration runs out of order", async () => {
    const db = env.UPGRADE_DB;
    await resetD1(db);
    // 0003 ALTERs audit_log and references `permissions`/`plans`, which only exist after
    // 0001/0002 ran. Applying it alone must throw (D1 surfaces the underlying SQLite error, per
    // agent-notes cloudflare-workers #7 — walk `.cause` if this ever needs a specific message),
    // never silently create a partial schema.
    const identityOnly = env.TEST_MIGRATIONS.filter((m) => m.name.startsWith("0003_"));
    expect(identityOnly).toHaveLength(1);
    await expect(applyD1Migrations(db, identityOnly)).rejects.toThrow();

    // Loud failure, not partial: none of 0003's own tables exist either (only D1's/the pool's own
    // bookkeeping tables remain — `tableNames` already excludes `sqlite_%`/`_cf_%`; `d1_migrations`
    // is `applyD1Migrations`'s own tracking table, not one of ours). A migration script is not
    // wrapped statement-by-statement, so "no such table: permissions" on an early ALTER/INSERT
    // does not leave later CREATE TABLEs in this same file half-applied — SQLite errors immediately.
    const tables = (await tableNames(db)).filter((name) => name !== "d1_migrations");
    expect(tables).toEqual([]);
  });
});

describe("applying the full migration chain twice", () => {
  it("is a no-op, not a duplicate-schema error or a silent partial apply", async () => {
    const db = env.UPGRADE_DB;
    await resetD1(db);
    await applyD1Migrations(db, env.TEST_MIGRATIONS);
    const before = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all<{ name: string }>();

    // `applyD1Migrations` tracks what it already ran (a `d1_migrations` bookkeeping table) and
    // skips those files on a second call — it must not re-run 0003's seed INSERTs (which would
    // duplicate the permission catalogue) or its CREATE TABLEs (which would throw "already
    // exists" and leave things exactly as broken as a half-applied migration would).
    await expect(applyD1Migrations(db, env.TEST_MIGRATIONS)).resolves.not.toThrow();

    const after = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all<{ name: string }>();
    expect(after.results).toEqual(before.results);

    const permissionCount = await db
      .prepare("SELECT COUNT(*) AS n FROM permissions")
      .first<{ n: number }>();
    expect(permissionCount?.n).toBe(21); // not 42 — the seed INSERTs did not replay.
  });
});
