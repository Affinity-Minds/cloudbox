// WT-14: migration 0010 rebuilds `subscriptions` (adds `pending`, nullable dates) on a database
// that already holds subscriptions and the entitlements that reference them.
import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("migration 0010 upgrades a Phase 1 database", () => {
  it("keeps every subscription and entitlement, then accepts pending plans", async () => {
    const db = env.UPGRADE_DB;
    const before = env.TEST_MIGRATIONS.filter((m) => m.name < "0010_");
    const upgrade = env.TEST_MIGRATIONS.filter((m) => m.name.startsWith("0010_"));
    expect(upgrade).toHaveLength(1);
    await applyD1Migrations(db, before);

    await db.batch([
      db.prepare(
        "INSERT INTO tenants (id, public_code, display_name, status) VALUES ('ten_u', 'CBX-00900', 'Upgrade', 'active')",
      ),
      db.prepare(
        `INSERT INTO subscriptions (id, tenant_id, plan_code, status, valid_from, valid_until, max_managed_users, features_json, offline_grace_days, renewal_warning_days)
         VALUES ('sub_u', 'ten_u', 'cloudbox-6', 'active', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 6, '[]', 7, 30)`,
      ),
      db.prepare(
        `INSERT INTO devices (id, tenant_id, name, status, device_public_key_jwk, device_key_thumbprint, key_protection, hostname)
         VALUES ('dev_u', 'ten_u', 'CLOUDBOX-00900', 'enrolled', '{}', 'thumb-u', 'software', 'h')`,
      ),
      db.prepare(
        `INSERT INTO entitlements (id, subscription_id, device_id, generation, claims_json, token, issued_by, valid_until)
         VALUES ('lic_u', 'sub_u', 'dev_u', 1, '{}', 'jwe', 'x', '2027-01-01T00:00:00.000Z')`,
      ),
    ]);

    await applyD1Migrations(db, upgrade);

    expect(
      await db.prepare("SELECT id, status, valid_from FROM subscriptions").all(),
    ).toMatchObject({
      results: [{ id: "sub_u", status: "active", valid_from: "2026-01-01T00:00:00.000Z" }],
    });
    expect(
      (await db.prepare("SELECT subscription_id FROM entitlements").first())?.subscription_id,
    ).toBe("sub_u");
    const fk = await db.prepare("PRAGMA foreign_key_check").all();
    expect(fk.results).toEqual([]);
    const index = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'subscriptions_tenant_status_idx'",
      )
      .all();
    expect(index.results).toHaveLength(1);

    // Pending needs no dates; anything else still does.
    await db
      .prepare(
        `INSERT INTO subscriptions (id, tenant_id, plan_code, status, max_managed_users, features_json, offline_grace_days, renewal_warning_days)
         VALUES ('sub_p', 'ten_u', 'cloudbox-6', 'pending', 6, '[]', 7, 30)`,
      )
      .run();
    await expect(
      db
        .prepare(
          `INSERT INTO subscriptions (id, tenant_id, plan_code, status, max_managed_users, features_json, offline_grace_days, renewal_warning_days)
           VALUES ('sub_bad', 'ten_u', 'cloudbox-6', 'active', 6, '[]', 7, 30)`,
        )
        .run(),
    ).rejects.toThrow(/CHECK/);
    await expect(
      db
        .prepare(
          `INSERT INTO license_keys (id, batch_id, code_hash, code_last4, plan_code, batch_label, status, created_by)
           VALUES ('lkey_x', 'lkb_x', 'h', 'ABCD', 'cloudbox-6', 'l', 'lost', 's')`,
        )
        .run(),
    ).rejects.toThrow(/CHECK/);
  });
});
