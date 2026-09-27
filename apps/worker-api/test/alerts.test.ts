// Owner: WT-17. Evaluator (open/resolve/reopen, dedupe, audited transitions, cooldown), the cron
// handler, the staff screen loader's round-trip ceiling, acknowledge/resolve, and customer scoping.
import {
  createExecutionContext,
  createScheduledController,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { dedupeKeyFor, evaluateAlerts } from "../src/alerts/evaluate";
import { setStaffRecipients } from "../src/alerts/settings";
import { createDb } from "../src/db/client";
import { alerts, auditLog, devices } from "../src/db/schema";
import app from "../src/index";
import { type SignedIn, signInAs } from "./auth-fixtures";
import { countingD1, seedDevice, seedMembership, seedSubscription, seedTenant } from "./fixtures";

const db = createDb(env.DB);

async function setLastSeen(deviceId: string, iso: string | null) {
  await db.update(devices).set({ lastSeenAt: iso }).where(eq(devices.id, deviceId));
}

async function alertRow(dedupeKey: string) {
  const [row] = await db.select().from(alerts).where(eq(alerts.dedupeKey, dedupeKey)).limit(1);
  return row ?? null;
}

async function openedAudits(entityId: string) {
  return db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, "alert"),
        eq(auditLog.entityId, entityId),
        eq(auditLog.eventType, "ALERT_OPENED"),
      ),
    );
}

async function resolvedAudits(entityId: string) {
  return db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, "alert"),
        eq(auditLog.entityId, entityId),
        eq(auditLog.eventType, "ALERT_RESOLVED"),
      ),
    );
}

let staff: SignedIn;
let readOnly: SignedIn;
let AUTH_ROUND_TRIPS = 0;

beforeAll(async () => {
  staff = await signInAs(env, { email: "alerts-staff@example.test", staffRole: "super_admin" });
  readOnly = await signInAs(env, { email: "alerts-readonly@example.test", staffRole: "read_only" });
  const counted = countingD1(env.DB);
  await app.request("/api/v1/auth/session", { headers: staff.headers }, { ...env, DB: counted });
  AUTH_ROUND_TRIPS = counted.roundTrips;
});

describe("scheduled handler", () => {
  it("runs without throwing, empty or not", async () => {
    const ctx = createExecutionContext();
    const controller = createScheduledController({
      scheduledTime: Date.now(),
      cron: "*/5 * * * *",
    });
    await expect(app.scheduled(controller, env, ctx)).resolves.toBeUndefined();
    await waitOnExecutionContext(ctx);
  });
});

describe("device_offline: opens, holds, resolves, reopens the same row", () => {
  it("opens once, refreshes without re-auditing, resolves once, and reopens on the same dedupe key", async () => {
    const tenant = await seedTenant(env.DB);
    const device = await seedDevice(env.DB, { tenantId: tenant.tenantId });
    const key = dedupeKeyFor({
      category: "device_offline",
      deviceId: device.deviceId,
      tenantId: null,
    });

    const longAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    await setLastSeen(device.deviceId, longAgo);

    const t0 = new Date();
    const first = await evaluateAlerts(env, db, t0);
    expect(first.opened).toBeGreaterThanOrEqual(1);

    const opened = await alertRow(key);
    expect(opened).not.toBeNull();
    expect(opened?.status).toBe("open");
    expect(opened?.category).toBe("device_offline");
    expect(opened?.tenantId).toBe(tenant.tenantId); // carried for filtering; dedupe is by device only
    expect(await openedAudits(opened?.id ?? "")).toHaveLength(1);

    // Re-run, condition unchanged: no second alert row, no second ALERT_OPENED audit.
    const t1 = new Date(t0.getTime() + 60_000);
    await evaluateAlerts(env, db, t1);
    const stillOpen = await alertRow(key);
    expect(stillOpen?.id).toBe(opened?.id);
    expect(await openedAudits(opened?.id ?? "")).toHaveLength(1);

    // Device comes back online: the same row resolves, audited once.
    await setLastSeen(device.deviceId, t1.toISOString());
    const t2 = new Date(t1.getTime() + 60_000);
    const resolvedRun = await evaluateAlerts(env, db, t2);
    expect(resolvedRun.resolved).toBeGreaterThanOrEqual(1);
    const resolved = await alertRow(key);
    expect(resolved?.id).toBe(opened?.id);
    expect(resolved?.status).toBe("resolved");
    expect(await resolvedAudits(opened?.id ?? "")).toHaveLength(1);

    // Re-run, still online: no second resolve audit.
    const t3 = new Date(t2.getTime() + 60_000);
    await evaluateAlerts(env, db, t3);
    expect(await resolvedAudits(opened?.id ?? "")).toHaveLength(1);

    // Goes offline again: the SAME dedupe_key/row reopens rather than a second insert.
    await setLastSeen(device.deviceId, new Date(t3.getTime() - 60 * 60_000).toISOString());
    const t4 = new Date(t3.getTime() + 60_000);
    const reopenedRun = await evaluateAlerts(env, db, t4);
    expect(reopenedRun.opened).toBeGreaterThanOrEqual(1);
    const reopened = await alertRow(key);
    expect(reopened?.id).toBe(opened?.id);
    expect(reopened?.status).toBe("open");
    expect(await openedAudits(opened?.id ?? "")).toHaveLength(2);
  });
});

describe("no_active_plan", () => {
  it("opens for an enrolled device with no live entitlement and no active subscription", async () => {
    const tenant = await seedTenant(env.DB);
    const device = await seedDevice(env.DB, { tenantId: tenant.tenantId });
    await setLastSeen(device.deviceId, new Date().toISOString()); // online, isolates this category

    await evaluateAlerts(env, db, new Date());
    const key = dedupeKeyFor({
      category: "no_active_plan",
      deviceId: device.deviceId,
      tenantId: null,
    });
    const row = await alertRow(key);
    expect(row?.status).toBe("open");
    expect(row?.severity).toBe("warning");
  });
});

describe("license_expiring / license_expired (tenant-scoped, deviceId null)", () => {
  it("opens license_expiring inside the renewal window", async () => {
    const tenant = await seedTenant(env.DB);
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
    await seedSubscription(env.DB, {
      tenantId: tenant.tenantId,
      status: "active",
      validFrom: new Date(Date.now() - 300 * 86_400_000).toISOString(),
      validUntil: soon,
      renewalWarningDays: 30,
    });

    await evaluateAlerts(env, db, new Date());
    const key = dedupeKeyFor({
      category: "license_expiring",
      deviceId: null,
      tenantId: tenant.tenantId,
    });
    const row = await alertRow(key);
    expect(row?.status).toBe("open");
    expect(row?.severity).toBe("warning");
    expect(row?.deviceId).toBeNull();
  });

  it("opens license_expired past the subscription's end, critical", async () => {
    const tenant = await seedTenant(env.DB);
    await seedSubscription(env.DB, {
      tenantId: tenant.tenantId,
      status: "active",
      validFrom: new Date(Date.now() - 400 * 86_400_000).toISOString(),
      validUntil: new Date(Date.now() - 1 * 86_400_000).toISOString(),
    });

    await evaluateAlerts(env, db, new Date());
    const key = dedupeKeyFor({
      category: "license_expired",
      deviceId: null,
      tenantId: tenant.tenantId,
    });
    const row = await alertRow(key);
    expect(row?.status).toBe("open");
    expect(row?.severity).toBe("critical");
  });
});

describe("health-derived categories (from last_health_json)", () => {
  it("rdp_unhealthy, private_network_failed, reboot_required, and disk_low at the §24 thresholds", async () => {
    const tenant = await seedTenant(env.DB);
    const device = await seedDevice(env.DB, { tenantId: tenant.tenantId });
    await setLastSeen(device.deviceId, new Date().toISOString());
    await db
      .update(devices)
      .set({
        lastHealthJson: JSON.stringify({
          device: device.deviceId,
          agent: { version: "1.0.0", healthy: true },
          rdp: { state: "degraded", listener: false },
          network: { state: "disconnected" },
          updates: { state: "current", reboot_required: true },
          storage: { free_bytes: 5, total_bytes: 100 }, // 5% free: critical
        }),
      })
      .where(eq(devices.id, device.deviceId));

    await evaluateAlerts(env, db, new Date());

    for (const [category, severity] of [
      ["rdp_unhealthy", "warning"],
      ["private_network_failed", "warning"],
      ["reboot_required", "info"],
      ["disk_low", "critical"],
    ] as const) {
      const row = await alertRow(
        dedupeKeyFor({ category, deviceId: device.deviceId, tenantId: null }),
      );
      expect(row?.status, category).toBe("open");
      expect(row?.severity, category).toBe(severity);
    }
  });

  it("does not evaluate disk_low without total_bytes (older agents send free_bytes only)", async () => {
    const tenant = await seedTenant(env.DB);
    const device = await seedDevice(env.DB, { tenantId: tenant.tenantId });
    await setLastSeen(device.deviceId, new Date().toISOString());
    await db
      .update(devices)
      .set({
        lastHealthJson: JSON.stringify({
          device: device.deviceId,
          agent: { version: "1.0.0", healthy: true },
          storage: { free_bytes: 5 },
        }),
      })
      .where(eq(devices.id, device.deviceId));

    await evaluateAlerts(env, db, new Date());
    const row = await alertRow(
      dedupeKeyFor({ category: "disk_low", deviceId: device.deviceId, tenantId: null }),
    );
    expect(row).toBeNull();
  });
});

describe("notification cooldown", () => {
  it("notifies once on open, then withholds until the 6h cooldown elapses", async () => {
    await setStaffRecipients(db, ["ops@example.test"]);
    const tenant = await seedTenant(env.DB);
    const device = await seedDevice(env.DB, { tenantId: tenant.tenantId });
    await setLastSeen(device.deviceId, new Date(Date.now() - 60 * 60_000).toISOString());

    const t0 = new Date();
    const first = await evaluateAlerts(env, db, t0);
    expect(first.notified).toBeGreaterThanOrEqual(1);

    const key = dedupeKeyFor({
      category: "device_offline",
      deviceId: device.deviceId,
      tenantId: null,
    });
    const afterFirst = await alertRow(key);
    expect(afterFirst?.notifiedAt).not.toBeNull();
    const notifiedCountAfterFirst = (
      await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityType, "alert"), eq(auditLog.entityId, afterFirst?.id ?? "")))
    ).filter((r) => r.eventType === "ALERT_NOTIFIED").length;
    expect(notifiedCountAfterFirst).toBe(1);

    // Still within 6h: still open, but no repeat email for THIS alert (a small time step, so
    // other tests' devices — anchored to real wall-clock `lastSeenAt` values — don't flip state
    // and pollute the aggregate `notified` count; this assertion is scoped to one alert id, not
    // the evaluator's whole-DB return value, precisely to stay correct under shared D1 state).
    const t1 = new Date(t0.getTime() + 60 * 60_000);
    await evaluateAlerts(env, db, t1);
    const afterSecond = await alertRow(key);
    expect(afterSecond?.notifiedAt).toBe(afterFirst?.notifiedAt);
    const notifiedCountAfterSecond = (
      await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityType, "alert"), eq(auditLog.entityId, afterFirst?.id ?? "")))
    ).filter((r) => r.eventType === "ALERT_NOTIFIED").length;
    expect(notifiedCountAfterSecond).toBe(1);

    // Past the cooldown: notifies again — same scoping.
    const t2 = new Date(t0.getTime() + 7 * 60 * 60_000);
    await evaluateAlerts(env, db, t2);
    const afterThird = await alertRow(key);
    expect(afterThird?.notifiedAt).not.toBe(afterFirst?.notifiedAt);
    const notifiedCountAfterThird = (
      await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityType, "alert"), eq(auditLog.entityId, afterFirst?.id ?? "")))
    ).filter((r) => r.eventType === "ALERT_NOTIFIED").length;
    expect(notifiedCountAfterThird).toBe(2);
  });
});

describe("GET /api/v1/screens/alerts", () => {
  it("401 anonymous, 403 read_only-without-device.view is false (read_only has device.view; asserts 200)", async () => {
    const anonymous = await app.request("/api/v1/screens/alerts", {}, env);
    expect(anonymous.status).toBe(401);

    const asReadOnly = await app.request(
      "/api/v1/screens/alerts",
      { headers: readOnly.headers },
      env,
    );
    expect(asReadOnly.status).toBe(200);
  });

  it("loader stays within the round-trip ceiling (one batch beyond auth)", async () => {
    const counted = countingD1(env.DB);
    const response = await app.request(
      "/api/v1/screens/alerts",
      { headers: staff.headers },
      { ...env, DB: counted },
    );
    expect(response.status).toBe(200);
    expect(counted.roundTrips - AUTH_ROUND_TRIPS).toBeLessThanOrEqual(3);
  });

  it("filters by status/severity/tenant", async () => {
    const tenant = await seedTenant(env.DB);
    const device = await seedDevice(env.DB, { tenantId: tenant.tenantId });
    await setLastSeen(device.deviceId, new Date(Date.now() - 60 * 60_000).toISOString());
    await evaluateAlerts(env, db, new Date());

    const filtered = await app.request(
      `/api/v1/screens/alerts?tenant=${tenant.tenantId}&status=open&severity=warning`,
      { headers: staff.headers },
      env,
    );
    expect(filtered.status).toBe(200);
    const body = (await filtered.json()) as { items: { tenantId: string | null }[] };
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) expect(item.tenantId).toBe(tenant.tenantId);
  });
});

describe("POST /api/v1/alerts/:id/{acknowledge,resolve}", () => {
  it("acknowledge then resolve, with 409 on an already-resolved alert, 404 unknown, and 403 for read_only", async () => {
    const tenant = await seedTenant(env.DB);
    const device = await seedDevice(env.DB, { tenantId: tenant.tenantId });
    await setLastSeen(device.deviceId, new Date(Date.now() - 60 * 60_000).toISOString());
    await evaluateAlerts(env, db, new Date());
    const key = dedupeKeyFor({
      category: "device_offline",
      deviceId: device.deviceId,
      tenantId: null,
    });
    const row = await alertRow(key);
    expect(row).not.toBeNull();
    const id = row?.id ?? "";

    const denied = await app.request(
      `/api/v1/alerts/${id}/acknowledge`,
      { method: "POST", headers: readOnly.headers },
      env,
    );
    expect(denied.status).toBe(403);

    const ack = await app.request(
      `/api/v1/alerts/${id}/acknowledge`,
      { method: "POST", headers: staff.headers },
      env,
    );
    expect(ack.status).toBe(200);
    await expect(ack.json()).resolves.toMatchObject({ status: "acknowledged" });

    const resolve = await app.request(
      `/api/v1/alerts/${id}/resolve`,
      { method: "POST", headers: staff.headers },
      env,
    );
    expect(resolve.status).toBe(200);
    await expect(resolve.json()).resolves.toMatchObject({ status: "resolved" });

    const again = await app.request(
      `/api/v1/alerts/${id}/resolve`,
      { method: "POST", headers: staff.headers },
      env,
    );
    expect(again.status).toBe(409);

    const missing = await app.request(
      "/api/v1/alerts/alrt_does-not-exist/acknowledge",
      { method: "POST", headers: staff.headers },
      env,
    );
    expect(missing.status).toBe(404);
  });
});

describe("GET /api/v1/me/alerts (customer, membership-scoped)", () => {
  it("a member sees their own tenant's alert; a non-member sees none", async () => {
    const tenant = await seedTenant(env.DB);
    const device = await seedDevice(env.DB, { tenantId: tenant.tenantId });
    await setLastSeen(device.deviceId, new Date(Date.now() - 60 * 60_000).toISOString());
    await evaluateAlerts(env, db, new Date());

    const member = await signInAs(env, { email: "alerts-member@example.test" });
    await seedMembership(env.DB, {
      tenantId: tenant.tenantId,
      userId: member.userId,
      standing: "owner",
    });
    const outsider = await signInAs(env, { email: "alerts-outsider@example.test" });

    const anonymous = await app.request("/api/v1/me/alerts", {}, env);
    expect(anonymous.status).toBe(401);

    const asMember = await app.request("/api/v1/me/alerts", { headers: member.headers }, env);
    expect(asMember.status).toBe(200);
    const memberBody = (await asMember.json()) as { items: { tenantId: string | null }[] };
    expect(memberBody.items.some((a) => a.tenantId === tenant.tenantId)).toBe(true);

    const asOutsider = await app.request("/api/v1/me/alerts", { headers: outsider.headers }, env);
    expect(asOutsider.status).toBe(200);
    const outsiderBody = (await asOutsider.json()) as { items: unknown[] };
    expect(outsiderBody.items).toEqual([]);
  });
});

describe("GET/PATCH /api/v1/settings/alerts", () => {
  it("round-trips the staff recipient list, gated settings.manage", async () => {
    const denied = await app.request(
      "/api/v1/settings/alerts",
      { method: "PATCH", headers: readOnly.headers, body: JSON.stringify({ staffRecipients: [] }) },
      env,
    );
    expect(denied.status).toBe(403);

    const patched = await app.request(
      "/api/v1/settings/alerts",
      {
        method: "PATCH",
        headers: { "content-type": "application/json", ...staff.headers },
        body: JSON.stringify({ staffRecipients: ["a@example.test", "b@example.test"] }),
      },
      env,
    );
    expect(patched.status).toBe(200);
    await expect(patched.json()).resolves.toEqual({
      staffRecipients: ["a@example.test", "b@example.test"],
    });

    const got = await app.request("/api/v1/settings/alerts", { headers: staff.headers }, env);
    await expect(got.json()).resolves.toEqual({
      staffRecipients: ["a@example.test", "b@example.test"],
    });
  });
});

// Sanity: `audit()` records exactly one ALERT_OPENED per genuine transition, never per evaluator
// tick — regression guard for the "never email/audit every heartbeat" rule (spec §25).
describe("evaluator idempotence", () => {
  it("running the evaluator three times in a row with nothing changed adds nothing", async () => {
    const tenant = await seedTenant(env.DB);
    const device = await seedDevice(env.DB, { tenantId: tenant.tenantId });
    await setLastSeen(device.deviceId, new Date(Date.now() - 60 * 60_000).toISOString());

    const now = new Date();
    await evaluateAlerts(env, db, now);
    const key = dedupeKeyFor({
      category: "device_offline",
      deviceId: device.deviceId,
      tenantId: null,
    });
    const row = await alertRow(key);
    const before = await openedAudits(row?.id ?? "");

    await evaluateAlerts(env, db, new Date(now.getTime() + 1000));
    await evaluateAlerts(env, db, new Date(now.getTime() + 2000));
    const after = await openedAudits(row?.id ?? "");
    expect(after).toHaveLength(before.length);
  });
});
