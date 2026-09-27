// Permission-boundary matrix, generated from the live route table (`hono`'s `app.routes`) so it
// self-updates as routes land — nobody maintains a hand-written list here. See
// docs/handoffs/foundation.md "Server layout" for the mount prefixes this enumerates.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import v1 from "../src/routes/v1";
import { signInAs } from "./fixtures";

/**
 * Routes that are intentionally exempt from the 401/403 checks below:
 *  - unversioned or index routes with no auth story of their own
 *  - `/api/auth/*`: Better Auth's own handler, not a `/api/v1` route
 *  - `/api/v1/agent/*`: device-Bearer auth, not staff/session auth — covered by WT-3's own tests
 *  - `/api/v1/releases/assigned`, `/:id/download`, `/:id/result`: device-Bearer auth mixed into
 *    the same router as WT-18's staff routes (so a path-prefix exemption would also hide those) —
 *    covered by test/releases.test.ts, same rationale as `/api/v1/agent/*` above
 *  - any route whose current handler is still the foundation's `{ module, status: 'stub' }`
 *    placeholder, which answers 200 to everything until its owner implements it
 */
const DEVICE_BEARER_ROUTES = new Set([
  "/api/v1/releases/assigned",
  "/api/v1/releases/:id/download",
  "/api/v1/releases/:id/result",
]);

function isAllowlisted(path: string): boolean {
  if (path === "/api/v1" || path === "/api/v1/") return true;
  // WT-14: `/api/v1/onboarding/config` is public by design (the /start page's Turnstile site key).
  if (path === "/api/v1/onboarding/config") return true;
  if (DEVICE_BEARER_ROUTES.has(path)) return true;
  return ["/api/health", "/api/version", "/api/auth", "/api/v1/agent"].some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

/**
 * Routes gated only by `requireUser()` (any signed-in identity), not by a specific permission or
 * tenant standing, because the action is inherently self-service — every role, including
 * `read_only`, is meant to succeed. `POST /api/v1/auth/logout`: ending your own session is not a
 * "manage" action; nothing about `read_only` should forbid it. `POST /api/v1/me/active-tenant`:
 * picking which of *your own* memberships is active is gated only by membership in that tenant
 * (re-resolved server-side every call, WT-2), never by a staff permission or tenant standing.
 * Extend this list only with the same justification, never to silence a real gap.
 */
const SELF_SERVICE_ROUTES = new Set([
  "POST /api/v1/auth/logout",
  "POST /api/v1/me/active-tenant",
  // WT-14 (ADR 0011): customer self-service onboarding. Customer session only (a staff session,
  // read_only included, is 401 by the two-identity-systems rule); the activation grant is further
  // gated by Owner/Admin standing on the body's tenant, re-resolved server-side.
  "POST /api/v1/onboarding/tenants",
  "POST /api/v1/onboarding/redeem",
  "POST /api/v1/onboarding/activation-grants",
]);

type RouteUnderTest = { method: string; path: string };

/**
 * Every `/api/v1/*` route Hono knows about, deduplicated, minus the allowlist above. Reads
 * `v1.routes` directly (not `app.routes`) so the `/api/v1` mount prefix is added once, uniformly.
 */
function enumerateRoutes(): RouteUnderTest[] {
  const seen = new Set<string>();
  const routes: RouteUnderTest[] = [];
  for (const route of v1.routes) {
    if (route.method === "ALL") continue; // not a single HTTP verb to probe
    const path = `/api/v1${route.path === "/" ? "" : route.path}`;
    if (isAllowlisted(path)) continue;
    const key = `${route.method} ${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({ method: route.method, path });
  }
  return routes;
}

/**
 * A route whose handler is still the foundation's stub answers `{ module, status: 'stub' }` with
 * a 200, to any request, with no auth. Any route this returns true for has no permission gate to
 * test yet — its owner has not wired `requirePermission`/`requireTenantStanding` in. Probing it
 * would just assert today's placeholder, not tomorrow's contract, so it is skipped (not failed).
 */
async function isUnimplementedStub(
  route: RouteUnderTest,
  headers: Record<string, string> = {},
): Promise<boolean> {
  const response = await app.request(requestPath(route), { method: route.method, headers }, env);
  if (response.status !== 200) return false;
  const body = await response.json().catch(() => null);
  return Boolean(
    body && typeof body === "object" && (body as Record<string, unknown>).status === "stub",
  );
}

function requestPath(route: RouteUnderTest): string {
  // Path params (`:tenantId`, `:id`, …) need a syntactically valid value to reach the handler
  // instead of a router 404; the value's realism does not matter for an auth-boundary probe.
  return route.path.replace(/:([A-Za-z]+)/g, (_match, name: string) =>
    String(name).toLowerCase().includes("tenant") ? "ten_probe" : "probe-id",
  );
}

describe("permission-boundary matrix", () => {
  it("every non-stub /api/v1 route is present in the enumeration (sanity check)", () => {
    const routes = enumerateRoutes();
    expect(routes.length).toBeGreaterThan(0);
  });

  it("unauthenticated requests get 401 on every implemented route", async () => {
    const routes = enumerateRoutes();
    const failures: string[] = [];

    for (const route of routes) {
      if (await isUnimplementedStub(route)) continue;

      const response = await app.request(requestPath(route), { method: route.method }, env);
      if (response.status !== 401) {
        failures.push(`${route.method} ${route.path} → ${response.status}, want 401`);
      }
    }

    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("read_only staff gets 403 on every implemented non-GET, non-self-service route", async () => {
    const { headers } = await signInAs(env, {
      email: "permission-matrix.read-only@example.test",
      staffRole: "read_only",
    });
    const routes = enumerateRoutes().filter((route) => route.method !== "GET");
    const failures: string[] = [];

    for (const route of routes) {
      const key = `${route.method} ${route.path}`;
      if (SELF_SERVICE_ROUTES.has(key)) continue;
      if (await isUnimplementedStub(route, headers)) continue;

      const response = await app.request(
        requestPath(route),
        { method: route.method, headers },
        env,
      );
      if (response.status !== 403) {
        failures.push(
          `${route.method} ${route.path} (as read_only) → ${response.status}, want 403`,
        );
      }
    }

    expect(failures, failures.join("\n")).toEqual([]);
  });
});

// WT-1 (owner decision, ADR 0002): staff and customers are two identity systems with nothing
// shared — separate tables, secrets, cookies and Better Auth mounts. A session of one never
// satisfies a route of the other, and neither mount exposes the other's endpoints.
describe("two identity systems never cross", () => {
  const TEST_ORIGIN = "http://localhost";

  it("staff cookie on /api/v1/me → 401; customer cookie on staff routes → 401", async () => {
    const staff = await signInAs(env, {
      email: "matrix.staff@example.test",
      staffRole: "super_admin",
    });
    const customer = await signInAs(env, { email: "matrix.customer@example.test" });

    const me = await app.request("/api/v1/me/tenants", { headers: staff.headers }, env);
    expect(me.status).toBe(401);
    for (const [method, path] of [
      ["GET", "/api/v1/screens/tenants"],
      ["POST", "/api/v1/tenants"],
      ["GET", "/api/v1/staff"],
      ["GET", "/api/v1/screens/audit"],
    ] as const) {
      const response = await app.request(path, { method, headers: customer.headers }, env);
      expect(response.status, `${method} ${path}`).toBe(401);
    }
    // Each side still works with its own session.
    expect(
      (await app.request("/api/v1/me/tenants", { headers: customer.headers }, env)).status,
    ).toBe(200);
    expect(
      (await app.request("/api/v1/screens/tenants", { headers: staff.headers }, env)).status,
    ).toBe(200);
  });

  it("the customer mount has no staff endpoint and the staff mount no customer endpoint", async () => {
    const post = (path: string) =>
      app.request(
        path,
        {
          method: "POST",
          headers: { "content-type": "application/json", origin: TEST_ORIGIN },
          body: JSON.stringify({ email: "x@example.test", password: "p".repeat(12), otp: "1" }),
        },
        env,
      );
    for (const path of [
      "/api/auth/sign-in/email",
      "/api/auth/two-factor/enable",
      "/api/auth/two-factor/verify-totp",
      "/api/auth/change-password",
    ]) {
      expect((await post(path)).status, path).toBe(404);
    }
    for (const path of [
      "/api/ops/auth/email-otp/send-verification-otp",
      "/api/ops/auth/sign-in/email-otp",
    ]) {
      expect((await post(path)).status, path).toBe(404);
    }
  });

  it("a staff session is never minted through the customer mount", async () => {
    // The staff identity exists only in staff_users; the customer system has no such person and
    // no password endpoint, so neither a code nor a password yields a staff (or any) session.
    await signInAs(env, { email: "matrix.staff2@example.test", staffRole: "admin" });
    const response = await app.request(
      "/api/auth/sign-in/email-otp",
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: TEST_ORIGIN },
        body: JSON.stringify({ email: "matrix.staff2@example.test", otp: "123456" }),
      },
      env,
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("set-cookie")).toBeNull();
    const customers = await env.DB.prepare(
      "SELECT count(*) AS n FROM customer_users WHERE email = 'matrix.staff2@example.test'",
    ).first<{ n: number }>();
    expect(customers?.n).toBe(0);
  });
});
