import { env } from "cloudflare:test";
import type { AuditScreen, OverviewScreen } from "@cloudbox/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { audit } from "../src/audit";
import { createDb } from "../src/db/client";
import app from "../src/index";
import { type SignedIn, signInAs } from "./auth-fixtures";
import { countingD1 } from "./fixtures";

/** Session lookup (Better Auth) + one staff-grants query, per request. Measured below. */
let AUTH_ROUND_TRIPS = 0;
let staff: SignedIn;
beforeAll(async () => {
  staff = await signInAs(env, { email: "screens-reader@example.test", staffRole: "read_only" });
  const counted = countingD1(env.DB);
  await app.request("/api/v1/auth/session", { headers: staff.headers }, { ...env, DB: counted });
  AUTH_ROUND_TRIPS = counted.roundTrips;
  expect(AUTH_ROUND_TRIPS).toBeLessThanOrEqual(2);
});

describe("GET /api/v1/screens/overview", () => {
  it("requires a session and the tenant.view permission", async () => {
    const anonymous = await app.request("/api/v1/screens/overview", {}, env);
    expect(anonymous.status).toBe(401);
    await expect(anonymous.json()).resolves.toEqual({ error: "unauthenticated" });

    const outsider = await signInAs(env, { email: "screens-outsider@example.test" });
    const denied = await app.request(
      "/api/v1/screens/overview",
      { headers: outsider.headers },
      env,
    );
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toEqual({ error: "forbidden" });
  });

  it("returns real counts in at most three D1 round trips beyond auth", async () => {
    const counted = countingD1(env.DB);
    const response = await app.request(
      "/api/v1/screens/overview",
      { headers: staff.headers },
      { ...env, DB: counted },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("X-API-Version")).toBe("v1");
    expect(counted.roundTrips).toBeLessThanOrEqual(3 + AUTH_ROUND_TRIPS);

    const body = (await response.json()) as OverviewScreen;
    expect(body.tenants).toEqual({ total: 0, active: 0 });
    expect(body.devices).toEqual({ total: 0, enrolled: 0 });
    expect(body.subscriptions).toEqual({ total: 0, active: 0 });
    expect(body.audit.total).toBeGreaterThanOrEqual(1);
    expect(body.audit.lastEventAt).not.toBeNull();
  });
});

describe("GET /api/v1/screens/audit", () => {
  it("requires a session and the audit.view permission", async () => {
    const anonymous = await app.request("/api/v1/screens/audit", {}, env);
    expect(anonymous.status).toBe(401);
    const outsider = await signInAs(env, { email: "audit-outsider@example.test" });
    const denied = await app.request("/api/v1/screens/audit", { headers: outsider.headers }, env);
    expect(denied.status).toBe(403);
  });

  it("pages newest first with a keyset cursor in one round trip per page", async () => {
    const db = createDb(env.DB);
    for (let i = 0; i < 3; i += 1) {
      await audit(db, {
        eventType: "TEST_EVENT_RECORDED",
        entityType: "test",
        entityId: `e${i}`,
        actor: { type: "system", id: "test", tenantId: "ten_test" },
        before: null,
        after: { i },
        correlationId: `corr-${i}`,
        source: "test",
      });
    }

    const counted = countingD1(env.DB);
    const first = await app.request(
      "/api/v1/screens/audit?limit=2",
      { headers: staff.headers },
      { ...env, DB: counted },
    );
    expect(first.status).toBe(200);
    expect(counted.roundTrips).toBe(1 + AUTH_ROUND_TRIPS);
    const page1 = (await first.json()) as AuditScreen;
    expect(page1.items.map((item) => item.entityId)).toEqual(["e2", "e1"]);
    expect(page1.items[0]).toMatchObject({
      action: "recorded",
      actorTenantId: "ten_test",
      correlationId: "corr-2",
      source: "test",
      after: { i: 2 },
    });
    expect(page1.nextCursor).not.toBeNull();

    const second = await app.request(
      `/api/v1/screens/audit?limit=2&cursor=${page1.nextCursor}`,
      { headers: staff.headers },
      env,
    );
    const page2 = (await second.json()) as AuditScreen;
    expect(page2.items[0]?.entityId).toBe("e0");
  });

  it("rejects an out-of-range limit with the error shape", async () => {
    const response = await app.request(
      "/api/v1/screens/audit?limit=5000",
      { headers: staff.headers },
      env,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
  });
});
