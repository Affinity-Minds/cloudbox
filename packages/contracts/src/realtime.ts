// Owner: WT-16. Wire shapes for the FleetPresence Durable Object's WebSocket feed
// (`GET /api/v1/realtime/fleet`, spec §5.3, §16, §29). Ephemeral presence only — durable state
// (device rows, entitlements, audit) stays in D1 and is read through the existing Fleet screens.
import { z } from "zod";
import { LicenseState } from "./devices";

/** One device's live presence row. Matches the FleetPresence DO's stored shape minus `tenantId`
 * (the client already knows which tenant/global feed it subscribed to). */
export const PresenceDevice = z.object({
  deviceId: z.string(),
  online: z.boolean(),
  lastSeenAt: z.string(),
  agentVersion: z.string().nullable(),
  /** Coarse: `active` when a live (non-revoked) entitlement exists, else `none`. The Fleet
   * screen loader remains the source of truth for the finer `expired` distinction (needs
   * `validUntil`, which the heartbeat hot path does not read again to stay inside the D1
   * round-trip budget — agent-notes fast-data-hydration.md). */
  licenseState: LicenseState,
  activeSessions: z.number().int().min(0).nullable(),
  updatedAt: z.string(),
});
export type PresenceDevice = z.infer<typeof PresenceDevice>;

/** Sent once, immediately after the WebSocket connects. */
export const PresenceSnapshotMessage = z.object({
  type: z.literal("snapshot"),
  devices: z.array(PresenceDevice),
});
export type PresenceSnapshotMessage = z.infer<typeof PresenceSnapshotMessage>;

/** Sent on every later change: a heartbeat (any field may have moved) or an offline transition. */
export const PresenceDeltaMessage = z.object({
  type: z.literal("delta"),
  device: PresenceDevice,
});
export type PresenceDeltaMessage = z.infer<typeof PresenceDeltaMessage>;

export const PresenceMessage = z.union([PresenceSnapshotMessage, PresenceDeltaMessage]);
export type PresenceMessage = z.infer<typeof PresenceMessage>;
