// Owner: WT-3. GET /api/v1/screens/fleet?tenant=&online=&q=, GET /api/v1/screens/fleet/:deviceId.
//
// Two audiences can reach this screen (design/ux-patterns.md "Two audiences, two front doors" —
// admin-web is the staff front door; a customer front door is future work, not built here, but the
// API already accepts both): staff holding `device.view` see every tenant and may filter with
// `?tenant=`; a signed-in tenant member with no staff grant sees only their own tenant's devices and
// cannot widen that with `?tenant=` (docs/plans/briefs/WT-3-enrollment-devices.md "tenant filter for
// tenant-standing callers"). `requireTenantStanding()` cannot gate this route directly — it reads
// `:tenantId` from the path, and this route has none — so access is resolved by hand from
// `tenant_memberships` instead of the fixed per-tenant gate.
import { desc, eq, inArray, like, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { getPrincipal, setupPending } from "../../../auth/middleware";
import { createDb, type Db } from "../../../db/client";
import { auditLog, devices, entitlements, tenantMemberships, tenants } from "../../../db/schema";
import type { AppEnv } from "../../../env";
import { newestPerTenant, tenantPlanQuery, toTenantPlan } from "../../../onboarding/plan";

const ONLINE_WINDOW_MS = 2 * 60_000;

export type FleetAccess = { kind: "staff" } | { kind: "tenant"; tenantIds: string[] };

async function resolveFleetAccess(
  db: Db,
  userId: string,
  hasDeviceView: boolean,
): Promise<FleetAccess | null> {
  if (hasDeviceView) return { kind: "staff" };
  const rows = await db
    .select({ tenantId: tenantMemberships.tenantId })
    .from(tenantMemberships)
    .where(sql`${tenantMemberships.userId} = ${userId} AND ${tenantMemberships.status} = 'active'`);
  if (rows.length === 0) return null;
  return { kind: "tenant", tenantIds: rows.map((r) => r.tenantId) };
}

function licenseState(validUntil: string | null, now: string): "none" | "active" | "expired" {
  if (!validUntil) return "none";
  return validUntil > now ? "active" : "expired";
}

const rowid = sql<number>`${auditLog}.rowid`.mapWith(Number);

type FleetRow = {
  id: string;
  tenantId: string;
  name: string;
  status: "enrolled" | "revoked" | "transferred";
  hostname: string;
  windowsBuild: string | null;
  agentVersion: string | null;
  keyProtection: "tpm" | "software";
  lastSeenAt: string | null;
  enrolledAt: string;
  tenantCode: string;
  tenantName: string;
  licenseValidUntil: string | null;
};

export async function loadFleet(
  db: Db,
  access: FleetAccess,
  filters: { tenant?: string; online?: boolean; q?: string },
) {
  if (access.kind === "tenant" && filters.tenant && !access.tenantIds.includes(filters.tenant)) {
    return "forbidden" as const;
  }

  const tenantScope =
    access.kind === "tenant"
      ? inArray(devices.tenantId, access.tenantIds)
      : filters.tenant
        ? eq(devices.tenantId, filters.tenant)
        : undefined;
  const search = filters.q?.trim();
  const searchScope = search
    ? or(
        like(devices.name, `%${search}%`),
        like(devices.hostname, `%${search}%`),
        like(tenants.displayName, `%${search}%`),
      )
    : undefined;

  const licenseValidUntil = sql<string | null>`(
    SELECT ${entitlements.validUntil} FROM ${entitlements}
    WHERE ${entitlements.deviceId} = ${devices.id} AND ${entitlements.revokedAt} IS NULL
    ORDER BY ${entitlements.generation} DESC LIMIT 1
  )`;

  const rows = (await db
    .select({
      id: devices.id,
      tenantId: devices.tenantId,
      name: devices.name,
      status: devices.status,
      hostname: devices.hostname,
      windowsBuild: devices.windowsBuild,
      agentVersion: devices.agentVersion,
      keyProtection: devices.keyProtection,
      lastSeenAt: devices.lastSeenAt,
      enrolledAt: devices.enrolledAt,
      tenantCode: tenants.publicCode,
      tenantName: tenants.displayName,
      licenseValidUntil,
    })
    .from(devices)
    .innerJoin(tenants, eq(tenants.id, devices.tenantId))
    .where(
      tenantScope && searchScope
        ? sql`${tenantScope} AND ${searchScope}`
        : (tenantScope ?? searchScope),
    )
    .orderBy(desc(devices.enrolledAt))) as FleetRow[];

  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - ONLINE_WINDOW_MS).toISOString();

  const withOnline = rows.map((row) => ({
    ...row,
    online: row.lastSeenAt !== null && row.lastSeenAt >= cutoff,
    licenseState: licenseState(row.licenseValidUntil, now),
  }));

  const facets = {
    total: withOnline.length,
    online: withOnline.filter((r) => r.online).length,
    offline: withOnline.filter((r) => !r.online).length,
    degradedKey: withOnline.filter((r) => r.keyProtection === "software").length,
  };

  const items = withOnline
    .filter((row) => filters.online === undefined || row.online === filters.online)
    .map(({ licenseValidUntil: _lvu, ...row }) => row);

  // Lightweight tenant picker for the fleet filter and the Enrollment page — see the FleetScreen
  // contract doc comment for why this lives here instead of a real tenants list (WT-2).
  const tenantOptions = await db
    .select({ id: tenants.id, publicCode: tenants.publicCode, displayName: tenants.displayName })
    .from(tenants)
    .where(access.kind === "tenant" ? inArray(tenants.id, access.tenantIds) : undefined)
    .orderBy(tenants.displayName);

  return { items, facets, tenants: tenantOptions };
}

export async function loadFleetDetail(db: Db, access: FleetAccess, deviceId: string) {
  const [device] = await db
    .select({
      id: devices.id,
      tenantId: devices.tenantId,
      name: devices.name,
      status: devices.status,
      deviceKeyThumbprint: devices.deviceKeyThumbprint,
      keyProtection: devices.keyProtection,
      hostname: devices.hostname,
      windowsBuild: devices.windowsBuild,
      agentVersion: devices.agentVersion,
      lastSeenAt: devices.lastSeenAt,
      lastHealthJson: devices.lastHealthJson,
      enrolledAt: devices.enrolledAt,
      revokedAt: devices.revokedAt,
      licenseHoldReason: devices.licenseHoldReason,
      licenseHoldAt: devices.licenseHoldAt,
      licenseHoldBy: devices.licenseHoldBy,
      tenantCode: tenants.publicCode,
      tenantName: tenants.displayName,
    })
    .from(devices)
    .innerJoin(tenants, eq(tenants.id, devices.tenantId))
    .where(eq(devices.id, deviceId));

  if (!device) return "not_found" as const;
  if (access.kind === "tenant" && !access.tenantIds.includes(device.tenantId)) {
    return "forbidden" as const;
  }

  const [entitlementRows, auditRows, planRows] = await db.batch([
    db
      .select({
        id: entitlements.id,
        subscriptionId: entitlements.subscriptionId,
        generation: entitlements.generation,
        issuedAt: entitlements.issuedAt,
        validUntil: entitlements.validUntil,
        revokedAt: entitlements.revokedAt,
      })
      .from(entitlements)
      .where(eq(entitlements.deviceId, deviceId))
      .orderBy(desc(entitlements.generation)),
    db
      .select({
        rowid,
        id: auditLog.id,
        eventType: auditLog.eventType,
        entityType: auditLog.entityType,
        entityId: auditLog.entityId,
        actorType: auditLog.actorType,
        actorId: auditLog.actorId,
        actorTenantId: auditLog.actorTenantId,
        action: auditLog.action,
        beforeJson: auditLog.beforeJson,
        afterJson: auditLog.afterJson,
        correlationId: auditLog.correlationId,
        source: auditLog.source,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .where(sql`${auditLog.entityType} = 'device' AND ${auditLog.entityId} = ${deviceId}`)
      .orderBy(desc(rowid))
      .limit(25),
    // WT-14: the tenant's plan state for the License tab (same round trip).
    tenantPlanQuery(db, [device.tenantId]),
  ]);

  const now = new Date().toISOString();
  const latestValid = entitlementRows.find((e) => e.revokedAt === null)?.validUntil ?? null;
  const { lastHealthJson, licenseHoldReason, licenseHoldAt, licenseHoldBy, ...deviceFields } =
    device;

  return {
    device: {
      ...deviceFields,
      lastHealth: lastHealthJson ? JSON.parse(lastHealthJson) : null,
      licenseState: licenseState(latestValid, now),
      licenseHold: licenseHoldReason
        ? { reason: licenseHoldReason, at: licenseHoldAt, by: licenseHoldBy }
        : null,
    },
    entitlements: entitlementRows,
    plan: toTenantPlan(newestPerTenant(planRows).get(device.tenantId)),
    audit: auditRows.map(({ rowid: _rowid, beforeJson, afterJson, ...row }) => ({
      ...row,
      before: beforeJson ? JSON.parse(beforeJson) : null,
      after: afterJson ? JSON.parse(afterJson) : null,
    })),
  };
}

const fleet = new Hono<AppEnv>();

/** Not a `guard()`-based route (see the file's own doc comment for why), so it repeats guard()'s
 * session + first-sign-in-setup checks by hand (review S-6: every /api/v1 route mid-setup 403s). */
async function principalOrRefuse(c: Parameters<typeof getPrincipal>[0]) {
  const principal = await getPrincipal(c);
  if (!principal) return { refusal: c.json({ error: "unauthenticated" }, 401) } as const;
  if (setupPending(principal)) {
    return {
      refusal: c.json({ error: "setup_required", detail: principal.setup }, 403),
    } as const;
  }
  return { principal } as const;
}

fleet.get("/", async (c) => {
  const resolved = await principalOrRefuse(c);
  if ("refusal" in resolved) return resolved.refusal;
  const { principal } = resolved;
  c.set("user", principal.user);

  const db = createDb(c.env.DB);
  const access = await resolveFleetAccess(
    db,
    principal.user.id,
    principal.permissions.has("device.view"),
  );
  if (!access) return c.json({ error: "forbidden" }, 403);

  const tenant = c.req.query("tenant");
  const onlineParam = c.req.query("online");
  const result = await loadFleet(db, access, {
    tenant,
    online: onlineParam === undefined ? undefined : onlineParam === "true",
    q: c.req.query("q"),
  });
  if (result === "forbidden") return c.json({ error: "forbidden" }, 403);
  return c.json(result);
});

fleet.get("/:deviceId", async (c) => {
  const resolved = await principalOrRefuse(c);
  if ("refusal" in resolved) return resolved.refusal;
  const { principal } = resolved;
  c.set("user", principal.user);

  const db = createDb(c.env.DB);
  const access = await resolveFleetAccess(
    db,
    principal.user.id,
    principal.permissions.has("device.view"),
  );
  if (!access) return c.json({ error: "forbidden" }, 403);

  const result = await loadFleetDetail(db, access, c.req.param("deviceId"));
  if (result === "not_found") return c.json({ error: "not_found" }, 404);
  if (result === "forbidden") return c.json({ error: "forbidden" }, 403);
  return c.json(result);
});

export default fleet;
