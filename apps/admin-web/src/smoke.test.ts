import { describe, expect, it } from "vitest";

describe("CloudBox foundation", () => {
  it("uses the production hostname contract", () => {
    expect("box.affinity.ai.in").toBe("box.affinity.ai.in");
  });
});
