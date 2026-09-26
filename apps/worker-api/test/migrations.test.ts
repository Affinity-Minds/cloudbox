import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

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
