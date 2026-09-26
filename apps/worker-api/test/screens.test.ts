import { env } from "cloudflare:test";
import type { AuditScreen, OverviewScreen } from "@cloudbox/contracts";
import { describe, expect, it } from "vitest";
import { audit } from "../src/audit";
import { createDb } from "../src/db/client";
import app from "../src/index";
import { countingD1 } from "./fixtures";

describe("GET /api/v1/screens/overview", () => {
  it("returns real counts in at most three D1 round trips", async () => {
    const counted = countingD1(env.DB);
    const response = await app.request("/api/v1/screens/overview", {}, { ...env, DB: counted });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-API-Version")).toBe("v1");
    expect(counted.roundTrips).toBeLessThanOrEqual(3);

    const body = (await response.json()) as OverviewScreen;
    expect(body.tenants).toEqual({ total: 0, active: 0 });
    expect(body.devices).toEqual({ total: 0, enrolled: 0 });
    expect(body.subscriptions).toEqual({ total: 0, active: 0 });
    expect(body.audit.total).toBeGreaterThanOrEqual(1);
    expect(body.audit.lastEventAt).not.toBeNull();
  });
});

describe("GET /api/v1/screens/audit", () => {
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
    const first = await app.request("/api/v1/screens/audit?limit=2", {}, { ...env, DB: counted });
    expect(first.status).toBe(200);
    expect(counted.roundTrips).toBe(1);
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
      {},
      env,
    );
    const page2 = (await second.json()) as AuditScreen;
    expect(page2.items[0]?.entityId).toBe("e0");
  });

  it("rejects an out-of-range limit with the error shape", async () => {
    const response = await app.request("/api/v1/screens/audit?limit=5000", {}, env);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
  });
});
