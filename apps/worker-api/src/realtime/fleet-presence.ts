// Owner: WT-16. FleetPresence Durable Object — ephemeral fleet presence (spec §5.3, §16, §29).
// Storage is durable per instance (SQLite backend) but the *business meaning* of a row is
// ephemeral: it is rebuilt from the next heartbeat if ever lost, and D1 (`devices.last_seen_at`,
// `devices.last_health_json`) stays the durable record — this class never becomes the source of
// truth for anything a screen loader reads outside a live WebSocket.
//
// One instance per tenant, keyed `tenant:<tenantId>` — authoritative: it is the only thing the
// heartbeat handler talks to (`POST /presence`), it runs the 60s offline-detection alarm, and it
// is the only place a DEVICE_ONLINE/DEVICE_OFFLINE audit row gets written. Plus one global
// instance keyed `all` for staff — mirror-only: it learns everything it knows from the tenant
// instances forwarding to it (`POST /presence/forward`), never runs its own alarm, and never
// writes audit rows (the tenant instance that first saw the transition already did).
//
// The same class serves both roles; behaviour is picked by which path is called, never by
// anything this class infers about "which instance am I" — there is no such introspection.
// routes/v1/realtime.ts decides which instance a caller may reach, before it ever calls
// `stub.fetch()`; this class never reads a tenant/staff id off the request it's handed
// (`fetch()` below takes no query params for that reason).
//
// WebSocket clients use the Hibernation API (`ctx.acceptWebSocket`) so an idle Fleet screen does
// not pin this DO (and its billable duration) in memory — see
// https://developers.cloudflare.com/durable-objects/best-practices/websockets/. Responses from a
// DO stub are immutable to the caller (agent-notes cloudflare-workers "immutable responses");
// nothing here needs to mutate one, but `routes/v1/realtime.ts`'s response passes back through
// the app-wide `apiVersion()`/`correlationId()` middleware, which already copies-on-write for the
// 101 case (`src/http.ts`).
import type { LicenseState } from "@cloudbox/contracts";
import { audit } from "../audit";
import { createDb } from "../db/client";
import type { Bindings } from "../env";
import { nowIso } from "../ids";

/** 3 missed 60s heartbeats (spec: "offline detection ... after 3 missed heartbeats (180s)"). */
const OFFLINE_AFTER_MS = 180_000;
/** The alarm's own cadence — same figure, spec calls it out separately ("a DO alarm every 60s"). */
const ALARM_INTERVAL_MS = 60_000;

/** Body of `POST /presence` (heartbeat handler → the tenant's own instance): always implies the
 * device is online right now — a heartbeat cannot report anything else. */
export type PresenceUpdateInput = {
  deviceId: string;
  tenantId: string;
  agentVersion: string | null;
  licenseState: LicenseState;
  activeSessions: number | null;
};

/** Body of `POST /presence/forward` (a tenant instance → the global one): same fields, plus the
 * online flag the tenant instance already decided (true from a heartbeat, false from its alarm). */
type ForwardBody = PresenceUpdateInput & { online: boolean };

type PresenceRow = {
  deviceId: string;
  tenantId: string;
  online: boolean;
  lastSeenAt: string;
  agentVersion: string | null;
  licenseState: LicenseState;
  activeSessions: number | null;
  updatedAt: string;
};

type PresenceSqlRow = {
  device_id: string;
  tenant_id: string;
  online: number;
  last_seen_at: string;
  agent_version: string | null;
  license_state: string;
  active_sessions: number | null;
  updated_at: string;
};

function fromSqlRow(row: PresenceSqlRow): PresenceRow {
  return {
    deviceId: row.device_id,
    tenantId: row.tenant_id,
    online: row.online === 1,
    lastSeenAt: row.last_seen_at,
    agentVersion: row.agent_version,
    licenseState: row.license_state as LicenseState,
    activeSessions: row.active_sessions,
    updatedAt: row.updated_at,
  };
}

/** Wire shape sent to WebSocket clients (`@cloudbox/contracts` `PresenceDevice`): `tenantId` is
 * dropped — a client already knows which tenant/global feed it subscribed to. */
function toWire(row: PresenceRow) {
  const { tenantId: _tenantId, ...wire } = row;
  return wire;
}

export class FleetPresence {
  private readonly ctx: DurableObjectState;
  private readonly env: Bindings;
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Bindings) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS presence (
        device_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        online INTEGER NOT NULL,
        last_seen_at TEXT NOT NULL,
        agent_version TEXT,
        license_state TEXT NOT NULL,
        active_sessions INTEGER,
        updated_at TEXT NOT NULL
      )
    `);
  }

  async fetch(request: Request): Promise<Response> {
    if ((request.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
      return this.acceptSocket();
    }

    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/presence") {
      return this.ingestHeartbeat(await request.json());
    }
    if (request.method === "POST" && path === "/presence/forward") {
      return this.ingestForward(await request.json());
    }
    return new Response(null, { status: 404 });
  }

  private acceptSocket(): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    const snapshot = this.snapshot();
    server.send(JSON.stringify({ type: "snapshot", devices: snapshot }));
    return new Response(null, { status: 101, webSocket: client });
  }

  private snapshot() {
    return this.sql
      .exec("SELECT * FROM presence ORDER BY device_id")
      .toArray()
      .map((row) => toWire(fromSqlRow(row as unknown as PresenceSqlRow)));
  }

  // Hibernatable WebSocket handlers (required even when unused: their presence is what tells the
  // runtime this class supports hibernation for every socket accepted via `acceptWebSocket`).
  async webSocketMessage(): Promise<void> {
    // Clients never send anything meaningful; the runtime answers ping frames on its own.
  }

  async webSocketClose(): Promise<void> {
    // The runtime auto-replies to close frames at this compat date (see the file's own doc
    // comment); nothing to do here — no per-connection state is held outside `ctx.getWebSockets()`.
  }

  async webSocketError(): Promise<void> {}

  private broadcast(row: PresenceRow): void {
    const message = JSON.stringify({ type: "delta", device: toWire(row) });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch {
        // A socket the runtime hasn't reaped yet; it will close on its own.
      }
    }
  }

  private getRow(deviceId: string): PresenceRow | null {
    const rows = this.sql.exec("SELECT * FROM presence WHERE device_id = ?", deviceId).toArray();
    return rows[0] ? fromSqlRow(rows[0] as unknown as PresenceSqlRow) : null;
  }

  private putRow(row: PresenceRow): void {
    this.sql.exec(
      `INSERT INTO presence
         (device_id, tenant_id, online, last_seen_at, agent_version, license_state, active_sessions, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET
         tenant_id = excluded.tenant_id,
         online = excluded.online,
         last_seen_at = excluded.last_seen_at,
         agent_version = excluded.agent_version,
         license_state = excluded.license_state,
         active_sessions = excluded.active_sessions,
         updated_at = excluded.updated_at`,
      row.deviceId,
      row.tenantId,
      row.online ? 1 : 0,
      row.lastSeenAt,
      row.agentVersion,
      row.licenseState,
      row.activeSessions,
      row.updatedAt,
    );
  }

  /** Only ever called by the tenant instance itself (never forwarded, never duplicated by the
   * global mirror): the one place a DEVICE_ONLINE/DEVICE_OFFLINE row is written. */
  private async recordTransition(
    row: PresenceRow,
    eventType: "DEVICE_ONLINE" | "DEVICE_OFFLINE",
  ): Promise<void> {
    try {
      await audit(createDb(this.env.DB), {
        eventType,
        entityType: "device",
        entityId: row.deviceId,
        actor: { type: "system", id: "fleet-presence", tenantId: row.tenantId },
        before: null,
        after: { online: row.online, at: row.updatedAt },
        source: "presence",
      });
    } catch (error) {
      // A missed audit row must never take the presence feed down with it.
      console.error("presence: audit write failed", eventType, row.deviceId, error);
    }
  }

  /** Fire-and-forget: the global mirror is a convenience for staff, never load-bearing for a
   * tenant's own presence feed or its audit trail. */
  private forwardToGlobal(row: PresenceRow): void {
    const body: ForwardBody = {
      deviceId: row.deviceId,
      tenantId: row.tenantId,
      online: row.online,
      agentVersion: row.agentVersion,
      licenseState: row.licenseState,
      activeSessions: row.activeSessions,
    };
    const send = globalPresenceStub(this.env)
      .fetch("https://fleet-presence.internal/presence/forward", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      .catch((error: unknown) => {
        console.error("presence: forward to global failed", row.deviceId, error);
      });
    this.ctx.waitUntil(send);
  }

  private async ensureAlarmArmed(): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null) await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  /** `POST /presence` — the heartbeat handler, via `notifyHeartbeatPresence()`. Authoritative:
   * always online (a heartbeat cannot report otherwise), may write the ONLINE transition, always
   * forwards to the global mirror, always (re-)arms the offline-detection alarm. */
  private async ingestHeartbeat(body: unknown): Promise<Response> {
    const input = body as Partial<PresenceUpdateInput> | null;
    if (!input || typeof input.deviceId !== "string" || typeof input.tenantId !== "string") {
      return new Response(null, { status: 400 });
    }

    const now = nowIso();
    const existing = this.getRow(input.deviceId);
    const row: PresenceRow = {
      deviceId: input.deviceId,
      tenantId: input.tenantId,
      online: true,
      lastSeenAt: now,
      agentVersion: input.agentVersion ?? null,
      licenseState: (input.licenseState ?? "none") as LicenseState,
      activeSessions: input.activeSessions ?? null,
      updatedAt: now,
    };
    this.putRow(row);
    this.broadcast(row);

    const becameOnline = !existing?.online;
    if (becameOnline) await this.recordTransition(row, "DEVICE_ONLINE");
    this.forwardToGlobal(row);
    await this.ensureAlarmArmed();

    return new Response(null, { status: 204 });
  }

  /** `POST /presence/forward` — another `FleetPresence` instance (always the tenant one that
   * owns this device), never a client. Mirror only: no audit, no further forwarding, no alarm. */
  private async ingestForward(body: unknown): Promise<Response> {
    const input = body as Partial<ForwardBody> | null;
    if (!input || typeof input.deviceId !== "string" || typeof input.tenantId !== "string") {
      return new Response(null, { status: 400 });
    }

    const now = nowIso();
    const row: PresenceRow = {
      deviceId: input.deviceId,
      tenantId: input.tenantId,
      online: Boolean(input.online),
      lastSeenAt: input.online ? now : (this.getRow(input.deviceId)?.lastSeenAt ?? now),
      agentVersion: input.agentVersion ?? null,
      licenseState: (input.licenseState ?? "none") as LicenseState,
      activeSessions: input.activeSessions ?? null,
      updatedAt: now,
    };
    this.putRow(row);
    this.broadcast(row);
    return new Response(null, { status: 204 });
  }

  /** Runs every 60s while at least one device is online (spec §16/§29): marks anything silent for
   * over 180s offline, writes the OFFLINE transition, broadcasts, and mirrors to the global feed.
   * Stops rearming itself once nothing is online — the next heartbeat rearms it. */
  async alarm(): Promise<void> {
    const cutoff = new Date(Date.now() - OFFLINE_AFTER_MS).toISOString();
    const stale = this.sql
      .exec("SELECT * FROM presence WHERE online = 1 AND last_seen_at < ?", cutoff)
      .toArray()
      .map((row) => fromSqlRow(row as unknown as PresenceSqlRow));

    for (const previous of stale) {
      const row: PresenceRow = { ...previous, online: false, updatedAt: nowIso() };
      this.putRow(row);
      this.broadcast(row);
      await this.recordTransition(row, "DEVICE_OFFLINE");
      this.forwardToGlobal(row);
    }

    const counted = this.sql
      .exec("SELECT COUNT(*) AS stillOnline FROM presence WHERE online = 1")
      .toArray()[0] as { stillOnline: number } | undefined;
    if ((counted?.stillOnline ?? 0) > 0) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }
}

/** `tenant:<tenantId>` — the authoritative instance for that tenant's devices. */
export function tenantPresenceStub(env: Bindings, tenantId: string): DurableObjectStub {
  return env.FLEET_PRESENCE.get(env.FLEET_PRESENCE.idFromName(`tenant:${tenantId}`));
}

/** `all` — the global mirror staff subscribe to. */
export function globalPresenceStub(env: Bindings): DurableObjectStub {
  return env.FLEET_PRESENCE.get(env.FLEET_PRESENCE.idFromName("all"));
}
