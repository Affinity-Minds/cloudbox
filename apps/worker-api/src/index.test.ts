import { describe, expect, it } from "vitest";
import app from "./index";

describe("CloudBox API foundation", () => {
  it("serves health", async () => {
    const response = await app.request(
      "/api/health",
      {},
      { BUILD_SHA: "test", BUILD_TIME: "test" },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok" });
  });

  it("versions v1 responses", async () => {
    const response = await app.request("/api/v1", {}, { BUILD_SHA: "test", BUILD_TIME: "test" });
    expect(response.headers.get("X-API-Version")).toBe("v1");
  });

  it("reports the build stamp", async () => {
    const response = await app.request(
      "/api/version",
      {},
      { BUILD_SHA: "abc123", BUILD_TIME: "now" },
    );
    await expect(response.json()).resolves.toMatchObject({ gitSha: "abc123" });
  });
});
