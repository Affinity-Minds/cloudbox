import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import { signInAs } from "./auth-fixtures";

describe("CloudBox API foundation", () => {
  it("serves health", async () => {
    const response = await app.request("/api/health", {}, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok" });
  });

  it("versions v1 responses", async () => {
    const response = await app.request("/api/v1", {}, env);
    expect(response.headers.get("X-API-Version")).toBe("v1");
  });

  it("reports the build stamp", async () => {
    const response = await app.request(
      "/api/version",
      {},
      { ...env, BUILD_SHA: "abc123", BUILD_TIME: "now" },
    );
    await expect(response.json()).resolves.toMatchObject({ gitSha: "abc123" });
  });

  it("rejects unauthenticated foundation changes before touching D1", async () => {
    const response = await app.request(
      "/api/v1/foundation/release",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "deployed", sha: "abc123" }),
      },
      env,
    );
    expect(response.status).toBe(403);
  });

  it("records an audited release change with correlation id", async () => {
    const response = await app.request(
      "/api/v1/foundation/release",
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "X-CloudBox-Phase0-Key": "test-key",
          "X-Correlation-Id": "corr-test-0001",
        },
        body: JSON.stringify({ status: "deployed", sha: "abc123" }),
      },
      { ...env, PHASE0_ADMIN_KEY: "test-key" },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Correlation-Id")).toBe("corr-test-0001");

    const foundation = (await (await app.request("/api/v1/foundation", {}, env)).json()) as {
      release: { sha: string };
      audit: { eventType: string; actorId: string; after: { sha: string } }[];
    };
    expect(foundation.release.sha).toBe("abc123");
    expect(foundation.audit[0]).toMatchObject({
      eventType: "foundation.release.changed",
      actorId: "github-actions",
      after: { sha: "abc123" },
    });
  });

  it("mounts every module stub under /api/v1", async () => {
    const paths = {
      tenants: "/api/v1/tenants",
      memberships: "/api/v1/tenants/ten_x/memberships",
      me: "/api/v1/me",
      audit: "/api/v1/audit",
    };
    // Stubs answer only to staff (review M-1); the agent stub stays public for device auth (WT-3).
    const { headers } = await signInAs(env, {
      email: "stub-reader@example.test",
      staffRole: "read_only",
    });
    for (const [module, path] of Object.entries(paths)) {
      const response = await app.request(path, { headers }, env);
      expect(response.status, path).toBe(200);
      await expect(response.json()).resolves.toEqual({ module, status: "stub" });
    }
  });

  it("answers unknown API paths with the JSON error shape", async () => {
    const response = await app.request("/api/v1/nope", {}, env);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
  });
});
