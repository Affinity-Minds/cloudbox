import { describe, expect, it } from "vitest";
import { regionOf, timezoneMatches } from "./timezones";

describe("timezoneMatches", () => {
  it("matches by substring anywhere in the IANA name", () => {
    expect(timezoneMatches("Asia/Kolkata", "kolkata")).toBe(true);
    expect(timezoneMatches("Asia/Kolkata", "Asia/")).toBe(true);
    expect(timezoneMatches("Asia/Kolkata", "asia/")).toBe(true);
    expect(timezoneMatches("America/New_York", "new_york")).toBe(true);
  });

  it("matches by a known abbreviation, case-insensitively", () => {
    expect(timezoneMatches("Asia/Kolkata", "ist")).toBe(true);
    expect(timezoneMatches("Asia/Kolkata", "IST")).toBe(true);
    expect(timezoneMatches("America/New_York", "est")).toBe(true);
    expect(timezoneMatches("America/Los_Angeles", "pacific")).toBe(true);
  });

  it("matches a legacy IANA alias's canonical name (a runtime may list either spelling)", () => {
    expect(timezoneMatches("Asia/Calcutta", "kolkata")).toBe(true);
    expect(timezoneMatches("Asia/Kolkata", "calcutta")).toBe(true);
    expect(timezoneMatches("Asia/Calcutta", "ist")).toBe(true);
  });

  it("does not match an abbreviation belonging to a different zone", () => {
    expect(timezoneMatches("Asia/Tokyo", "ist")).toBe(false);
    expect(timezoneMatches("Europe/London", "kolkata")).toBe(false);
  });

  it("an empty query matches everything", () => {
    expect(timezoneMatches("Asia/Kolkata", "")).toBe(true);
    expect(timezoneMatches("Asia/Kolkata", "   ")).toBe(true);
  });

  it("a query with no match returns false", () => {
    expect(timezoneMatches("Asia/Kolkata", "nonexistent-zone")).toBe(false);
  });
});

describe("regionOf", () => {
  it("splits on the first slash", () => {
    expect(regionOf("Asia/Kolkata")).toBe("Asia");
    expect(regionOf("America/Argentina/Buenos_Aires")).toBe("America");
  });

  it("falls back to Other for a bare zone", () => {
    expect(regionOf("UTC")).toBe("Other");
  });
});
