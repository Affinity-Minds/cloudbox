import { describe, expect, it } from "vitest";
import { isReasonValid, reasonRequestBody } from "./reason-select";

describe("isReasonValid", () => {
  it("is invalid with no code chosen", () => {
    expect(isReasonValid({ code: "" })).toBe(false);
  });

  it("is valid for any non-other code, with or without text", () => {
    expect(isReasonValid({ code: "decommissioned" })).toBe(true);
    expect(isReasonValid({ code: "decommissioned", text: "ignored" })).toBe(true);
  });

  it('requires at least 5 characters of text when the code is "other"', () => {
    expect(isReasonValid({ code: "other" })).toBe(false);
    expect(isReasonValid({ code: "other", text: "" })).toBe(false);
    expect(isReasonValid({ code: "other", text: "    " })).toBe(false);
    expect(isReasonValid({ code: "other", text: "abcd" })).toBe(false);
    expect(isReasonValid({ code: "other", text: "abcde" })).toBe(true);
    expect(isReasonValid({ code: "other", text: "  abcde  " })).toBe(true);
  });
});

describe("reasonRequestBody", () => {
  it("carries only the code for a non-other reason, dropping any text", () => {
    expect(reasonRequestBody({ code: "decommissioned", text: "stray" })).toEqual({
      reasonCode: "decommissioned",
      reasonText: undefined,
    });
  });

  it("trims and carries the text for an other reason", () => {
    expect(reasonRequestBody({ code: "other", text: "  Hardware returned  " })).toEqual({
      reasonCode: "other",
      reasonText: "Hardware returned",
    });
  });
});
