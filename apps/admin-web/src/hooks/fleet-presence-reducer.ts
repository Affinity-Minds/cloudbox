// Owner: WT-16. Pure reducer for `useFleetPresence()` (use-fleet-presence.ts), split out so it
// can be unit tested without a WebSocket or a DOM (see fleet-presence-reducer.test.ts) — same
// pattern as `lib/session.ts`'s `safeRedirect`.
import type { PresenceDevice, PresenceMessage } from "@cloudbox/contracts";

export type PresenceState = Record<string, PresenceDevice>;

export const initialPresenceState: PresenceState = {};

/** A snapshot replaces the whole map (it is the server's full current view); a delta upserts one
 * device. Both are idempotent, so a duplicate or out-of-order delta (a repeat heartbeat) is safe
 * to apply more than once. */
export function applyPresenceMessage(
  state: PresenceState,
  message: PresenceMessage,
): PresenceState {
  if (message.type === "snapshot") {
    const next: PresenceState = {};
    for (const device of message.devices) next[device.deviceId] = device;
    return next;
  }
  return { ...state, [message.device.deviceId]: message.device };
}
