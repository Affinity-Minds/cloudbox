import { z } from "zod";
import { KeyProtection, RsaPublicJwk } from "./devices";

/** `POST /api/v1/agent/enroll` body. */
export const EnrollRequest = z.object({
  token: z.string().min(16).max(256),
  device: z.object({
    hostname: z.string().min(1).max(255),
    windowsBuild: z.string().min(1).max(64),
    agentVersion: z.string().min(1).max(64),
    keyProtection: KeyProtection,
    publicKeyJwk: RsaPublicJwk,
  }),
});
export type EnrollRequest = z.infer<typeof EnrollRequest>;

/** `POST /api/v1/agent/enroll` → 201. `deviceToken` is the Bearer credential for every later call. */
export const EnrollResponse = z.object({
  deviceId: z.string(),
  tenantId: z.string(),
  tenantCode: z.string(),
  deviceName: z.string(),
  deviceToken: z.string(),
});
export type EnrollResponse = z.infer<typeof EnrollResponse>;

const State = z.string().min(1).max(64);

/**
 * Normalised agent health document (master spec §29). Keys are snake_case on the wire because
 * the Windows agent serialises them that way. Sections the agent cannot report yet are omitted.
 */
// Unknown values are null (the Windows Agent sends null for numbers/booleans it cannot determine yet;
// unknown *states* are the string "unknown"). Consumers render null as "unknown", never as 0.
export const AgentHealth = z.object({
  device: z.string(),
  agent: z.object({ version: z.string(), healthy: z.boolean() }),
  license: z
    .object({ state: State, days_remaining: z.number().int().nullable().optional() })
    .optional(),
  network: z.object({ state: State }).optional(),
  rdp: z.object({ state: State, listener: z.boolean().nullable() }).optional(),
  users: z
    .object({
      configured: z.number().int().min(0).nullable(),
      limit: z.number().int().min(0).nullable(),
      active_sessions: z.number().int().min(0).nullable(),
    })
    .optional(),
  backup: z.object({ state: State, last_success: z.string().nullable().optional() }).optional(),
  storage: z.object({ free_bytes: z.number().int().min(0).nullable() }).optional(),
  updates: z.object({ state: State, reboot_required: z.boolean().nullable() }).optional(),
  security: z.object({ device_key: KeyProtection, tamper: State }).optional(),
});
export type AgentHealth = z.infer<typeof AgentHealth>;

/** `POST /api/v1/agent/heartbeat` body (Bearer deviceToken). */
export const HeartbeatRequest = z.object({ health: AgentHealth });
export type HeartbeatRequest = z.infer<typeof HeartbeatRequest>;

/** `POST /api/v1/agent/heartbeat` → 200. */
export const HeartbeatResponse = z.object({
  serverTime: z.string(),
  entitlementGeneration: z.number().int().nullable(),
  commands: z.array(z.unknown()),
});
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

/** `GET /api/v1/agent/entitlement` → 200 (404 when none issued). */
export const AgentEntitlementResponse = z.object({
  entitlement: z.string(),
  generation: z.number().int(),
});
export type AgentEntitlementResponse = z.infer<typeof AgentEntitlementResponse>;
