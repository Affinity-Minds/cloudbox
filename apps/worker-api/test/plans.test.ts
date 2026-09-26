// Owner: WT-13. Plan designer: CRUD, lifecycle (retire/reactivate), permission boundary, the
// screens/plans loader's round-trip ceiling, and the tenant-side invalid-timezone gate that ships
// alongside it. Every request goes through the real WT-1 middleware with a real session
// (signInAs) — no hand-minted sessions.
import { env } from "cloudflare:test";
import type { Plan, PlansScreen } from "@cloudbox/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { countingD1 } from "./counting-d1";
import { type SignedIn, seedSubscription, seedTenant, signInAs } from "./fixtures";

let admin: SignedIn;
let readOnly: SignedIn;
/** Session lookup + staff grants per request, measured the same way as subscriptions.test.ts. */
let AUTH_ROUND_TRIPS = 0;

beforeAll(async () => {
  admin = await signInAs(env, { email: "wt13-admin@example.test", staffRole: "admin" });
  readOnly = await signInAs(env, { email: "wt13-reader@example.test", staffRole: "read_only" });
  const counted = countingD1(env.DB);
  await app.request("/api/v1/auth/session", { headers: admin.headers }, { ...env, DB: counted });
  AUTH_ROUND_TRIPS = counted.roundTrips;
});

function call(
  method: string,
  path: string,
  body?: unknown,
  opts: { as?: SignedIn | null; env?: typeof env } = {},
) {
  const who = opts.as === undefined ? admin : opts.as;
  return app.request(
    `/api/v1${path}`,
    {
      method,
      headers: { "content-type": "application/json", ...(who?.headers ?? {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    opts.env ?? env,
  );
}

let seq = 0;
function uniqueCode(): string {
  seq += 1;
  return `wt13-plan-${Date.now().toString(36)}${seq}`;
}

function uniqueEmail(): string {
  seq += 1;
  return `wt13-tenant-${Date.now().toString(36)}${seq}@example.test`;
}

async function createPlan(overrides: Record<string, unknown> = {}) {
  const body = {
    code: uniqueCode(),
    name: "Test Plan",
    maxDevices: 2,
    maxManagedUsers: 4,
    features: ["remote_access"],
    offlineGraceDays: 5,
    renewalWarningDays: 20,
    termDays: 365,
    ...overrides,
  };
  const response = await call("POST", "/plans", body);
  expect(response.status).toBe(201);
  return ((await response.json()) as { plan: Plan }).plan;
}

async function auditFor(entityId: string) {
  const { results } = await env.DB.prepare(
    "SELECT event_type, before_json, after_json FROM audit_log WHERE entity_type = 'plan' AND entity_id = ? ORDER BY rowid",
  )
    .bind(entityId)
    .all<{ event_type: string; before_json: string | null; after_json: string | null }>();
  return results.map((row) => ({
    eventType: row.event_type,
    before: row.before_json ? JSON.parse(row.before_json) : null,
    after: row.after_json ? JSON.parse(row.after_json) : null,
  }));
}

describe("plan CRUD", () => {
  it("creates a plan, defaults status to active, and audits PLAN_CREATED", async () => {
    const code = uniqueCode();
    const plan = await createPlan({ code, description: "A test plan" });
    expect(plan).toMatchObject({
      code,
      name: "Test Plan",
      description: "A test plan",
      status: "active",
      termDays: 365,
    });

    const events = await auditFor(code);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "PLAN_CREATED", before: null, after: { code } });
  });

  it("rejects an invalid code slug (uppercase, too short, bad characters)", async () => {
    for (const bad of ["AB", "ab", "Has_Underscore", "x".repeat(40)]) {
      const response = await call("POST", "/plans", {
        code: bad,
        name: "x",
        maxDevices: 1,
        maxManagedUsers: 1,
        features: [],
        offlineGraceDays: 0,
        renewalWarningDays: 30,
        termDays: 365,
      });
      expect(response.status, `code ${bad}`).toBe(400);
    }
  });

  it("rejects an unknown feature and out-of-range limits", async () => {
    const base = {
      code: uniqueCode(),
      name: "x",
      maxDevices: 1,
      maxManagedUsers: 1,
      offlineGraceDays: 0,
      renewalWarningDays: 30,
      termDays: 365,
    };
    expect((await call("POST", "/plans", { ...base, features: ["not_a_feature"] })).status).toBe(
      400,
    );
    expect((await call("POST", "/plans", { ...base, maxDevices: 0, features: [] })).status).toBe(
      400,
    );
    expect(
      (await call("POST", "/plans", { ...base, offlineGraceDays: 91, features: [] })).status,
    ).toBe(400);
    expect((await call("POST", "/plans", { ...base, termDays: 3651, features: [] })).status).toBe(
      400,
    );
  });

  it("rejects a duplicate code with 409", async () => {
    const code = uniqueCode();
    await createPlan({ code });
    const response = await call("POST", "/plans", {
      code,
      name: "dup",
      maxDevices: 1,
      maxManagedUsers: 1,
      features: [],
      offlineGraceDays: 0,
      renewalWarningDays: 30,
      termDays: 365,
    });
    expect(response.status).toBe(409);
  });

  it("code is immutable: PATCH ignores a code field and audits before/after", async () => {
    const plan = await createPlan();
    const response = await call("PATCH", `/plans/${plan.code}`, {
      code: "should-not-apply",
      name: "Renamed",
      maxDevices: 9,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { plan: Plan };
    expect(body.plan.code).toBe(plan.code);
    expect(body.plan.name).toBe("Renamed");
    expect(body.plan.maxDevices).toBe(9);

    const events = await auditFor(plan.code);
    const updated = events.at(-1);
    expect(updated).toMatchObject({
      eventType: "PLAN_UPDATED",
      before: { name: "Test Plan", maxDevices: 2 },
      after: { name: "Renamed", maxDevices: 9 },
    });
  });

  it("PATCH requires at least one field and 404s on an unknown code", async () => {
    const plan = await createPlan();
    expect((await call("PATCH", `/plans/${plan.code}`, {})).status).toBe(400);
    expect((await call("PATCH", "/plans/does-not-exist", { name: "x" })).status).toBe(404);
  });
});

describe("plan lifecycle: retire and reactivate", () => {
  it("retiring blocks the plan for a new tenant (409 plan_retired)", async () => {
    const plan = await createPlan();
    expect((await call("POST", `/plans/${plan.code}/retire`)).status).toBe(200);

    const response = await call("POST", "/tenants", {
      displayName: "Retired Plan Tenant",
      primaryContactEmail: uniqueEmail(),
      planCode: plan.code,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "plan_retired" });
  });

  it("retiring blocks the plan for a new subscription (409 plan_retired)", async () => {
    const plan = await createPlan();
    const { tenantId } = await seedTenant(env.DB, {});
    expect((await call("POST", `/plans/${plan.code}/retire`)).status).toBe(200);

    const response = await call("POST", `/tenants/${tenantId}/subscriptions`, {
      planCode: plan.code,
      validFrom: new Date().toISOString(),
      validUntil: new Date(Date.now() + 365 * 86_400_000).toISOString(),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "plan_retired" });
  });

  it("retiring does not disturb an existing subscription already on the plan", async () => {
    const plan = await createPlan();
    const { tenantId } = await seedTenant(env.DB, {});
    const { subscriptionId } = await seedSubscription(env.DB, { tenantId, planCode: plan.code });

    const retireResponse = await call("POST", `/plans/${plan.code}/retire`);
    expect(retireResponse.status).toBe(200);
    const retireBody = (await retireResponse.json()) as { subscriptionCount: number };
    expect(retireBody.subscriptionCount).toBe(1);

    // The existing subscription is untouched and keeps working (still readable, still editable).
    const list = await call("GET", `/tenants/${tenantId}/subscriptions`);
    const { items } = (await list.json()) as { items: Array<{ id: string; planCode: string }> };
    expect(items.find((i) => i.id === subscriptionId)?.planCode).toBe(plan.code);

    const patch = await call("PATCH", `/subscriptions/${subscriptionId}`, {
      renewalWarningDays: 45,
    });
    expect(patch.status).toBe(200);
  });

  it("cannot update a tenant to a retired plan either", async () => {
    const plan = await createPlan();
    const { tenantId } = await seedTenant(env.DB, {});
    expect((await call("POST", `/plans/${plan.code}/retire`)).status).toBe(200);

    const response = await call("PATCH", `/tenants/${tenantId}`, { planCode: plan.code });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "plan_retired" });
  });

  it("retiring twice is a 409, not a silent 200; reactivate un-blocks selection", async () => {
    const plan = await createPlan();
    expect((await call("POST", `/plans/${plan.code}/retire`)).status).toBe(200);
    const again = await call("POST", `/plans/${plan.code}/retire`);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "already_retired" });

    const reactivate = await call("POST", `/plans/${plan.code}/reactivate`);
    expect(reactivate.status).toBe(200);
    const reactivateBody = (await reactivate.json()) as { plan: Plan };
    expect(reactivateBody.plan.status).toBe("active");
    expect((await call("POST", `/plans/${plan.code}/reactivate`)).status).toBe(409);

    const createResponse = await call("POST", "/tenants", {
      displayName: "Reactivated Plan Tenant",
      primaryContactEmail: uniqueEmail(),
      planCode: plan.code,
    });
    expect(createResponse.status).toBe(201);

    const events = await auditFor(plan.code);
    expect(events.map((e) => e.eventType)).toEqual(
      expect.arrayContaining(["PLAN_RETIRED", "PLAN_REACTIVATED"]),
    );
  });

  it("retire/reactivate 404 on an unknown code", async () => {
    expect((await call("POST", "/plans/does-not-exist/retire")).status).toBe(404);
    expect((await call("POST", "/plans/does-not-exist/reactivate")).status).toBe(404);
  });

  it("a retired plan is excluded from the default GET /plans list but included with ?include=retired", async () => {
    const plan = await createPlan();
    expect((await call("POST", `/plans/${plan.code}/retire`)).status).toBe(200);

    const defaultList = await call("GET", "/plans");
    const defaultCodes = ((await defaultList.json()) as { items: Plan[] }).items.map((p) => p.code);
    expect(defaultCodes).not.toContain(plan.code);

    const withRetired = await call("GET", "/plans?include=retired");
    const retiredCodes = ((await withRetired.json()) as { items: Plan[] }).items.map((p) => p.code);
    expect(retiredCodes).toContain(plan.code);
  });
});

describe("permission boundary", () => {
  it("anonymous gets 401 on every plans route", async () => {
    const plan = await createPlan();
    const routes: [string, string, unknown?][] = [
      ["GET", "/plans"],
      ["GET", "/plans?include=retired"],
      ["POST", "/plans", {}],
      ["PATCH", `/plans/${plan.code}`, {}],
      [`POST`, `/plans/${plan.code}/retire`],
      [`POST`, `/plans/${plan.code}/reactivate`],
      ["GET", "/screens/plans"],
    ];
    for (const [method, path, body] of routes) {
      const response = await call(method, path, body, { as: null });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });

  it("read_only can read active plans but not retired, and cannot write", async () => {
    const plan = await createPlan();

    expect((await call("GET", "/plans", undefined, { as: readOnly })).status).toBe(200);
    expect((await call("GET", "/plans?include=retired", undefined, { as: readOnly })).status).toBe(
      403,
    );
    expect((await call("GET", "/screens/plans", undefined, { as: readOnly })).status).toBe(403);

    for (const [method, path, body] of [
      ["POST", "/plans", {}],
      ["PATCH", `/plans/${plan.code}`, {}],
      ["POST", `/plans/${plan.code}/retire`],
      ["POST", `/plans/${plan.code}/reactivate`],
    ] as [string, string, unknown?][]) {
      const response = await call(method, path, body, { as: readOnly });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden" });
    }
  });
});

describe("GET /api/v1/screens/plans", () => {
  it("loads within the round-trip ceiling and reports subscription counts", async () => {
    const plan = await createPlan();
    const { tenantId } = await seedTenant(env.DB, {});
    await seedSubscription(env.DB, { tenantId, planCode: plan.code });

    const counted = countingD1(env.DB);
    const response = await call("GET", "/screens/plans", undefined, {
      env: { ...env, DB: counted },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as PlansScreen;
    const item = body.items.find((i) => i.code === plan.code);
    expect(item?.subscriptionCount).toBe(1);
    // The loader itself is one db.batch() round trip; the rest is the permission gate's own
    // session/grant lookup (fast-data-hydration "≤3 D1 round trips").
    expect(counted.roundTrips).toBeLessThanOrEqual(1 + AUTH_ROUND_TRIPS);
  });
});

describe("invalid timezone (server-side IANA validation)", () => {
  it("rejects an invalid timezone on tenant create with 400 invalid_timezone", async () => {
    const response = await call("POST", "/tenants", {
      displayName: "Bad TZ Tenant",
      primaryContactEmail: uniqueEmail(),
      timezone: "Not/A_Real_Zone",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_timezone" });
  });

  it("accepts a real IANA zone on create", async () => {
    const response = await call("POST", "/tenants", {
      displayName: "Good TZ Tenant",
      primaryContactEmail: uniqueEmail(),
      timezone: "Asia/Kolkata",
    });
    expect(response.status).toBe(201);
  });

  it("rejects an invalid timezone on tenant update with 400 invalid_timezone", async () => {
    const { tenantId } = await seedTenant(env.DB, {});
    const response = await call("PATCH", `/tenants/${tenantId}`, { timezone: "Nope/Nope" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_timezone" });
  });
});
