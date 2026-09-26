// Owner: WT-14. Self-service onboarding (ADR 0011), mounted with one line at `/api/v1` in
// routes/v1/index.ts; every path is spelled out here and every route carries its own gate
// (prefixes nest: never `use("*")`).
//
//   GET  /onboarding/config               public          Turnstile site key for /start
//   GET  /onboarding/overview             customer        the portal's tenant cards + plan state
//   POST /onboarding/tenants              customer        tenant self-creation (caller = owner)
//   POST /onboarding/redeem               customer        licence key → tenant + pending plan
//   POST /onboarding/activation-grants    customer, Owner/Admin of body.tenantId
//   GET  /connect/devices                 customer, active member   CloudBox Connect device list
//   POST /license-keys/batches            staff license.issue       plaintext keys once (JSON/CSV)
//   GET  /license-keys                    staff license.issue or subscription.view
//   POST /license-keys/:id/revoke         staff license.revoke
import {
  ActivationGrantRequest,
  type ActivationGrantResponse,
  type ConnectDevicesResponse,
  CreateOwnTenantRequest,
  type CreateOwnTenantResponse,
  GenerateLicenseKeysRequest,
  LicenseKeysQuery,
  type OnboardingOverview,
  RedeemLicenseKeyRequest,
  RevokeLicenseKeyRequest,
} from "@cloudbox/contracts";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { guardFor, requireUser } from "../../auth/middleware";
import { getTenantStanding, requirePermission } from "../../authz/permissions";
import { createDb } from "../../db/client";
import { devices, tenantMemberships, tenants } from "../../db/schema";
import type { AppEnv } from "../../env";
import { newId, nowIso } from "../../ids";
import {
  allocateTenantCode,
  clientOf,
  LIMITS,
  ownedTenantStatements,
  setActiveTenant,
  withinLimit,
} from "../../onboarding/common";
import {
  generateLicenseKeys,
  LicenseKeyRefusal,
  licenseKeysCsv,
  listLicenseKeys,
  redeemLicenseKey,
  revokeLicenseKey,
} from "../../onboarding/license-keys";
import { newestPerTenant, tenantPlanQuery, toTenantPlan } from "../../onboarding/plan";
import { createEnrollmentToken } from "./enrollment";
import { getActiveTenantId } from "./me";
import { loadFleet } from "./screens/fleet";
import { validate } from "./subscriptions";

/** Self-activation grants live 15 minutes (owner decision C). */
export const ACTIVATION_GRANT_TTL_MINUTES = 15;

const GRANTABLE_TENANT_STATUSES = new Set(["provisioning", "active", "trial"]);

/**
 * Lifetime cap on self-created tenants that still have no plan, per customer (review P2-6): a
 * throwaway identity cannot mint tenant codes without limit. Attaching a plan frees the slot.
 */
export const SELF_TENANTS_WITHOUT_PLAN_MAX = 5;

const router = new Hono<AppEnv>();
const rateLimited = { error: "rate_limited" as const };

// ─── onboarding ──────────────────────────────────────────────────────────────────────────────

router.get("/onboarding/config", (c) =>
  c.json({ turnstileSiteKey: c.env.TURNSTILE_SITE_KEY || null }),
);

router.get("/onboarding/overview", requireUser(), async (c) => {
  const db = createDb(c.env.DB);
  const user = c.var.user;
  const [memberships, activeTenantId] = await Promise.all([
    db
      .select({
        tenantId: tenants.id,
        tenantCode: tenants.publicCode,
        displayName: tenants.displayName,
        tenantStatus: tenants.status,
        standing: tenantMemberships.standing,
        enrolledDevices: sql<number>`(
          SELECT count(*) FROM ${devices}
          WHERE ${devices.tenantId} = ${tenants.id} AND ${devices.status} = 'enrolled'
        )`.mapWith(Number),
      })
      .from(tenantMemberships)
      .innerJoin(tenants, eq(tenants.id, tenantMemberships.tenantId))
      .where(and(eq(tenantMemberships.userId, user.id), eq(tenantMemberships.status, "active")))
      .orderBy(tenants.createdAt),
    getActiveTenantId(db, user.id),
  ]);
  const plans = newestPerTenant(
    await tenantPlanQuery(
      db,
      memberships.map((m) => m.tenantId),
    ),
  );
  const now = new Date();
  const body: OnboardingOverview = {
    email: user.email,
    activeTenantId,
    tenants: memberships.map((m) => ({ ...m, plan: toTenantPlan(plans.get(m.tenantId), now) })),
  };
  return c.json(body);
});

router.post(
  "/onboarding/tenants",
  requireUser(),
  validate("json", CreateOwnTenantRequest),
  async (c) => {
    const input = c.req.valid("json");
    const db = createDb(c.env.DB);
    const user = c.var.user;
    if (!(await withinLimit(db, LIMITS.tenantsPerUser, user.id))) {
      return c.json(rateLimited, 429);
    }
    const owned = await db.get<{ n: number }>(sql`
      SELECT count(*) AS n FROM tenant_memberships m
      WHERE m.user_id = ${user.id} AND m.status = 'active' AND m.standing = 'owner'
        AND m.invited_by = ${user.id}
        AND NOT EXISTS (SELECT 1 FROM subscriptions s
                        WHERE s.tenant_id = m.tenant_id AND s.status <> 'cancelled')`);
    if ((owned?.n ?? 0) >= SELF_TENANTS_WITHOUT_PLAN_MAX) {
      return c.json({ error: "tenant_limit_reached" }, 409);
    }
    const now = nowIso();
    const tenantId = newId("tenant");
    const tenantCode = await allocateTenantCode(db, now);
    await db.batch([
      ...ownedTenantStatements(db, {
        tenantId,
        tenantCode,
        userId: user.id,
        email: user.email,
        displayName: input.displayName,
        timezone: input.timezone,
        source: "self_onboarding",
        correlationId: c.var.correlationId,
        now,
      }),
    ]);
    await setActiveTenant(db, user.id, tenantId, now);
    return c.json({ tenantId, tenantCode } satisfies CreateOwnTenantResponse, 201);
  },
);

router.post(
  "/onboarding/redeem",
  requireUser(),
  validate("json", RedeemLicenseKeyRequest),
  async (c) => {
    const input = c.req.valid("json");
    const db = createDb(c.env.DB);
    const user = c.var.user;
    // Every attempt counts, per client and per customer (guessing a 100-bit key is hopeless; this
    // bounds the noise and the audit/DB work).
    const [clientOk, userOk] = [
      await withinLimit(db, LIMITS.redeemPerClient, clientOf(c)),
      await withinLimit(db, LIMITS.redeemPerUser, user.id),
    ];
    if (!clientOk || !userOk) return c.json(rateLimited, 429);
    try {
      const result = await redeemLicenseKey(db, {
        code: input.code,
        displayName: input.displayName,
        timezone: input.timezone,
        userId: user.id,
        email: user.email,
        correlationId: c.var.correlationId,
      });
      await setActiveTenant(db, user.id, result.tenantId, nowIso());
      return c.json(
        {
          tenantId: result.tenantId,
          tenantCode: result.tenantCode,
        } satisfies CreateOwnTenantResponse,
        201,
      );
    } catch (error) {
      if (error instanceof LicenseKeyRefusal) return c.json({ error: error.code }, error.status);
      throw error;
    }
  },
);

router.post(
  "/onboarding/activation-grants",
  requireUser(),
  validate("json", ActivationGrantRequest),
  async (c) => {
    const input = c.req.valid("json");
    const db = createDb(c.env.DB);
    const user = c.var.user;
    // Owner/Admin standing on that tenant, re-resolved from tenant_memberships now.
    const standing = await getTenantStanding(c, input.tenantId);
    if (standing !== "owner" && standing !== "admin") return c.json({ error: "forbidden" }, 403);
    const [tenant] = await db
      .select({ code: tenants.publicCode, status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, input.tenantId));
    if (!tenant) return c.json({ error: "not_found" }, 404);
    // Only a tenant being set up or in service can enroll servers (review P2-4): suspended,
    // past_due, cancelled and archived tenants are refused.
    if (!GRANTABLE_TENANT_STATUSES.has(tenant.status)) {
      return c.json({ error: "tenant_not_active" }, 403);
    }
    if (!(await withinLimit(db, LIMITS.grantsPerUser, user.id))) {
      return c.json(rateLimited, 429);
    }
    const token = await createEnrollmentToken(db, {
      tenantId: input.tenantId,
      label: `self-activation by ${user.email}`,
      expiresInHours: ACTIVATION_GRANT_TTL_MINUTES / 60,
      createdBy: user.id,
      correlationId: c.var.correlationId,
      source: "self_activation",
      auditAfter: { source: "self_activation", deviceLabel: input.deviceLabel ?? null },
    });
    const body: ActivationGrantResponse = {
      grant: token.token,
      enrollmentTokenId: token.id,
      tenantId: input.tenantId,
      tenantCode: tenant.code,
      expiresAt: token.expiresAt,
    };
    c.header("Cache-Control", "no-store");
    return c.json(body, 201);
  },
);

// ─── connect ─────────────────────────────────────────────────────────────────────────────────

router.get("/connect/devices", requireUser(), async (c) => {
  const db = createDb(c.env.DB);
  const user = c.var.user;
  const tenantId = c.req.query("tenantId") || (await getActiveTenantId(db, user.id));
  if (!tenantId) return c.json({ error: "no_active_tenant" }, 409);
  // Membership re-resolved per request; a tenant the caller is not in is simply forbidden.
  const [row] = await db
    .select({ code: tenants.publicCode, name: tenants.displayName })
    .from(tenantMemberships)
    .innerJoin(tenants, eq(tenants.id, tenantMemberships.tenantId))
    .where(
      and(
        eq(tenantMemberships.tenantId, tenantId),
        eq(tenantMemberships.userId, user.id),
        eq(tenantMemberships.status, "active"),
      ),
    );
  if (!row) return c.json({ error: "forbidden" }, 403);
  const [fleet, planRows] = await Promise.all([
    loadFleet(db, { kind: "tenant", tenantIds: [tenantId] }, {}),
    tenantPlanQuery(db, [tenantId]),
  ]);
  const items = fleet === "forbidden" ? [] : fleet.items;
  const body: ConnectDevicesResponse = {
    tenantId,
    tenantCode: row.code,
    tenantName: row.name,
    plan: toTenantPlan(newestPerTenant(planRows).get(tenantId)),
    devices: items
      .filter((d) => d.status === "enrolled")
      .map((d) => ({
        deviceId: d.id,
        name: d.name,
        hostname: d.hostname,
        online: d.online,
        lastSeenAt: d.lastSeenAt,
        licenseState: d.licenseState,
      })),
  };
  return c.json(body);
});

// ─── license keys (staff) ────────────────────────────────────────────────────────────────────

router.post(
  "/license-keys/batches",
  requirePermission("license.issue"),
  validate("json", GenerateLicenseKeysRequest),
  async (c) => {
    try {
      const batch = await generateLicenseKeys(createDb(c.env.DB), {
        ...c.req.valid("json"),
        createdBy: c.var.user.id,
        correlationId: c.var.correlationId,
      });
      c.header("Cache-Control", "no-store");
      if ((c.req.header("accept") ?? "").includes("text/csv")) {
        c.header("Content-Type", "text/csv; charset=utf-8");
        c.header(
          "Content-Disposition",
          `attachment; filename="cloudbox-licence-keys-${batch.batchId}.csv"`,
        );
        return c.body(licenseKeysCsv(batch), 201);
      }
      return c.json(batch, 201);
    } catch (error) {
      if (error instanceof LicenseKeyRefusal) return c.json({ error: error.code }, error.status);
      throw error;
    }
  },
);

router.get(
  "/license-keys",
  // Support looks keys up by their last four symbols (docs/runbooks/license-keys.md).
  guardFor(
    "staff",
    (p) => p.permissions.has("license.issue") || p.permissions.has("subscription.view"),
  ),
  validate("query", LicenseKeysQuery),
  async (c) => c.json(await listLicenseKeys(createDb(c.env.DB), c.req.valid("query"))),
);

router.post(
  "/license-keys/:id/revoke",
  requirePermission("license.revoke"),
  validate("json", RevokeLicenseKeyRequest),
  async (c) => {
    try {
      await revokeLicenseKey(createDb(c.env.DB), {
        id: c.req.param("id"),
        reason: c.req.valid("json").reason,
        actorId: c.var.user.id,
        correlationId: c.var.correlationId,
      });
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof LicenseKeyRefusal) return c.json({ error: error.code }, error.status);
      throw error;
    }
  },
);

export default router;
