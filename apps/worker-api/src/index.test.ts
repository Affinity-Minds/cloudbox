import { describe, expect, it } from "vitest";
import app, { type Bindings } from "./index";

const env = { BUILD_SHA: "test", BUILD_TIME: "test" } as Bindings;

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
});
