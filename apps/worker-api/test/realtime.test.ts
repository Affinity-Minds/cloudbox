// Owner: WT-16. FleetPresence Durable Object + `GET /api/v1/realtime/fleet` WebSocket auth.
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import type { PresenceDeltaMessage, PresenceSnapshotMessage } from "@cloudbox/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { globalPresenceStub, tenantPresenceStub } from "../src/realtime/fleet-presence";
import { type SignedIn, signInAs } from "./auth-fixtures";
import { seedDevice, seedMembership, seedTenant } from "./fixtures";

const PRESENCE_URL = "https://fleet-presence.internal/presence";

async function postPresence(
  stub: ReturnType<typeof tenantPresenceStub>,
  body: {
    deviceId: string;
    tenantId: string;
    agentVersion?: string | null;
    licenseState?: "none" | "active" | "expired";
    activeSessions?: number | null;
  },
): Promise<Response> {
  return stub.fetch(PRESENCE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agentVersion: null,
      licenseState: "none",
      activeSessions: null,
      ...body,
    }),
  });
}

async function auditCount(deviceId: string, eventType: "DEVICE_ONLINE" | "DEVICE_OFFLINE") {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM audit_log WHERE entity_id = ?1 AND event_type = ?2",
  )
    .bind(deviceId, eventType)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

/** Reads one message off a just-accepted WebSocket client end. */
function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    ws.addEventListener("message", (event: MessageEvent) =>
      resolve(JSON.parse(String(event.data))),
    );
    ws.addEventListener("error", (event) => reject(event));
  });
}

describe("FleetPresence Durable Object", () => {
  it("upserts presence on heartbeat and serves it in the WebSocket snapshot", async () => {
    const { tenantId } = await seedTenant(env.DB, {});
    const deviceId = "dev_presence_snapshot_1";
    const stub = tenantPresenceStub(env, tenantId);

    const post = await postPresence(stub, {
      deviceId,
      tenantId,
      agentVersion: "1.9.0",
      licenseState: "active",
      activeSessions: 2,
    });
    expect(post.status).toBe(204);

    const upgrade = await stub.fetch("https://fleet-presence.internal/socket", {
      headers: { Upgrade: "websocket" },
    });
    expect(upgrade.status).toBe(101);
    const ws = upgrade.webSocket;
    if (!ws) throw new Error("expected a WebSocket in the 101 response");
    ws.accept();

    const snapshot = (await nextMessage(ws)) as PresenceSnapshotMessage;
    expect(snapshot.type).toBe("snapshot");
    const row = snapshot.devices.find((d) => d.deviceId === deviceId);
    expect(row).toMatchObject({
      deviceId,
      online: true,
      agentVersion: "1.9.0",
      licenseState: "active",
      activeSessions: 2,
    });
    expect(row && "tenantId" in row).toBe(false);
    ws.close();
  });

  it("broadcasts a delta to already-connected sockets on the next heartbeat", async () => {
    const { tenantId } = await seedTenant(env.DB, {});
    const deviceId = "dev_presence_delta_1";
    const stub = tenantPresenceStub(env, tenantId);

    const upgrade = await stub.fetch("https://fleet-presence.internal/socket", {
      headers: { Upgrade: "websocket" },
    });
    const ws = upgrade.webSocket;
    if (!ws) throw new Error("expected a WebSocket in the 101 response");
    ws.accept();
    await nextMessage(ws); // the initial (empty) snapshot

    const pending = nextMessage(ws);
    await postPresence(stub, { deviceId, tenantId, agentVersion: "2.0.0" });
    const delta = (await pending) as PresenceDeltaMessage;
    expect(delta.type).toBe("delta");
    expect(delta.device).toMatchObject({ deviceId, online: true, agentVersion: "2.0.0" });
    ws.close();
  });

  it("writes DEVICE_ONLINE on the offline→online transition, and only once across repeats", async () => {
    const { tenantId } = await seedTenant(env.DB, {});
    const deviceId = "dev_presence_online_once";
    const stub = tenantPresenceStub(env, tenantId);

    await postPresence(stub, { deviceId, tenantId });
    await postPresence(stub, { deviceId, tenantId });
    await postPresence(stub, { deviceId, tenantId });

    expect(await auditCount(deviceId, "DEVICE_ONLINE")).toBe(1);
  });

  it("marks a device offline after 3 missed heartbeats via the alarm, and writes DEVICE_OFFLINE once", async () => {
    const { tenantId } = await seedTenant(env.DB, {});
    const deviceId = "dev_presence_offline_1";
    const stub = tenantPresenceStub(env, tenantId);

    await postPresence(stub, { deviceId, tenantId });
    expect(await auditCount(deviceId, "DEVICE_ONLINE")).toBe(1);

    // Simulate 3 missed 60s heartbeats (180s) without waiting on a real clock.
    const stale = new Date(Date.now() - 200_000).toISOString();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE presence SET last_seen_at = ? WHERE device_id = ?",
        stale,
        deviceId,
      );
    });

    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);
    expect(await auditCount(deviceId, "DEVICE_OFFLINE")).toBe(1);

    const row = await runInDurableObject(
      stub,
      (_instance, state) =>
        state.storage.sql
          .exec("SELECT online FROM presence WHERE device_id = ?", deviceId)
          .toArray()[0],
    );
    expect(row).toMatchObject({ online: 0 });

    // Nothing left online: the alarm does not reschedule itself.
    expect(await runDurableObjectAlarm(stub)).toBe(false);
    // No duplicate OFFLINE row from any of this.
    expect(await auditCount(deviceId, "DEVICE_OFFLINE")).toBe(1);
  });

  it("mirrors tenant transitions to the global feed without duplicating the audit row", async () => {
    const { tenantId } = await seedTenant(env.DB, {});
    const deviceId = "dev_presence_global_mirror";
    const tenant = tenantPresenceStub(env, tenantId);
    const global = globalPresenceStub(env);

    const upgrade = await global.fetch("https://fleet-presence.internal/socket", {
      headers: { Upgrade: "websocket" },
    });
    const ws = upgrade.webSocket;
    if (!ws) throw new Error("expected a WebSocket in the 101 response");
    ws.accept();
    await nextMessage(ws); // initial snapshot

    const pending = nextMessage(ws);
    await postPresence(tenant, { deviceId, tenantId, agentVersion: "3.0.0" });
    const delta = (await pending) as PresenceDeltaMessage;
    expect(delta.device).toMatchObject({ deviceId, online: true, agentVersion: "3.0.0" });

    // The tenant instance wrote the audit row; the global mirror never does.
    expect(await auditCount(deviceId, "DEVICE_ONLINE")).toBe(1);
    ws.close();
  });
});

describe("GET /api/v1/realtime/fleet (auth boundary)", () => {
  let staff: SignedIn;
  let tenantA: { tenantId: string };
  let tenantB: { tenantId: string };
  let customerA: SignedIn;

  beforeAll(async () => {
    staff = await signInAs(env, { email: "realtime-staff@example.test", staffRole: "support" });
    tenantA = await seedTenant(env.DB, { displayName: "Realtime Tenant A" });
    tenantB = await seedTenant(env.DB, { displayName: "Realtime Tenant B" });
    customerA = await signInAs(env, { email: "realtime-customer-a@example.test" });
    await seedMembership(env.DB, {
      tenantId: tenantA.tenantId,
      userId: customerA.userId,
      standing: "owner",
    });
  });

  it("401s an anonymous request", async () => {
    const res = await app.request(
      "/api/v1/realtime/fleet",
      { headers: { Upgrade: "websocket" } },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("403s a customer with no active tenant membership", async () => {
    const outsider = await signInAs(env, { email: "realtime-no-membership@example.test" });
    const res = await app.request(
      "/api/v1/realtime/fleet",
      { headers: { Upgrade: "websocket", ...outsider.headers } },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("403s a customer of tenant A asking for tenant B, and never falls back to global", async () => {
    const res = await app.request(
      `/api/v1/realtime/fleet?tenant=${tenantB.tenantId}`,
      { headers: { Upgrade: "websocket", ...customerA.headers } },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("upgrades a customer of tenant A to their own tenant's feed", async () => {
    const res = await app.request(
      "/api/v1/realtime/fleet",
      { headers: { Upgrade: "websocket", ...customerA.headers } },
      env,
    );
    expect(res.status).toBe(101);
    res.webSocket?.accept();
    res.webSocket?.close();
  });

  it("upgrades staff (device.view) to the global feed with no ?tenant=", async () => {
    const res = await app.request(
      "/api/v1/realtime/fleet",
      { headers: { Upgrade: "websocket", ...staff.headers } },
      env,
    );
    expect(res.status).toBe(101);
    res.webSocket?.accept();
    res.webSocket?.close();
  });

  it("scopes staff down to one tenant with ?tenant=, same as the Fleet screen filter", async () => {
    const res = await app.request(
      `/api/v1/realtime/fleet?tenant=${tenantA.tenantId}`,
      { headers: { Upgrade: "websocket", ...staff.headers } },
      env,
    );
    expect(res.status).toBe(101);
    res.webSocket?.accept();
    res.webSocket?.close();
  });

  it("426s a plain (non-upgrade) request from an authorised caller", async () => {
    const res = await app.request("/api/v1/realtime/fleet", { headers: staff.headers }, env);
    expect(res.status).toBe(426);
  });

  it("the snapshot for a tenant feed reflects a real enrolled device's presence end to end", async () => {
    const device = await seedDevice(env.DB, { tenantId: tenantA.tenantId });
    const stub = tenantPresenceStub(env, tenantA.tenantId);
    await postPresence(stub, {
      deviceId: device.deviceId,
      tenantId: tenantA.tenantId,
      agentVersion: "1.0.0",
    });

    const res = await app.request(
      "/api/v1/realtime/fleet",
      { headers: { Upgrade: "websocket", ...customerA.headers } },
      env,
    );
    expect(res.status).toBe(101);
    const ws = res.webSocket;
    if (!ws) throw new Error("expected a WebSocket");
    ws.accept();
    const snapshot = (await nextMessage(ws)) as PresenceSnapshotMessage;
    expect(snapshot.devices.map((d) => d.deviceId)).toContain(device.deviceId);
    ws.close();
  });
});
