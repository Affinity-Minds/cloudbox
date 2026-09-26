import { z } from "zod";

export const DeviceStatus = z.enum(["enrolled", "revoked", "transferred"]);
export type DeviceStatus = z.infer<typeof DeviceStatus>;

export const KeyProtection = z.enum(["tpm", "software"]);
export type KeyProtection = z.infer<typeof KeyProtection>;

/** RSA public key as sent by the Windows agent (TPM-backed where available). */
export const RsaPublicJwk = z.object({
  kty: z.literal("RSA"),
  n: z.string().min(1),
  e: z.string().min(1),
});
export type RsaPublicJwk = z.infer<typeof RsaPublicJwk>;

export const Device = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string(),
  status: DeviceStatus,
  deviceKeyThumbprint: z.string(),
  keyProtection: KeyProtection,
  hostname: z.string(),
  windowsBuild: z.string().nullable(),
  agentVersion: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  lastHealth: z.unknown().nullable(),
  enrolledAt: z.string(),
  revokedAt: z.string().nullable(),
});
export type Device = z.infer<typeof Device>;

/** Row on `GET /api/v1/screens/fleet`. */
export const FleetListItem = Device.pick({
  id: true,
  tenantId: true,
  name: true,
  status: true,
  hostname: true,
  agentVersion: true,
  keyProtection: true,
  lastSeenAt: true,
  enrolledAt: true,
}).extend({
  tenantCode: z.string(),
  tenantName: z.string(),
  online: z.boolean(),
});
export type FleetListItem = z.infer<typeof FleetListItem>;
