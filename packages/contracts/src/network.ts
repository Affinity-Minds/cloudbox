// Owner: WT-9. NetBird controller adapter contracts (ADR 0007). Everything here is additive: no
// existing field on `EnrollResponse`/`HeartbeatResponse`/`FleetDetailScreen` changed shape.
import { z } from "zod";

export const NETWORK_PEER_KINDS = ["server", "client", "support"] as const;
export const NetworkPeerKind = z.enum(NETWORK_PEER_KINDS);
export type NetworkPeerKind = z.infer<typeof NetworkPeerKind>;

/** `not_configured`: `NETBIRD_API_URL` unset, the controller never called out. `pending`: a
 * setup key was minted but the peer has not joined (or, for a `support` row, joined but not yet
 * observed). `active`/`revoked` follow normally. */
export const NETWORK_PEER_STATUSES = ["not_configured", "pending", "active", "revoked"] as const;
export const NetworkPeerStatus = z.enum(NETWORK_PEER_STATUSES);
export type NetworkPeerStatus = z.infer<typeof NetworkPeerStatus>;

/** `network` field on `POST /agent/enroll`'s 201 (additive on `EnrollResponse`, WT-9): present
 * only when NetBird is configured. The Windows agent (WT-4/WT-10) installs the NetBird client
 * with this and joins silently — the customer never sees a setup key or management URL. */
export const AgentNetworkInfo = z.object({
  setupKey: z.string(),
  managementUrl: z.string(),
});
export type AgentNetworkInfo = z.infer<typeof AgentNetworkInfo>;

/** `GET /api/v1/connect/devices/:deviceId/network` (customer session + active membership). One
 * client setup key per call — the previous one (if unused) is left to expire; the client only
 * ever needs its most recent key. */
export const ClientNetworkResponse = z.object({
  setupKey: z.string(),
  managementUrl: z.string(),
  expiresAt: z.string(),
});
export type ClientNetworkResponse = z.infer<typeof ClientNetworkResponse>;

/** Fleet detail "Network" tab row (additive to `FleetDetailScreen.network`, WT-9). Never carries
 * the setup key itself — only status, for staff visibility. */
export const FleetNetworkPeer = z.object({
  id: z.string(),
  kind: NetworkPeerKind,
  status: NetworkPeerStatus,
  netbirdPeerId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type FleetNetworkPeer = z.infer<typeof FleetNetworkPeer>;
