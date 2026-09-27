// Owner: WT-16. Module `realtime`, mounted at `/api/v1/realtime` in routes/v1/index.ts.
// GET /fleet: authenticated WebSocket upgrade onto the FleetPresence Durable Object (spec §5.3).
//
// Auth happens entirely here, in the Worker, before the DO ever sees the request. The DO never
// reads a tenant/staff id off anything the client supplied — `resolveRealtimeAccess()` below is
// the only place that decides which instance a caller may reach, from the caller's own session
// and `tenant_memberships`, never from a client-supplied id it can't verify.
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { getPrincipal, type Principal, setupPending } from "../../auth/middleware";
import { createDb, type Db } from "../../db/client";
import { tenantMemberships } from "../../db/schema";
import type { AppEnv } from "../../env";
import { globalPresenceStub, tenantPresenceStub } from "../../realtime/fleet-presence";
import { getActiveTenantId } from "./me";

export type RealtimeAccess = { kind: "global" } | { kind: "tenant"; tenantId: string };

/**
 * Staff holding `device.view` reach the global feed (or one tenant's, with `?tenant=`, mirroring
 * the Fleet screen's own `?tenant=` filter). A customer never reaches the global feed: an
 * explicit `?tenant=` must be one of their own *active* memberships (`forbidden` otherwise, same
 * status a cross-tenant Fleet screen request gets); with none given, their stored active tenant
 * (`me.ts`, re-validated live) if it's still active, else their sole active membership. A
 * customer with several memberships and neither an explicit nor a stored choice gets
 * `tenant_required` rather than an arbitrary pick — see the handoff for why this is a
 * deliberate scope-down, not a TODO.
 */
export async function resolveRealtimeAccess(
  db: Db,
  principal: Principal,
  requestedTenant: string | undefined,
): Promise<RealtimeAccess | "forbidden" | "tenant_required"> {
  if (principal.surface === "staff") {
    if (!principal.permissions.has("device.view")) return "forbidden";
    return requestedTenant ? { kind: "tenant", tenantId: requestedTenant } : { kind: "global" };
  }

  const rows = await db
    .select({ tenantId: tenantMemberships.tenantId })
    .from(tenantMemberships)
    .where(
      and(eq(tenantMemberships.userId, principal.user.id), eq(tenantMemberships.status, "active")),
    );
  const tenantIds = new Set(rows.map((r) => r.tenantId));
  if (tenantIds.size === 0) return "forbidden";

  if (requestedTenant) {
    return tenantIds.has(requestedTenant)
      ? { kind: "tenant", tenantId: requestedTenant }
      : "forbidden";
  }

  const active = await getActiveTenantId(db, principal.user.id);
  if (active && tenantIds.has(active)) return { kind: "tenant", tenantId: active };
  if (tenantIds.size === 1) {
    const [tenantId] = tenantIds;
    if (tenantId) return { kind: "tenant", tenantId };
  }
  return "tenant_required";
}

const realtime = new Hono<AppEnv>();

realtime.get("/fleet", async (c) => {
  const principal = await getPrincipal(c);
  if (!principal) return c.json({ error: "unauthenticated" }, 401);
  if (setupPending(principal)) {
    return c.json({ error: "setup_required", detail: principal.setup }, 403);
  }

  const db = createDb(c.env.DB);
  const access = await resolveRealtimeAccess(db, principal, c.req.query("tenant"));
  if (access === "forbidden") return c.json({ error: "forbidden" }, 403);
  if (access === "tenant_required") return c.json({ error: "tenant_required" }, 400);

  if ((c.req.header("upgrade") ?? "").toLowerCase() !== "websocket") {
    return c.json({ error: "upgrade_required" }, 426);
  }

  const stub =
    access.kind === "global"
      ? globalPresenceStub(c.env)
      : tenantPresenceStub(c.env, access.tenantId);
  return stub.fetch(c.req.raw);
});

export default realtime;
