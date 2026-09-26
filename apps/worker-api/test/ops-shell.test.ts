// The discreet staff console (owner decision): only known console routes under OPS_BASE_PATH are
// marked as the ops shell; everything else is the ordinary SPA document, so the base cannot be
// confirmed by probing.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../src/env";
import app from "../src/index";
import { isOpsDocument, opsBasePath } from "../src/ops-shell";

const SPA = "<!doctype html><html><head><title>CloudBox</title></head><body></body></html>";
const assets = {
  fetch: async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/assets/"))
      return new Response("js", { headers: { "content-type": "text/javascript" } });
    return new Response(SPA, { headers: { "content-type": "text/html", etag: '"spa"' } });
  },
} as unknown as Fetcher;
const withAssets = (extra: Partial<Bindings> = {}): Bindings => ({
  ...env,
  ASSETS: assets,
  ...extra,
});

const get = async (path: string, e: Bindings = withAssets()) => {
  const response = await app.request(path, {}, e);
  return { status: response.status, body: await response.text(), headers: response.headers };
};

describe("ops shell", () => {
  it("marks console routes under the base, noindex, and nothing else", async () => {
    for (const path of [
      "/ops",
      "/ops/",
      "/ops/login",
      "/ops/tenants",
      "/ops/fleet/dev_1",
      "/ops/setup-authenticator",
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.body, path).toContain('<meta name="cloudbox-ops-base" content="/ops">');
      expect(res.body, path).toContain('<meta name="robots" content="noindex, nofollow">');
      expect(res.headers.get("x-robots-tag"), path).toBe("noindex, nofollow");
    }
  });

  it("unknown paths under the base look exactly like any other path", async () => {
    const plain = await get("/no-such-page");
    for (const path of ["/ops/zzz", "/ops/login/extra", "/opsx/login", "/login", "/portal"]) {
      const res = await get(path);
      expect(res.body, path).toBe(plain.body);
      expect(res.body, path).not.toContain("cloudbox-ops-base");
      expect(res.headers.get("x-robots-tag"), path).toBeNull();
    }
  });

  it("follows OPS_BASE_PATH and refuses a malformed one", async () => {
    const slug = withAssets({ OPS_BASE_PATH: "/k7f3a9-console" });
    expect((await get("/k7f3a9-console/login", slug)).body).toContain('content="/k7f3a9-console"');
    expect((await get("/ops/login", slug)).body).not.toContain("cloudbox-ops-base");
    expect(opsBasePath({ OPS_BASE_PATH: "/a/b" })).toBe("/ops");
    expect(opsBasePath({ OPS_BASE_PATH: "ops" })).toBe("/ops");
    expect(isOpsDocument("/ops/tenants/ten_1", "/ops")).toBe(true);
    expect(isOpsDocument("/ops/tenants/ten_1/x", "/ops")).toBe(false);
  });

  it("staff API responses are noindex; unknown API paths answer the ordinary 404", async () => {
    const staff = await app.request("/api/ops/auth/get-session", {}, env);
    expect(staff.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const unknownOps = await app.request("/api/ops/nope", {}, env);
    const unknown = await app.request("/api/nope", {}, env);
    expect(unknownOps.status).toBe(404);
    expect(await unknownOps.text()).toBe(await unknown.text());
    const version = await app.request("/api/version", {}, env);
    expect(version.status).toBe(200);
  });
});
