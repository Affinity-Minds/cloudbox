// Owner: WT-16. The one call `routes/v1/agent.ts`'s heartbeat handler makes into this module —
// after it has already written D1, best-effort: presence is ephemeral, so a DO error here must
// never fail (or even slow down noticeably) the heartbeat response itself.
import type { LicenseState } from "@cloudbox/contracts";
import type { Bindings } from "../env";
import { tenantPresenceStub } from "./fleet-presence";

export type HeartbeatPresence = {
  deviceId: string;
  tenantId: string;
  agentVersion: string | null;
  licenseState: LicenseState;
  activeSessions: number | null;
};

export async function notifyHeartbeatPresence(
  env: Bindings,
  presence: HeartbeatPresence,
): Promise<void> {
  try {
    await tenantPresenceStub(env, presence.tenantId).fetch(
      "https://fleet-presence.internal/presence",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(presence),
      },
    );
  } catch (error) {
    console.error("presence: heartbeat notify failed", presence.deviceId, error);
  }
}
