import { describe, expect, it } from "vitest";
import { describeAuthError } from "@/api/auth";
import { ApiError } from "@/api/client";
import { safeRedirect } from "./session";

describe("safeRedirect", () => {
  it("keeps same-app paths and refuses everything else", () => {
    expect(safeRedirect("/audit?cursor=5")).toBe("/audit?cursor=5");
    expect(safeRedirect("//evil.example/x")).toBe("/");
    expect(safeRedirect("https://evil.example")).toBe("/");
    expect(safeRedirect("/login?redirect=/")).toBe("/");
    expect(safeRedirect(undefined)).toBe("/");
  });
});

describe("describeAuthError", () => {
  it("maps Better Auth codes and rate limits to plain text", () => {
    expect(describeAuthError(new ApiError(400, "invalid_otp"))).toMatch(/not right/);
    expect(describeAuthError(new ApiError(400, "otp_expired"))).toMatch(/expired/);
    expect(describeAuthError(new ApiError(403, "too_many_attempts"))).toMatch(/new one/);
    expect(describeAuthError(new ApiError(429, "http_429", { retryAfter: 42 }))).toMatch(/42 s/);
  });
});
