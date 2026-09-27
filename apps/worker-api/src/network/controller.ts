// Owner: WT-9. Desired-state reconciliation from D1 → NetBird (ADR 0007, ADR 0008, master spec
// §4.8/§15/§41). D1 stays authoritative for tenant/device/user identity and desired membership;
// NetBird itself is asked (never guessed) for its current groups/policies, so this file never
// invents a second source of truth for infrastructure that already answers "what exists" — only
// which id a peer/setup-key row maps to lives in `network_peers`.
//
// Every exported function is a no-op when `NETBIRD_API_URL` is unset (deliverable #3): it still
// writes/updates the `network_peers` row with `status: "not_configured"` so the Fleet Network tab
// and the enroll/heartbeat paths have something consistent to render, but never calls out to
// NetBird, and the enroll response omits `network` entirely — production behaves exactly as
// before the server exists.
//
// Naming (this brief, overriding ADR 0007's `cbx-<tenant-id>` shorthand for readability in the
// NetBird dashboard): groups are named with the tenant's public code, e.g. `cbx-server-CBX-00001`.
import { and, desc, eq } from "drizzle-orm";
import { audit } from "../audit";
import type { Db } from "../db/client";
import { networkPeers, tenants } from "../db/schema";
import type { Bindings } from "../env";
import { newId, nowIso } from "../ids";
import {
  createNetbirdClient,
  managementUrlFor,
  type NetbirdClient,
  type NetbirdConfig,
  type NetbirdPolicyRule,
  netbirdConfig,
} from "./netbird";

const RDP_PORT = "3389";
/**
 * No such listener exists yet anywhere in the Windows Agent (Slices 2.1–2.5 ship only the local
 * named-pipe IPC and outbound HTTPS calls to the cloud — see
 * docs/plans/briefs/WT-4-windows-agent.md). This slice's brief asks for "TCP 3389 + the Agent
 * management port" on both the tenant and support policies, so a port is reserved here for a
 * future in-mesh management API; nothing listens on it yet. Flagged in the handoff as a decision
 * WT-0/WT-4 should confirm (or change) before the real NetBird server carries production traffic.
 */
export const AGENT_MANAGEMENT_PORT = "7391";

const SERVER_GROUP_PREFIX = "cbx-server-";
const CLIENT_GROUP_PREFIX = "cbx-client-";
export const SUPPORT_GROUP_NAME = "cbx-support";
const SUPPORT_POLICY_NAME = "cbx-support-access";
/** NetBird's built-in allow-all policy, created by the getting-started install script. Must be
 * deleted once, by hand, per the runbook, before any tenant is provisioned — this only asserts. */
const DEFAULT_POLICY_NAME = "Default";

const serverGroupName = (tenantCode: string) => `${SERVER_GROUP_PREFIX}${tenantCode}`;
const clientGroupName = (tenantCode: string) => `${CLIENT_GROUP_PREFIX}${tenantCode}`;
const tenantPolicyName = (tenantCode: string) => `cbx-tenant-${tenantCode}`;

/** Setup keys must satisfy NetBird's own minimum (86400 s = 24 h); the brief asks for exactly one
 * day, which is also the shortest window a customer needs to run an installer. */
export const SETUP_KEY_TTL_SECONDS = 86_400;

export type NetworkController = { configured: true; netbird: NetbirdClient; config: NetbirdConfig };
export type NotConfigured = { configured: false };

/** Resolves the controller from the Worker's bindings, or `{configured:false}` when NetBird has
 * no server yet. Every other exported function starts here, once per call, so a request never
 * pays for more than one client construction (cheap — no I/O happens until a method is called).
 * `fetchImpl` defaults to the global `fetch`; tests pass a fake NetBird server instead, the same
 * dependency-injection seam `netbird.ts` itself uses (agent-notes: the Workers test pool's module
 * mocking is not reliable). */
export function resolveController(
  env: Bindings,
  fetchImpl: typeof fetch = fetch,
): NetworkController | NotConfigured {
  const config = netbirdConfig(env);
  if (!config) return { configured: false };
  return { configured: true, netbird: createNetbirdClient(config, fetchImpl), config };
}

/** Throws when NetBird's built-in "Default" allow-all policy is still present. Call this before
 * trusting tenant isolation (master spec §15.3's isolation test; ADR 0007 "delete the default
 * allow-all policy immediately after bootstrap"). */
export async function assertDefaultPolicyAbsent(netbird: NetbirdClient): Promise<void> {
  const policies = await netbird.listPolicies();
  const found = policies.find((p) => p.name === DEFAULT_POLICY_NAME);
  if (found) {
    throw new Error(
      `NetBird's "Default" allow-all policy is still present (id=${found.id}); delete it per ` +
        "docs/runbooks/netbird-server.md before provisioning any tenant network",
    );
  }
}

async function findOrCreateGroup(netbird: NetbirdClient, name: string) {
  const existing = await netbird.findGroupByName(name);
  if (existing) return existing;
  return netbird.createGroup(name);
}

async function findPolicyByName(netbird: NetbirdClient, name: string) {
  const policies = await netbird.listPolicies();
  return policies.find((p) => p.name === name) ?? null;
}

function rdpAndManagementRule(input: {
  name: string;
  sources: string[];
  destinations: string[];
}): NetbirdPolicyRule {
  return {
    name: input.name,
    enabled: true,
    action: "accept",
    bidirectional: false,
    protocol: "tcp",
    ports: [RDP_PORT, AGENT_MANAGEMENT_PORT],
    sources: input.sources,
    destinations: input.destinations,
  };
}

/** Compares only the fields CloudBox itself sets — ignores server-assigned rule `id`s, so a rule
 * this function generated compares equal to itself round-tripped through NetBird. */
function ruleKey(rule: NetbirdPolicyRule): string {
  return JSON.stringify({
    action: rule.action,
    bidirectional: rule.bidirectional,
    protocol: rule.protocol,
    ports: [...(rule.ports ?? [])].sort(),
    sources: [...(rule.sources ?? [])].sort(),
    destinations: [...(rule.destinations ?? [])].sort(),
  });
}

function rulesEqual(a: NetbirdPolicyRule[], b: NetbirdPolicyRule[]): boolean {
  if (a.length !== b.length) return false;
  const left = a.map(ruleKey).sort();
  const right = b.map(ruleKey).sort();
  return left.every((v, i) => v === right[i]);
}

/** Upserts a policy by name: creates it if absent, updates it only when the live rule set differs
 * from `desiredRules` (self-healing without pointless writes on every call). */
async function upsertPolicy(
  netbird: NetbirdClient,
  name: string,
  description: string,
  desiredRules: NetbirdPolicyRule[],
): Promise<string> {
  const existing = await findPolicyByName(netbird, name);
  if (!existing) {
    const created = await netbird.createPolicy({
      name,
      description,
      enabled: true,
      rules: desiredRules,
    });
    return created.id;
  }
  if (!rulesEqual(existing.rules, desiredRules)) {
    await netbird.updatePolicy(existing.id, {
      name: existing.name,
      description: existing.description,
      enabled: true,
      rules: desiredRules,
    });
  }
  return existing.id;
}

export type TenantNetworkResult =
  | NotConfigured
  | { configured: true; serverGroupId: string; clientGroupId: string; policyId: string };

async function ensureTenantNetworkWith(
  netbird: NetbirdClient,
  db: Db,
  tenantId: string,
): Promise<{ serverGroupId: string; clientGroupId: string; policyId: string }> {
  const [tenant] = await db
    .select({ publicCode: tenants.publicCode })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!tenant) throw new Error(`ensureTenantNetwork: unknown tenant ${tenantId}`);

  await assertDefaultPolicyAbsent(netbird);

  const [serverGroup, clientGroup] = await Promise.all([
    findOrCreateGroup(netbird, serverGroupName(tenant.publicCode)),
    findOrCreateGroup(netbird, clientGroupName(tenant.publicCode)),
  ]);

  const policyId = await upsertPolicy(
    netbird,
    tenantPolicyName(tenant.publicCode),
    `CloudBox tenant isolation for ${tenant.publicCode} (ADR 0007)`,
    [
      rdpAndManagementRule({
        name: `${tenantPolicyName(tenant.publicCode)}-rule`,
        sources: [clientGroup.id],
        destinations: [serverGroup.id],
      }),
    ],
  );

  return { serverGroupId: serverGroup.id, clientGroupId: clientGroup.id, policyId };
}

/**
 * Creates (or finds) `cbx-server-<code>` and `cbx-client-<code>` and the tenant isolation policy
 * — client group → server group, TCP 3389 + the Agent management port, one-directional. Exported
 * standalone (e.g. for a future "provision this tenant's network" admin action); `mintServerSetupKey`
 * and `mintClientSetupKey` call the shared internal version directly to avoid resolving the
 * controller twice.
 */
export async function ensureTenantNetwork(
  env: Bindings,
  db: Db,
  tenantId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TenantNetworkResult> {
  const controller = resolveController(env, fetchImpl);
  if (!controller.configured) return { configured: false };
  const result = await ensureTenantNetworkWith(controller.netbird, db, tenantId);
  return { configured: true, ...result };
}

async function ensureSupportAccessWith(
  netbird: NetbirdClient,
): Promise<{ supportGroupId: string; policyId: string }> {
  await assertDefaultPolicyAbsent(netbird);

  const supportGroup = await findOrCreateGroup(netbird, SUPPORT_GROUP_NAME);
  const allGroups = await netbird.listGroups();
  const serverGroupIds = allGroups
    .filter((g) => g.name.startsWith(SERVER_GROUP_PREFIX))
    .map((g) => g.id);

  const policyId = await upsertPolicy(
    netbird,
    SUPPORT_POLICY_NAME,
    "CloudBox standing support access to every tenant server (ADR 0008)",
    [
      rdpAndManagementRule({
        name: `${SUPPORT_POLICY_NAME}-rule`,
        sources: [supportGroup.id],
        destinations: serverGroupIds,
      }),
    ],
  );

  return { supportGroupId: supportGroup.id, policyId };
}

export type SupportAccessResult =
  | NotConfigured
  | { configured: true; supportGroupId: string; policyId: string };

/**
 * Ensures the `cbx-support` group and the standing support→every-server-group policy (ADR 0008,
 * "Super Admin group always has access for maintenance and work"). Destinations are derived from
 * NetBird's own group list (every `cbx-server-*` group that currently exists), not a separate D1
 * cache, so a newly provisioned tenant is folded in the next time this runs — which
 * `mintServerSetupKey` does right after `ensureTenantNetwork` creates that tenant's server group.
 */
export async function ensureSupportAccess(
  env: Bindings,
  fetchImpl: typeof fetch = fetch,
): Promise<SupportAccessResult> {
  const controller = resolveController(env, fetchImpl);
  if (!controller.configured) return { configured: false };
  const result = await ensureSupportAccessWith(controller.netbird);
  return { configured: true, ...result };
}

async function upsertNetworkPeer(
  db: Db,
  input: {
    kind: "server" | "client" | "support";
    tenantId: string;
    deviceId?: string;
    userId?: string;
    netbirdSetupKeyId?: string | null;
    groupIds: string[];
    status: "not_configured" | "pending" | "active" | "revoked";
  },
): Promise<string> {
  const now = nowIso();
  const scope =
    input.kind === "server"
      ? and(eq(networkPeers.kind, "server"), eq(networkPeers.deviceId, input.deviceId ?? ""))
      : input.kind === "client"
        ? and(
            eq(networkPeers.kind, "client"),
            eq(networkPeers.tenantId, input.tenantId),
            eq(networkPeers.userId, input.userId ?? ""),
          )
        : and(eq(networkPeers.kind, "support"), eq(networkPeers.tenantId, input.tenantId));

  const [existing] = await db.select({ id: networkPeers.id }).from(networkPeers).where(scope);

  if (existing) {
    await db
      .update(networkPeers)
      .set({
        netbirdSetupKeyId: input.netbirdSetupKeyId ?? null,
        groupIdsJson: JSON.stringify(input.groupIds),
        status: input.status,
        updatedAt: now,
      })
      .where(eq(networkPeers.id, existing.id));
    return existing.id;
  }

  const id = newId("networkPeer");
  await db.insert(networkPeers).values({
    id,
    kind: input.kind,
    tenantId: input.tenantId,
    deviceId: input.deviceId ?? null,
    userId: input.userId ?? null,
    netbirdSetupKeyId: input.netbirdSetupKeyId ?? null,
    groupIdsJson: JSON.stringify(input.groupIds),
    status: input.status,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export type MintResult =
  | { configured: false }
  | { configured: true; setupKey: string; managementUrl: string; expiresAt: string };

/**
 * Mints a one-off, 24-hour server setup key for `deviceId` (`auto_groups` = that tenant's server
 * group only), provisioning the tenant network and the standing support policy first if they do
 * not exist yet. Records the mint in `network_peers` whether or not NetBird is configured.
 */
export async function mintServerSetupKey(
  env: Bindings,
  db: Db,
  input: { deviceId: string; tenantId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<MintResult> {
  const controller = resolveController(env, fetchImpl);
  if (!controller.configured) {
    await upsertNetworkPeer(db, {
      kind: "server",
      tenantId: input.tenantId,
      deviceId: input.deviceId,
      groupIds: [],
      status: "not_configured",
    });
    return { configured: false };
  }
  const { netbird, config } = controller;

  const network = await ensureTenantNetworkWith(netbird, db, input.tenantId);
  // Fold this tenant's (possibly brand-new) server group into the standing support policy before
  // handing out the key, so a support session can reach the server from the moment it joins.
  const support = await ensureSupportAccessWith(netbird);
  await upsertNetworkPeer(db, {
    kind: "support",
    tenantId: input.tenantId,
    groupIds: [support.supportGroupId, network.serverGroupId],
    status: "active",
  });

  const key = await netbird.createSetupKey({
    name: `cbx-server-${input.deviceId}`,
    type: "one-off",
    expiresIn: SETUP_KEY_TTL_SECONDS,
    autoGroups: [network.serverGroupId],
  });

  await upsertNetworkPeer(db, {
    kind: "server",
    tenantId: input.tenantId,
    deviceId: input.deviceId,
    netbirdSetupKeyId: key.id,
    groupIds: [network.serverGroupId],
    status: "pending",
  });
  const expiresAt = new Date(Date.now() + SETUP_KEY_TTL_SECONDS * 1000).toISOString();
  await audit(db, {
    eventType: "NETWORK_SERVER_KEY_ISSUED",
    entityType: "device",
    entityId: input.deviceId,
    actor: { type: "device", id: input.deviceId, tenantId: input.tenantId },
    before: null,
    after: { autoGroups: key.auto_groups, expiresAt },
    source: "agent",
  });

  return {
    configured: true,
    setupKey: key.key ?? "",
    managementUrl: managementUrlFor(config),
    expiresAt,
  };
}

/**
 * Mints a one-off, 24-hour Connect client setup key for `userId` in `tenantId` (`auto_groups` =
 * that tenant's client group only). Re-minting for the same (tenant, user) replaces the previous
 * `network_peers` row rather than creating a second one — the client only ever needs its latest
 * key, and an unused previous one simply expires on NetBird's side.
 */
export async function mintClientSetupKey(
  env: Bindings,
  db: Db,
  input: { userId: string; tenantId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<MintResult> {
  const controller = resolveController(env, fetchImpl);
  if (!controller.configured) {
    await upsertNetworkPeer(db, {
      kind: "client",
      tenantId: input.tenantId,
      userId: input.userId,
      groupIds: [],
      status: "not_configured",
    });
    return { configured: false };
  }
  const { netbird, config } = controller;

  const network = await ensureTenantNetworkWith(netbird, db, input.tenantId);
  const key = await netbird.createSetupKey({
    name: `cbx-client-${input.userId}`,
    type: "one-off",
    expiresIn: SETUP_KEY_TTL_SECONDS,
    autoGroups: [network.clientGroupId],
  });

  await upsertNetworkPeer(db, {
    kind: "client",
    tenantId: input.tenantId,
    userId: input.userId,
    netbirdSetupKeyId: key.id,
    groupIds: [network.clientGroupId],
    status: "pending",
  });
  const expiresAt = new Date(Date.now() + SETUP_KEY_TTL_SECONDS * 1000).toISOString();
  await audit(db, {
    eventType: "NETWORK_CLIENT_KEY_ISSUED",
    entityType: "tenant_membership",
    entityId: `${input.tenantId}:${input.userId}`,
    actor: { type: "user", id: input.userId, tenantId: input.tenantId },
    before: null,
    after: { tenantId: input.tenantId, expiresAt },
    source: "api",
  });

  return {
    configured: true,
    setupKey: key.key ?? "",
    managementUrl: managementUrlFor(config),
    expiresAt,
  };
}

async function revokePeerRow(
  netbird: NetbirdClient,
  row: { netbirdPeerId: string | null; netbirdSetupKeyId: string | null; groupIdsJson: string },
): Promise<void> {
  if (row.netbirdPeerId) {
    await netbird.deletePeer(row.netbirdPeerId);
    return;
  }
  if (row.netbirdSetupKeyId) {
    const groupIds: string[] = JSON.parse(row.groupIdsJson || "[]");
    await netbird.revokeSetupKey(row.netbirdSetupKeyId, groupIds);
  }
}

/** Removes the device's NetBird peer (if it ever joined) or revokes its unused setup key, and
 * marks the `network_peers` row revoked. No-op when the controller was never configured, or the
 * device never had a row (nothing to revoke). Called from `revokeDevice`/`uninstallDevice`
 * alongside their existing `DEVICE_REVOKED`/`DEVICE_UNINSTALLED` audit rows — this function does
 * not add a second audit row for the same action. */
export async function revokeDevicePeer(
  env: Bindings,
  db: Db,
  deviceId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const controller = resolveController(env, fetchImpl);
  if (!controller.configured) return;

  const [row] = await db
    .select({
      id: networkPeers.id,
      netbirdPeerId: networkPeers.netbirdPeerId,
      netbirdSetupKeyId: networkPeers.netbirdSetupKeyId,
      groupIdsJson: networkPeers.groupIdsJson,
      status: networkPeers.status,
    })
    .from(networkPeers)
    .where(and(eq(networkPeers.kind, "server"), eq(networkPeers.deviceId, deviceId)));
  if (!row || row.status === "revoked" || row.status === "not_configured") return;

  await revokePeerRow(controller.netbird, row);
  await db
    .update(networkPeers)
    .set({ status: "revoked", updatedAt: nowIso() })
    .where(eq(networkPeers.id, row.id));
}

/** Same as `revokeDevicePeer`, for a Connect member's client peer (called from membership
 * revocation). */
export async function revokeClientPeer(
  env: Bindings,
  db: Db,
  input: { userId: string; tenantId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const controller = resolveController(env, fetchImpl);
  if (!controller.configured) return;

  const [row] = await db
    .select({
      id: networkPeers.id,
      netbirdPeerId: networkPeers.netbirdPeerId,
      netbirdSetupKeyId: networkPeers.netbirdSetupKeyId,
      groupIdsJson: networkPeers.groupIdsJson,
      status: networkPeers.status,
    })
    .from(networkPeers)
    .where(
      and(
        eq(networkPeers.kind, "client"),
        eq(networkPeers.tenantId, input.tenantId),
        eq(networkPeers.userId, input.userId),
      ),
    );
  if (!row || row.status === "revoked" || row.status === "not_configured") return;

  await revokePeerRow(controller.netbird, row);
  await db
    .update(networkPeers)
    .set({ status: "revoked", updatedAt: nowIso() })
    .where(eq(networkPeers.id, row.id));
}

/** Fleet detail Network tab (additive to WT-3's `loadFleetDetail`): this device's own peer rows,
 * newest first. The caller puts this inside the same `db.batch` it already runs — no extra round
 * trip beyond the one batch. */
export function deviceNetworkPeersQuery(db: Db, deviceId: string) {
  return db
    .select({
      id: networkPeers.id,
      kind: networkPeers.kind,
      status: networkPeers.status,
      netbirdPeerId: networkPeers.netbirdPeerId,
      createdAt: networkPeers.createdAt,
      updatedAt: networkPeers.updatedAt,
    })
    .from(networkPeers)
    .where(and(eq(networkPeers.kind, "server"), eq(networkPeers.deviceId, deviceId)))
    .orderBy(desc(networkPeers.updatedAt));
}

export { netbirdConfig } from "./netbird";
