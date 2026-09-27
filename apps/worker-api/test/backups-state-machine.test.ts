import { describe, expect, it } from "vitest";
import {
  isTerminal,
  isValidClientTransition,
  isValidServerTransition,
} from "../src/backups/state-machine";

describe("backups state machine", () => {
  it("accepts the client-facing happy path", () => {
    expect(isValidClientTransition("created", "verified_local")).toBe(true);
    expect(isValidClientTransition("verified_local", "upload_started")).toBe(true);
  });

  it("rejects a client skipping local verification", () => {
    expect(isValidClientTransition("created", "upload_started")).toBe(false);
    expect(isValidClientTransition("created", "cloud_verified")).toBe(false);
  });

  it("never lets a client claim a cloud state directly", () => {
    for (const from of ["created", "verified_local", "upload_started"] as const) {
      expect(isValidClientTransition(from, "upload_completed")).toBe(false);
      expect(isValidClientTransition(from, "cloud_verified")).toBe(false);
      expect(isValidClientTransition(from, "retention_applied")).toBe(false);
    }
  });

  it("lets a client fail from any non-terminal state", () => {
    for (const from of [
      "created",
      "verified_local",
      "upload_started",
      "upload_completed",
    ] as const) {
      expect(isValidClientTransition(from, "failed")).toBe(true);
    }
  });

  it("has no transitions out of a terminal state", () => {
    expect(isValidClientTransition("failed", "created")).toBe(false);
    expect(isValidClientTransition("retention_applied", "cloud_verified")).toBe(false);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("retention_applied")).toBe(true);
    expect(isTerminal("cloud_verified")).toBe(false);
  });

  it("server transitions can reach cloud states the client cannot", () => {
    expect(isValidServerTransition("upload_started", "cloud_verified")).toBe(true);
    expect(isValidServerTransition("upload_started", "upload_completed")).toBe(true);
    expect(isValidServerTransition("cloud_verified", "retention_applied")).toBe(true);
  });
});
