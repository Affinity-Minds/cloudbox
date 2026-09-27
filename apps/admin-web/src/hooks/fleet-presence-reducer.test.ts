import type { PresenceDevice } from "@cloudbox/contracts";
import { describe, expect, it } from "vitest";
import { applyPresenceMessage, initialPresenceState } from "./fleet-presence-reducer";

function device(overrides: Partial<PresenceDevice> = {}): PresenceDevice {
  return {
    deviceId: "dev_1",
    online: true,
    lastSeenAt: "2026-09-27T00:00:00.000Z",
    agentVersion: "1.0.0",
    licenseState: "active",
    activeSessions: 1,
    updatedAt: "2026-09-27T00:00:00.000Z",
    ...overrides,
  };
}

describe("applyPresenceMessage", () => {
  it("starts empty", () => {
    expect(initialPresenceState).toEqual({});
  });

  it("a snapshot replaces the whole map", () => {
    const seeded = applyPresenceMessage(
      { dev_stale: device({ deviceId: "dev_stale" }) },
      { type: "snapshot", devices: [device({ deviceId: "dev_1" }), device({ deviceId: "dev_2" })] },
    );
    expect(Object.keys(seeded).sort()).toEqual(["dev_1", "dev_2"]);
  });

  it("a delta upserts exactly one device without touching the rest", () => {
    const afterSnapshot = applyPresenceMessage(initialPresenceState, {
      type: "snapshot",
      devices: [device({ deviceId: "dev_1" }), device({ deviceId: "dev_2", online: false })],
    });
    const afterDelta = applyPresenceMessage(afterSnapshot, {
      type: "delta",
      device: device({ deviceId: "dev_2", online: true, activeSessions: 3 }),
    });
    expect(afterDelta.dev_1).toEqual(afterSnapshot.dev_1);
    expect(afterDelta.dev_2).toMatchObject({ online: true, activeSessions: 3 });
  });

  it("a delta for an unseen device adds it (an offline->online transition can arrive before any snapshot did)", () => {
    const state = applyPresenceMessage(initialPresenceState, {
      type: "delta",
      device: device({ deviceId: "dev_new" }),
    });
    expect(state.dev_new).toBeDefined();
  });

  it("applying the same delta twice is idempotent", () => {
    const once = applyPresenceMessage(initialPresenceState, {
      type: "delta",
      device: device(),
    });
    const twice = applyPresenceMessage(once, { type: "delta", device: device() });
    expect(twice).toEqual(once);
  });
});
