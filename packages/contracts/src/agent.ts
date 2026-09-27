import { z } from "zod";
import { KeyProtection, RsaPublicJwk } from "./devices";
import { AgentNetworkInfo } from "./network";

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

/**
 * Licence state the cloud reports to the agent (WT-14, ADR 0011). Optional on the wire so clients
 * built before it keep parsing: `licensed` (a live entitlement exists; fetch `GET /agent/entitlement`),
 * `no_active_plan` (no subscription, or none active and in date), `device_limit_reached` (the plan's
 * `max_devices` is used by other servers).
 */
export const AgentLicenseState = z.enum([
  "licensed",
  "no_active_plan",
  "device_limit_reached",
  // A staff licence revoke put the device on hold: nothing is issued until staff Issue again.
  "revoked",
]);
export type AgentLicenseState = z.infer<typeof AgentLicenseState>;

/** The exact text shown for `no_active_plan` (agent Status window, portal, Fleet). */
export const NO_ACTIVE_PLAN_MESSAGE = "No active plan found. Please contact the CloudBox admin.";
export const DEVICE_LIMIT_MESSAGE =
  "This plan's server limit is reached. Please contact the CloudBox admin.";
/** The exact text shown for `revoked` (a staff licence revoke; licence hold). */
export const LICENSE_REVOKED_MESSAGE = "Licence revoked by CloudBox. Contact the CloudBox admin.";

/** `POST /api/v1/agent/enroll` → 201. `deviceToken` is the Bearer credential for every later call. */
export const EnrollResponse = z.object({
  deviceId: z.string(),
  tenantId: z.string(),
  tenantCode: z.string(),
  deviceName: z.string(),
  deviceToken: z.string(),
  /** WT-14: activation redeems a pending plan and issues the entitlement; absent on older servers. */
  licenseState: AgentLicenseState.optional(),
  /** Human text for a state that needs action (e.g. `NO_ACTIVE_PLAN_MESSAGE`); absent when licensed. */
  message: z.string().optional(),
  /** WT-9 (ADR 0007): present only when the NetBird controller is configured; absent means the
   * cloud has no private-mesh server yet, so the agent skips the Netclient install. */
  network: AgentNetworkInfo.optional(),
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
  network: z
    .object({
      state: State,
      /**
       * WT-11 (additive, alpha LAN mode): the device's LAN address as the Agent sees it (e.g.
       * `192.168.1.42`), used by CloudBox Connect's `LanDirect` network to reach `mstsc` directly
       * on the same LAN. Null when unknown; absent on agents built before this field existed.
       */
      lan_address: z.string().min(1).max(255).nullable().optional(),
    })
    .optional(),
  rdp: z.object({ state: State, listener: z.boolean().nullable() }).optional(),
  users: z
    .object({
      configured: z.number().int().min(0).nullable(),
      limit: z.number().int().min(0).nullable(),
      active_sessions: z.number().int().min(0).nullable(),
    })
    .optional(),
  backup: z.object({ state: State, last_success: z.string().nullable().optional() }).optional(),
  storage: z
    .object({
      free_bytes: z.number().int().min(0).nullable(),
      /** WT-17 (additive, optional): needed to derive the §24 free-space percentage for the
       * `disk_low` alert; absent on older agents, in which case that alert is not evaluated. */
      total_bytes: z.number().int().min(0).nullable().optional(),
    })
    .optional(),
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
  /** WT-14 (optional, additive): see `AgentLicenseState`. */
  licenseState: AgentLicenseState.optional(),
  /** WT-14 (optional, additive): human text when the state needs action. */
  message: z.string().optional(),
});
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

/** `GET /api/v1/agent/entitlement` → 200 (404 when none issued). */
export const AgentEntitlementResponse = z.object({
  entitlement: z.string(),
  generation: z.number().int(),
});
export type AgentEntitlementResponse = z.infer<typeof AgentEntitlementResponse>;
