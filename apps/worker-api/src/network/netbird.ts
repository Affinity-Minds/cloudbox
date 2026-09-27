// Owner: WT-9. Thin REST client over a self-hosted NetBird management server (ADR 0007). Models
// only the shapes CloudBox reads or writes (groups, policies, setup keys, peers) — verified against
// https://docs.netbird.io/api/resources/{setup-keys,groups,policies,peers} 2026-09-27, not guessed.
// Unknown response fields are simply not in the zod shape (no `.strict()`), so a NetBird upgrade
// that adds fields does not break parsing.
//
// The token is passed once, as the `Authorization` header value, and is never logged: thrown
// errors carry the method/path/status/body, never headers. `fetchImpl` is injectable (default the
// global `fetch`) so tests run a fake NetBird server without a real socket (agent-notes: the
// Workers test pool's module mocking is not reliable — dependency injection is the portable seam,
// same pattern as `email/providers/smtp.ts`).
import { z } from "zod";

export type NetbirdConfig = { apiUrl: string; apiToken: string };

/** `NETBIRD_API_URL` unset ⇒ null: every controller call becomes a no-op (deliverable #3). */
export function netbirdConfig(env: {
  NETBIRD_API_URL?: string;
  NETBIRD_API_TOKEN?: string;
}): NetbirdConfig | null {
  if (!env.NETBIRD_API_URL) return null;
  return { apiUrl: env.NETBIRD_API_URL.replace(/\/+$/, ""), apiToken: env.NETBIRD_API_TOKEN ?? "" };
}

/** The NetBird client/Netclient join against the management server's own origin (same host the
 * REST API is served from in a standard self-hosted install — Traefik fronts both). */
export function managementUrlFor(config: NetbirdConfig): string {
  return new URL(config.apiUrl).origin;
}

export class NetbirdApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "NetbirdApiError";
  }
}

const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 50;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson<T>(
  config: NetbirdConfig,
  fetchImpl: typeof fetch,
  method: string,
  path: string,
  schema: z.ZodType<T>,
  body?: unknown,
): Promise<T> {
  const url = `${config.apiUrl}${path}`;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Token ${config.apiToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      lastError = new NetbirdApiError(
        0,
        method,
        path,
        `network error contacting NetBird: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (attempt === MAX_ATTEMPTS) throw lastError;
      await delay(BASE_DELAY_MS * 2 ** (attempt - 1));
      continue;
    }

    // Retry on 5xx only — a 4xx will not change on retry (agent-notes "never invent retries that
    // hide a real failure"; the NetBird management server itself recommends this split).
    if (response.status >= 500) {
      const text = await response.text().catch(() => "");
      lastError = new NetbirdApiError(
        response.status,
        method,
        path,
        `NetBird ${method} ${path} → ${response.status}: ${text.slice(0, 500)}`,
      );
      if (attempt === MAX_ATTEMPTS) throw lastError;
      await delay(BASE_DELAY_MS * 2 ** (attempt - 1));
      continue;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new NetbirdApiError(
        response.status,
        method,
        path,
        `NetBird ${method} ${path} → ${response.status}: ${text.slice(0, 500)}`,
      );
    }

    if (response.status === 204) return undefined as T;
    const json = await response.json().catch(() => null);
    return schema.parse(json);
  }

  throw lastError instanceof Error
    ? lastError
    : new NetbirdApiError(0, method, path, "unreachable");
}

// ─── Shapes (only the fields CloudBox reads/writes) ──────────────────────────────────────────

export const NetbirdGroup = z.object({
  id: z.string(),
  name: z.string(),
  peers_count: z.number().optional(),
});
export type NetbirdGroup = z.infer<typeof NetbirdGroup>;

export const NETBIRD_POLICY_PROTOCOLS = ["tcp", "udp", "icmp", "all"] as const;

export const NetbirdPolicyRule = z.object({
  id: z.string().optional(),
  name: z.string(),
  description: z.string().optional(),
  enabled: z.boolean(),
  action: z.enum(["accept", "drop"]),
  bidirectional: z.boolean(),
  protocol: z.enum(NETBIRD_POLICY_PROTOCOLS),
  ports: z.array(z.string()).optional(),
  sources: z.array(z.string()).optional(),
  destinations: z.array(z.string()).optional(),
});
export type NetbirdPolicyRule = z.infer<typeof NetbirdPolicyRule>;

export const NetbirdPolicy = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  enabled: z.boolean(),
  rules: z.array(NetbirdPolicyRule),
});
export type NetbirdPolicy = z.infer<typeof NetbirdPolicy>;

export const NETBIRD_SETUP_KEY_TYPES = ["one-off", "reusable"] as const;

export const NetbirdSetupKey = z.object({
  id: z.string(),
  /** Full plaintext only on create; the list/get endpoints mask it (`"A6160****"`). */
  key: z.string().optional(),
  name: z.string(),
  type: z.enum(NETBIRD_SETUP_KEY_TYPES),
  expires: z.string().optional(),
  valid: z.boolean().optional(),
  revoked: z.boolean().optional(),
  used_times: z.number().optional(),
  auto_groups: z.array(z.string()),
  usage_limit: z.number().optional(),
});
export type NetbirdSetupKey = z.infer<typeof NetbirdSetupKey>;

export const NetbirdPeer = z.object({
  id: z.string(),
  name: z.string(),
  ip: z.string().optional(),
  connected: z.boolean().optional(),
  last_seen: z.string().optional(),
  groups: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
});
export type NetbirdPeer = z.infer<typeof NetbirdPeer>;

// ─── Client ────────────────────────────────────────────────────────────────────────────────────

export type NetbirdClient = {
  listGroups(): Promise<NetbirdGroup[]>;
  findGroupByName(name: string): Promise<NetbirdGroup | null>;
  createGroup(name: string): Promise<NetbirdGroup>;
  deleteGroup(id: string): Promise<void>;

  listPolicies(): Promise<NetbirdPolicy[]>;
  createPolicy(input: {
    name: string;
    description?: string;
    enabled: boolean;
    rules: NetbirdPolicyRule[];
  }): Promise<NetbirdPolicy>;
  updatePolicy(
    id: string,
    input: { name: string; description?: string; enabled: boolean; rules: NetbirdPolicyRule[] },
  ): Promise<NetbirdPolicy>;
  deletePolicy(id: string): Promise<void>;

  createSetupKey(input: {
    name: string;
    type: (typeof NETBIRD_SETUP_KEY_TYPES)[number];
    expiresIn: number;
    autoGroups: string[];
  }): Promise<NetbirdSetupKey>;
  revokeSetupKey(id: string, autoGroups: string[]): Promise<NetbirdSetupKey>;

  listPeers(): Promise<NetbirdPeer[]>;
  deletePeer(id: string): Promise<void>;
};

/** `fetchImpl` defaults to the global `fetch`; tests inject a fake capturing requests. */
export function createNetbirdClient(
  config: NetbirdConfig,
  fetchImpl: typeof fetch = fetch,
): NetbirdClient {
  const call = <T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown) =>
    requestJson(config, fetchImpl, method, path, schema, body);

  return {
    listGroups: () => call("GET", "/api/groups", z.array(NetbirdGroup)),
    async findGroupByName(name) {
      // `?name=` is an exact-match filter per the NetBird API docs.
      const groups = await call(
        "GET",
        `/api/groups?name=${encodeURIComponent(name)}`,
        z.array(NetbirdGroup),
      );
      return groups.find((g) => g.name === name) ?? null;
    },
    createGroup: (name) => call("POST", "/api/groups", NetbirdGroup, { name, peers: [] }),
    deleteGroup: (id) => call("DELETE", `/api/groups/${id}`, z.void()),

    listPolicies: () => call("GET", "/api/policies", z.array(NetbirdPolicy)),
    createPolicy: (input) => call("POST", "/api/policies", NetbirdPolicy, input),
    updatePolicy: (id, input) => call("PUT", `/api/policies/${id}`, NetbirdPolicy, input),
    deletePolicy: (id) => call("DELETE", `/api/policies/${id}`, z.void()),

    createSetupKey: (input) =>
      call("POST", "/api/setup-keys", NetbirdSetupKey, {
        name: input.name,
        type: input.type,
        expires_in: input.expiresIn,
        auto_groups: input.autoGroups,
        usage_limit: input.type === "one-off" ? 1 : 0,
      }),
    // PUT requires `revoked` and `auto_groups` both (per the API docs); the caller supplies the
    // groups it minted the key with (stored in `network_peers.group_ids_json`) rather than an
    // extra GET.
    revokeSetupKey: (id, autoGroups) =>
      call("PUT", `/api/setup-keys/${id}`, NetbirdSetupKey, {
        revoked: true,
        auto_groups: autoGroups,
      }),

    listPeers: () => call("GET", "/api/peers", z.array(NetbirdPeer)),
    deletePeer: (id) => call("DELETE", `/api/peers/${id}`, z.void()),
  };
}
