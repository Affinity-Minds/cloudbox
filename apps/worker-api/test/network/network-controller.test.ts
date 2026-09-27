// Owner: WT-9. Desired-state reconciliation tests (src/network/controller.ts) against the fake
// NetBird server: tenant network creation is idempotent, policies isolate tenants (the generated
// policy JSON references only that tenant's own groups), the support policy is present and grows
// with new tenants, the Default policy is detected, setup keys are one-off with the right
// `auto_groups`/expiry, revocation removes the peer or revokes the key, the not-configured path is
// a pure no-op, and every consequential write is audited.
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../../src/db/client";
import { auditLog, networkPeers } from "../../src/db/schema";
import type { Bindings } from "../../src/env";
import {
  assertDefaultPolicyAbsent,
  ensureSupportAccess,
  ensureTenantNetwork,
  mintClientSetupKey,
  mintServerSetupKey,
  resolveController,
  revokeClientPeer,
  revokeDevicePeer,
  SETUP_KEY_TTL_SECONDS,
} from "../../src/network/controller";
import { createNetbirdClient } from "../../src/network/netbird";
import { seedDevice, seedTenant, signInAs } from "../fixtures";
import { createFakeNetbirdServer, type FakeNetbirdServer } from "./fake-netbird-server";

const configuredEnv = (): Bindings =>
  ({
    ...env,
    NETBIRD_API_URL: "https://fake.netbird.test",
    NETBIRD_API_TOKEN: "fake-token",
  }) as Bindings;

async function auditRowsFor(entityId: string) {
  const db = createDb(env.DB);
  return db.select().from(auditLog).where(eq(auditLog.entityId, entityId));
}

describe("ensureTenantNetwork — idempotent, isolated per tenant", () => {
  let server: FakeNetbirdServer;
  beforeEach(() => {
    server = createFakeNetbirdServer();
  });

  it("creates exactly one server group, one client group and one policy, and is idempotent", async () => {
    const db = createDb(env.DB);
    const { tenantId, publicCode } = await seedTenant(env.DB);
    const bindings = configuredEnv();

    const first = await ensureTenantNetwork(bindings, db, tenantId, server.fetch);
    const second = await ensureTenantNetwork(bindings, db, tenantId, server.fetch);

    expect(first).toEqual(second);
    expect([...server.groups.values()].filter((g) => g.name.includes(publicCode))).toHaveLength(2);
    expect([...server.policies.values()]).toHaveLength(1);
  });

  it("the generated policy references only this tenant's own groups — never another tenant's", async () => {
    const db = createDb(env.DB);
    const bindings = configuredEnv();
    const tenantA = await seedTenant(env.DB, { displayName: "Tenant A" });
    const tenantB = await seedTenant(env.DB, { displayName: "Tenant B" });

    const a = await ensureTenantNetwork(bindings, db, tenantA.tenantId, server.fetch);
    const b = await ensureTenantNetwork(bindings, db, tenantB.tenantId, server.fetch);
    if (!a.configured || !b.configured) throw new Error("expected configured");

    const policyA = server.policies.get(a.policyId);
    const policyB = server.policies.get(b.policyId);
    expect(policyA?.rules[0]?.sources).toEqual([a.clientGroupId]);
    expect(policyA?.rules[0]?.destinations).toEqual([a.serverGroupId]);
    expect(policyB?.rules[0]?.sources).toEqual([b.clientGroupId]);
    expect(policyB?.rules[0]?.destinations).toEqual([b.serverGroupId]);

    // Neither tenant's group ids appear anywhere in the other tenant's rule.
    const allA = [
      ...(policyA?.rules[0]?.sources ?? []),
      ...(policyA?.rules[0]?.destinations ?? []),
    ];
    const allB = [
      ...(policyB?.rules[0]?.sources ?? []),
      ...(policyB?.rules[0]?.destinations ?? []),
    ];
    expect(allA.some((id) => allB.includes(id))).toBe(false);
  });

  it("carries TCP 3389 and the Agent management port, one-directional (bidirectional: false)", async () => {
    const db = createDb(env.DB);
    const bindings = configuredEnv();
    const { tenantId } = await seedTenant(env.DB);

    const result = await ensureTenantNetwork(bindings, db, tenantId, server.fetch);
    if (!result.configured) throw new Error("expected configured");
    const rule = server.policies.get(result.policyId)?.rules[0];
    expect(rule?.protocol).toBe("tcp");
    expect(rule?.ports?.sort()).toEqual(["3389", "7391"]);
    expect(rule?.bidirectional).toBe(false);
    expect(rule?.action).toBe("accept");
  });
});

describe("Default policy detection", () => {
  it("assertDefaultPolicyAbsent throws when NetBird's built-in Default policy is still present", async () => {
    const server = createFakeNetbirdServer();
    server.seedDefaultPolicy();
    const client = createNetbirdClient(
      { apiUrl: "https://fake.netbird.test", apiToken: "t" },
      server.fetch,
    );
    await expect(assertDefaultPolicyAbsent(client)).rejects.toThrow(/Default/);
  });

  it("passes silently once the Default policy is gone", async () => {
    const server = createFakeNetbirdServer();
    const client = createNetbirdClient(
      { apiUrl: "https://fake.netbird.test", apiToken: "t" },
      server.fetch,
    );
    await expect(assertDefaultPolicyAbsent(client)).resolves.toBeUndefined();
  });

  it("ensureTenantNetwork itself refuses to provision while Default is present", async () => {
    const server = createFakeNetbirdServer();
    server.seedDefaultPolicy();
    const db = createDb(env.DB);
    const { tenantId } = await seedTenant(env.DB);
    await expect(ensureTenantNetwork(configuredEnv(), db, tenantId, server.fetch)).rejects.toThrow(
      /Default/,
    );
  });
});

describe("ensureSupportAccess", () => {
  it("creates the cbx-support group and a policy present even with no tenants yet", async () => {
    const server = createFakeNetbirdServer();
    const result = await ensureSupportAccess(configuredEnv(), server.fetch);
    expect(result.configured).toBe(true);
    if (!result.configured) throw new Error("unreachable");
    const policy = server.policies.get(result.policyId);
    expect(policy?.rules[0]?.sources).toEqual([result.supportGroupId]);
    expect(policy?.rules[0]?.destinations).toEqual([]);
  });

  it("folds a newly provisioned tenant's server group into the support policy's destinations", async () => {
    const server = createFakeNetbirdServer();
    const db = createDb(env.DB);
    const bindings = configuredEnv();
    const { tenantId } = await seedTenant(env.DB);

    const network = await ensureTenantNetwork(bindings, db, tenantId, server.fetch);
    if (!network.configured) throw new Error("expected configured");
    const support = await ensureSupportAccess(bindings, server.fetch);
    if (!support.configured) throw new Error("expected configured");

    const policy = server.policies.get(support.policyId);
    expect(policy?.rules[0]?.destinations).toContain(network.serverGroupId);
  });

  it("is idempotent: calling twice does not duplicate the group or the policy", async () => {
    const server = createFakeNetbirdServer();
    const bindings = configuredEnv();
    await ensureSupportAccess(bindings, server.fetch);
    await ensureSupportAccess(bindings, server.fetch);
    expect([...server.groups.values()].filter((g) => g.name === "cbx-support")).toHaveLength(1);
    expect(
      [...server.policies.values()].filter((p) => p.name === "cbx-support-access"),
    ).toHaveLength(1);
  });
});

describe("mintServerSetupKey", () => {
  let server: FakeNetbirdServer;
  beforeEach(() => {
    server = createFakeNetbirdServer();
  });

  it("mints a one-off key scoped to the tenant's server group only, 24h expiry", async () => {
    const db = createDb(env.DB);
    const bindings = configuredEnv();
    const { tenantId } = await seedTenant(env.DB);
    const device = await seedDevice(env.DB, { tenantId });

    const result = await mintServerSetupKey(
      bindings,
      db,
      { deviceId: device.deviceId, tenantId },
      server.fetch,
    );
    expect(result.configured).toBe(true);
    if (!result.configured) throw new Error("unreachable");
    expect(result.setupKey).toMatch(/FAKE-SETUP-KEY$/);
    expect(result.managementUrl).toBe("https://fake.netbird.test");

    const [key] = [...server.setupKeys.values()];
    if (!key) throw new Error("expected a minted setup key");
    expect(key.type).toBe("one-off");
    expect(key.usage_limit).toBe(1);
    expect(key.expires_in).toBe(SETUP_KEY_TTL_SECONDS);
    expect(key.auto_groups).toHaveLength(1);

    const [row] = await db
      .select()
      .from(networkPeers)
      .where(eq(networkPeers.deviceId, device.deviceId));
    expect(row?.kind).toBe("server");
    expect(row?.status).toBe("pending");
    expect(row?.netbirdSetupKeyId).toBe(key.id);
    expect(JSON.parse(row?.groupIdsJson ?? "[]")).toEqual(key.auto_groups);
  });

  it("audits NETWORK_SERVER_KEY_ISSUED", async () => {
    const db = createDb(env.DB);
    const bindings = configuredEnv();
    const { tenantId } = await seedTenant(env.DB);
    const device = await seedDevice(env.DB, { tenantId });

    await mintServerSetupKey(bindings, db, { deviceId: device.deviceId, tenantId }, server.fetch);

    const rows = await auditRowsFor(device.deviceId);
    expect(rows.some((r) => r.eventType === "NETWORK_SERVER_KEY_ISSUED")).toBe(true);
  });

  it("re-minting for the same device updates its one row rather than creating a second", async () => {
    const db = createDb(env.DB);
    const bindings = configuredEnv();
    const { tenantId } = await seedTenant(env.DB);
    const device = await seedDevice(env.DB, { tenantId });

    await mintServerSetupKey(bindings, db, { deviceId: device.deviceId, tenantId }, server.fetch);
    await mintServerSetupKey(bindings, db, { deviceId: device.deviceId, tenantId }, server.fetch);

    const rows = await db
      .select()
      .from(networkPeers)
      .where(eq(networkPeers.deviceId, device.deviceId));
    expect(rows).toHaveLength(1);
  });
});

describe("mintClientSetupKey", () => {
  it("mints a one-off key scoped to the tenant's client group only, and audits NETWORK_CLIENT_KEY_ISSUED", async () => {
    const server = createFakeNetbirdServer();
    const db = createDb(env.DB);
    const bindings = configuredEnv();
    const { tenantId } = await seedTenant(env.DB);
    const { userId } = await signInAs(env, { email: "network-client-1@example.test" });

    const result = await mintClientSetupKey(bindings, db, { userId, tenantId }, server.fetch);
    expect(result.configured).toBe(true);
    if (!result.configured) throw new Error("unreachable");

    const [key] = [...server.setupKeys.values()];
    if (!key) throw new Error("expected a minted setup key");
    expect(key.type).toBe("one-off");
    expect(key.auto_groups).toHaveLength(1);

    const [row] = await db.select().from(networkPeers).where(eq(networkPeers.userId, userId));
    expect(row?.kind).toBe("client");
    expect(row?.tenantId).toBe(tenantId);
    expect(row?.status).toBe("pending");

    const rows = await auditRowsFor(`${tenantId}:${userId}`);
    expect(rows.some((r) => r.eventType === "NETWORK_CLIENT_KEY_ISSUED")).toBe(true);
  });
});

describe("not-configured: pure no-op", () => {
  it("mintServerSetupKey never calls out and records status not_configured", async () => {
    const db = createDb(env.DB);
    const { tenantId } = await seedTenant(env.DB);
    const device = await seedDevice(env.DB, { tenantId });

    // `env` here is the real test binding: NETBIRD_API_URL was never set.
    const result = await mintServerSetupKey(env as Bindings, db, {
      deviceId: device.deviceId,
      tenantId,
    });
    expect(result).toEqual({ configured: false });

    const [row] = await db
      .select()
      .from(networkPeers)
      .where(eq(networkPeers.deviceId, device.deviceId));
    expect(row?.status).toBe("not_configured");
    expect(row?.netbirdSetupKeyId).toBeNull();
  });

  it("mintClientSetupKey and both revoke functions are no-ops too", async () => {
    const db = createDb(env.DB);
    const { tenantId } = await seedTenant(env.DB);
    const { userId } = await signInAs(env, { email: "network-client-2@example.test" });

    const result = await mintClientSetupKey(env as Bindings, db, { userId, tenantId });
    expect(result).toEqual({ configured: false });

    // Revoking with no NetBird configured must not throw.
    await expect(
      revokeClientPeer(env as Bindings, db, { userId, tenantId }),
    ).resolves.toBeUndefined();
    await expect(
      revokeDevicePeer(env as Bindings, db, "dev_does-not-exist"),
    ).resolves.toBeUndefined();
  });

  it("resolveController reports configured:false with no NetBird bindings", () => {
    expect(resolveController(env as Bindings)).toEqual({ configured: false });
  });
});

describe("revocation", () => {
  it("revokeDevicePeer deletes the NetBird peer once it has joined", async () => {
    const server = createFakeNetbirdServer();
    const db = createDb(env.DB);
    const bindings = configuredEnv();
    const { tenantId } = await seedTenant(env.DB);
    const device = await seedDevice(env.DB, { tenantId });

    const minted = await mintServerSetupKey(
      bindings,
      db,
      { deviceId: device.deviceId, tenantId },
      server.fetch,
    );
    if (!minted.configured) throw new Error("expected configured");
    const [row] = await db
      .select()
      .from(networkPeers)
      .where(eq(networkPeers.deviceId, device.deviceId));
    if (!row) throw new Error("expected a network_peers row after minting");
    const groupIds: string[] = JSON.parse(row.groupIdsJson);
    // Simulate the peer having joined (a future reconciliation job would set this).
    server.seedJoinedPeer("peer_1", "front-desk-01", groupIds);
    await db
      .update(networkPeers)
      .set({ netbirdPeerId: "peer_1" })
      .where(eq(networkPeers.id, row.id));

    await revokeDevicePeer(bindings, db, device.deviceId, server.fetch);

    expect(server.peers.has("peer_1")).toBe(false);
    const [after] = await db
      .select()
      .from(networkPeers)
      .where(eq(networkPeers.deviceId, device.deviceId));
    expect(after?.status).toBe("revoked");
  });

  it("revokeDevicePeer revokes the unused setup key when the peer never joined", async () => {
    const server = createFakeNetbirdServer();
    const db = createDb(env.DB);
    const bindings = configuredEnv();
    const { tenantId } = await seedTenant(env.DB);
    const device = await seedDevice(env.DB, { tenantId });

    await mintServerSetupKey(bindings, db, { deviceId: device.deviceId, tenantId }, server.fetch);
    const [row] = await db
      .select()
      .from(networkPeers)
      .where(eq(networkPeers.deviceId, device.deviceId));

    await revokeDevicePeer(bindings, db, device.deviceId, server.fetch);

    if (!row?.netbirdSetupKeyId) throw new Error("expected a minted setup key id");
    const key = server.setupKeys.get(row.netbirdSetupKeyId);
    expect(key?.revoked).toBe(true);
    const [after] = await db
      .select()
      .from(networkPeers)
      .where(eq(networkPeers.deviceId, device.deviceId));
    expect(after?.status).toBe("revoked");
  });

  it("revokeClientPeer revokes the client's unused setup key", async () => {
    const server = createFakeNetbirdServer();
    const db = createDb(env.DB);
    const bindings = configuredEnv();
    const { tenantId } = await seedTenant(env.DB);
    const { userId } = await signInAs(env, { email: "network-client-3@example.test" });

    await mintClientSetupKey(bindings, db, { userId, tenantId }, server.fetch);
    await revokeClientPeer(bindings, db, { userId, tenantId }, server.fetch);

    const [after] = await db.select().from(networkPeers).where(eq(networkPeers.userId, userId));
    expect(after?.status).toBe("revoked");
  });

  it("revoking twice is safe (second call is a no-op, no second NetBird call)", async () => {
    const server = createFakeNetbirdServer();
    const db = createDb(env.DB);
    const bindings = configuredEnv();
    const { tenantId } = await seedTenant(env.DB);
    const device = await seedDevice(env.DB, { tenantId });

    await mintServerSetupKey(bindings, db, { deviceId: device.deviceId, tenantId }, server.fetch);
    await revokeDevicePeer(bindings, db, device.deviceId, server.fetch);
    const countAfterFirst = server.requests.length;
    await revokeDevicePeer(bindings, db, device.deviceId, server.fetch);
    expect(server.requests.length).toBe(countAfterFirst); // no new NetBird call
  });
});
