// Permission-boundary matrix, generated from the live route table (`hono`'s `app.routes`) so it
// self-updates as routes land — nobody maintains a hand-written list here. See
// docs/handoffs/foundation.md "Server layout" for the mount prefixes this enumerates.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import v1 from "../src/routes/v1";

/**
 * Routes that are intentionally exempt from the 401/403 checks below:
 *  - unversioned or index routes with no auth story of their own
 *  - `/api/auth/*`: Better Auth's own handler, not a `/api/v1` route
 *  - `/api/v1/agent/*`: device-Bearer auth, not staff/session auth — covered by WT-3's own tests
 *  - any route whose current handler is still the foundation's `{ module, status: 'stub' }`
 *    placeholder, which answers 200 to everything until its owner implements it
 */
const ALLOWLIST_PREFIXES = ["/api/health", "/api/version", "/api/v1", "/api/auth", "/api/v1/agent"];

const EXACT_ALLOWLIST = new Set(["/api/v1", "/api/v1/"]);

function isAllowlisted(path: string): boolean {
  if (EXACT_ALLOWLIST.has(path)) return true;
  // "/api/v1" alone (the version index) is allowlisted, but this must not swallow every other
  // v1 route — only exact prefixes for auth and the agent device API are exempt beyond that.
  return ["/api/health", "/api/version", "/api/auth", "/api/v1/agent"].some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

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
 * A route whose handler is still the foundation's stub answers `{ module, status: 'stub' }` to
 * a plain GET with no auth. Any route this returns true for has no permission gate to test yet
 * — its owner has not wired `requirePermission`/`requireTenantStanding` in. Probing it for a 401
 * would just assert today's placeholder, not tomorrow's contract, so it is skipped (not failed).
 */
async function isUnimplementedStub(route: RouteUnderTest): Promise<boolean> {
  if (route.method !== "GET") return false;
  const response = await app.request(route.path, {}, env);
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

  describe("unauthenticated requests get 401", () => {
    it("enumerates and checks every implemented route", async () => {
      const routes = enumerateRoutes();
      const failures: string[] = [];

      for (const route of routes) {
        if (await isUnimplementedStub(route)) continue;

        const response = await app.request(
          requestPath(route),
          { method: route.method },
          env,
        );
        if (response.status !== 401) {
          failures.push(`${route.method} ${route.path} → ${response.status}, want 401`);
        }
      }

      expect(failures, failures.join("\n")).toEqual([]);
    });
  });

  // `signInAs` (test/fixtures.ts, owned by WT-1's test/auth-fixtures.ts) does not exist yet.
  // Once it lands, replace this whole block with a loop over `enumerateRoutes()` filtered to
  // non-GET methods, signed in as a seeded `read_only` staff member, asserting 403.
  describe.todo("read_only staff gets 403 on every non-GET route", () => {
    it.todo("enumerates and checks every implemented non-GET route as read_only staff");
  });
});
