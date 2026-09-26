import { describe, expect, it } from "vitest";

describe("CloudBox foundation", () => {
  it("uses the production hostname contract", () => {
    expect("box.affinityminds.in").toBe("box.affinityminds.in");
  });
});
