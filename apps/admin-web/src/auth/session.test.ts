import { describe, expect, it } from "vitest";
import { challengeSiteKey, describeAuthError } from "@/api/auth";
import { ApiError } from "@/api/client";
import { safeRedirect, withBase } from "./session";

describe("safeRedirect", () => {
  it("keeps same-app paths and refuses everything else", () => {
    expect(safeRedirect("/audit?cursor=5")).toBe("/audit?cursor=5");
    expect(safeRedirect("//evil.example/x")).toBe("/");
    expect(safeRedirect("https://evil.example")).toBe("/");
    expect(safeRedirect("/login?redirect=/")).toBe("/");
    expect(safeRedirect(undefined)).toBe("/");
    expect(safeRedirect("/\\evil.example")).toBe("/");
    expect(safeRedirect("/\t/evil.example")).toBe("/");
    expect(safeRedirect("/%5Cevil.example", "https://box.affinity.ai.in")).toBe("/%5Cevil.example");
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

describe("Turnstile step-up (review T-1)", () => {
  it("recognises the challenge answer and the cooldown fallback", () => {
    const challenge = new ApiError(403, "challenge_required", { siteKey: "0x4AAA" });
    expect(challengeSiteKey(challenge)).toBe("0x4AAA");
    expect(challengeSiteKey(new ApiError(403, "challenge_required", { siteKey: null }))).toBeNull();
    expect(challengeSiteKey(new ApiError(400, "invalid_otp"))).toBeNull();
    expect(describeAuthError(new ApiError(429, "account_cooldown"))).toMatch(/15 minutes/);
  });
});

describe("withBase (ops console under OPS_BASE_PATH)", () => {
  it("prefixes app paths with the router basepath", () => {
    expect(withBase("/ops", "/")).toBe("/ops");
    expect(withBase("/ops", "/tenants?x=1")).toBe("/ops/tenants?x=1");
    expect(withBase("/", "/portal")).toBe("/portal");
    expect(withBase(undefined, "/")).toBe("/");
  });
});
