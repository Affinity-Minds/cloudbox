// A minimal in-memory NetBird management server, replaying the documented request/response
// shapes (docs.netbird.io/api/resources/{groups,policies,setup-keys,peers}, verified 2026-09-27 —
// see src/network/netbird.ts's header comment). Used as the injected `fetchImpl` for both the
// low-level client tests and the controller reconciliation tests, so every test in this slice
// exercises the same fake server rather than two different mocking styles.
export type FakeGroup = { id: string; name: string; peers_count: number };
export type FakePolicyRule = {
  id: string;
  name: string;
  enabled: boolean;
  action: "accept" | "drop";
  bidirectional: boolean;
  protocol: string;
  ports: string[];
  sources: string[];
  destinations: string[];
};
export type FakePolicy = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  rules: FakePolicyRule[];
};
export type FakeSetupKey = {
  id: string;
  key: string;
  name: string;
  type: "one-off" | "reusable";
  expires_in: number;
  valid: boolean;
  revoked: boolean;
  used_times: number;
  auto_groups: string[];
  usage_limit: number;
};
export type FakePeer = {
  id: string;
  name: string;
  connected: boolean;
  groups: { id: string; name: string }[];
};

export type RecordedRequest = { method: string; path: string; body: unknown };

export type FakeNetbirdServer = {
  fetch: typeof fetch;
  requests: RecordedRequest[];
  groups: Map<string, FakeGroup>;
  policies: Map<string, FakePolicy>;
  setupKeys: Map<string, FakeSetupKey>;
  peers: Map<string, FakePeer>;
  /** Seeds NetBird's own built-in allow-all policy (present until the runbook's setup step). */
  seedDefaultPolicy(): void;
  /** Registers a peer as already joined (for revoke-by-delete-peer tests). */
  seedJoinedPeer(id: string, name: string, groupIds: string[]): void;
  /** The next `count` requests get this HTTP status instead of a normal response (5xx retry tests). */
  failNext(status: number, count?: number): void;
};

let seq = 0;
const nextId = (prefix: string) => `${prefix}_${(++seq).toString(36)}`;

export function createFakeNetbirdServer(): FakeNetbirdServer {
  const groups = new Map<string, FakeGroup>();
  const policies = new Map<string, FakePolicy>();
  const setupKeys = new Map<string, FakeSetupKey>();
  const peers = new Map<string, FakePeer>();
  const requests: RecordedRequest[] = [];
  let pendingFailures: { status: number; remaining: number } | null = null;

  function json(body: unknown, status = 200): Response {
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  const server: FakeNetbirdServer = {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      requests.push({ method, path: url.pathname + url.search, body });

      if (pendingFailures && pendingFailures.remaining > 0) {
        pendingFailures.remaining -= 1;
        return json({ message: "injected failure" }, pendingFailures.status);
      }

      const parts = url.pathname.split("/").filter(Boolean); // ["api", "groups", ":id"?]

      // ── groups ──────────────────────────────────────────────────────────────────────────
      if (parts[0] === "api" && parts[1] === "groups") {
        if (method === "GET" && parts.length === 2) {
          const name = url.searchParams.get("name");
          const all = [...groups.values()];
          return json(name ? all.filter((g) => g.name === name) : all);
        }
        if (method === "POST" && parts.length === 2) {
          const id = nextId("grp");
          const group: FakeGroup = { id, name: body.name, peers_count: (body.peers ?? []).length };
          groups.set(id, group);
          return json(group, 201);
        }
        if (method === "DELETE" && parts.length === 3) {
          groups.delete(parts[2] as string);
          return json(null, 204);
        }
      }

      // ── policies ────────────────────────────────────────────────────────────────────────
      if (parts[0] === "api" && parts[1] === "policies") {
        if (method === "GET" && parts.length === 2) return json([...policies.values()]);
        if (method === "POST" && parts.length === 2) {
          const id = nextId("pol");
          const policy: FakePolicy = {
            id,
            name: body.name,
            description: body.description,
            enabled: body.enabled,
            rules: (body.rules ?? []).map((r: FakePolicyRule) => ({
              ...r,
              id: r.id ?? nextId("rule"),
            })),
          };
          policies.set(id, policy);
          return json(policy, 201);
        }
        if (method === "PUT" && parts.length === 3) {
          const id = parts[2] as string;
          const existing = policies.get(id);
          if (!existing) return json({ message: "not found" }, 404);
          const updated: FakePolicy = {
            id,
            name: body.name,
            description: body.description,
            enabled: body.enabled,
            rules: (body.rules ?? []).map((r: FakePolicyRule) => ({
              ...r,
              id: r.id ?? nextId("rule"),
            })),
          };
          policies.set(id, updated);
          return json(updated);
        }
        if (method === "DELETE" && parts.length === 3) {
          policies.delete(parts[2] as string);
          return json(null, 204);
        }
      }

      // ── setup keys ──────────────────────────────────────────────────────────────────────
      if (parts[0] === "api" && parts[1] === "setup-keys") {
        if (method === "POST" && parts.length === 2) {
          const id = nextId("key");
          const key: FakeSetupKey = {
            id,
            key: `${id.toUpperCase()}-FAKE-SETUP-KEY`,
            name: body.name,
            type: body.type,
            expires_in: body.expires_in,
            valid: true,
            revoked: false,
            used_times: 0,
            auto_groups: body.auto_groups,
            usage_limit: body.usage_limit,
          };
          setupKeys.set(id, key);
          return json(key, 201);
        }
        if (method === "PUT" && parts.length === 3) {
          const id = parts[2] as string;
          const existing = setupKeys.get(id);
          if (!existing) return json({ message: "not found" }, 404);
          const updated: FakeSetupKey = {
            ...existing,
            key: `${id.toUpperCase()}****`, // masked, as the real PUT/GET responses are
            revoked: body.revoked,
            valid: !body.revoked,
            auto_groups: body.auto_groups,
          };
          setupKeys.set(id, updated);
          return json(updated);
        }
      }

      // ── peers ───────────────────────────────────────────────────────────────────────────
      if (parts[0] === "api" && parts[1] === "peers") {
        if (method === "GET" && parts.length === 2) return json([...peers.values()]);
        if (method === "DELETE" && parts.length === 3) {
          peers.delete(parts[2] as string);
          return json(null, 204);
        }
      }

      return json({ message: `no fake route for ${method} ${url.pathname}` }, 404);
    }) as typeof fetch,
    requests,
    groups,
    policies,
    setupKeys,
    peers,
    seedDefaultPolicy() {
      const id = nextId("pol");
      policies.set(id, {
        id,
        name: "Default",
        description: "Allow all",
        enabled: true,
        rules: [
          {
            id: nextId("rule"),
            name: "Default",
            enabled: true,
            action: "accept",
            bidirectional: true,
            protocol: "all",
            ports: [],
            sources: [],
            destinations: [],
          },
        ],
      });
    },
    seedJoinedPeer(id, name, groupIds) {
      peers.set(id, {
        id,
        name,
        connected: true,
        groups: groupIds.map((gid) => ({ id: gid, name: groups.get(gid)?.name ?? gid })),
      });
    },
    failNext(status, count = 1) {
      pendingFailures = { status, remaining: count };
    },
  };

  return server;
}
