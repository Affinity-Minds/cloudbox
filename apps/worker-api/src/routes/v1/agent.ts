// Owner: WT-3. Module `agent`, mounted at `/api/v1/agent` in routes/v1/index.ts.
// Routes: POST /enroll (unauthenticated, token-gated), POST /heartbeat, GET /entitlement (Bearer
// device-token via requireDevice(), which 401s once revoked), POST /uninstalled (Bearer
// device-token via its own idempotent lookup — see below).
//
// Agent API contract is fixed (packages/contracts/src/agent.ts) — the Windows agent (WT-4) is
// built against it in parallel. `AgentHealth`'s nullable fields (merged from origin/phase-1/identity)
// mean "the agent cannot determine this yet"; heartbeat stores the document as-is and callers must
// render null as "unknown", never 0 or "Offline" (see apps/admin-web fleet detail health tab).
import {
  type AgentHealth,
  EnrollRequest,
  type EnrollResponse,
  HeartbeatRequest,
  type HeartbeatResponse,
} from "@cloudbox/contracts";
import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { calculateJwkThumbprint } from "jose";
import { audit } from "../../audit";
import { isUniqueConstraintError, randomOpaqueToken, sha256Hex } from "../../crypto";
import { createDb, type Db } from "../../db/client";
import { deviceCredentials, devices, enrollmentTokens, tenants } from "../../db/schema";
import { checkEnrollRateLimit } from "../../devices/enroll-rate-limit";
import { nextDeviceName } from "../../devices/naming";
import { bearerToken, requireDevice, resolveDevice } from "../../devices/require-device";
// Owner: WT-5. The single source of "what entitlement does this device currently hold" — highest
// generation, or null if there is none or the highest one is revoked (never falls back to an
// older generation). Heartbeat and GET /entitlement both read through this, not the table directly.
import { currentEntitlementForDevice } from "../../entitlement/service";
import type { AppDevice, AppEnv, Bindings } from "../../env";
import { newId, nowIso } from "../../ids";
// WT-9 (ADR 0007): mints this server's NetBird setup key at activation; revokes its peer/key on
// uninstall. A no-op (see mintServerSetupKey/revokeDevicePeer) while NETBIRD_API_URL is unset.
import { mintServerSetupKey, revokeDevicePeer } from "../../network/controller";
// WT-14 (ADR 0011): plan redemption + licence generation at activation, auto-issuance on heartbeat.
import { activateLicense } from "../../onboarding/activation";

const INVALID_TOKEN_ERROR = "invalid_enrollment_token" as const;

type EnrollOutcome =
  | { ok: true; response: EnrollResponse }
  | { ok: false; status: 400 | 409; error: string };

export async function enrollDevice(db: Db, input: EnrollRequest): Promise<EnrollOutcome> {
  const tokenHash = await sha256Hex(input.token);
  const [tokenRow] = await db
    .select({
      id: enrollmentTokens.id,
      tenantId: enrollmentTokens.tenantId,
      expiresAt: enrollmentTokens.expiresAt,
      redeemedAt: enrollmentTokens.redeemedAt,
      revokedAt: enrollmentTokens.revokedAt,
      tenantCode: tenants.publicCode,
    })
    .from(enrollmentTokens)
    .innerJoin(tenants, eq(tenants.id, enrollmentTokens.tenantId))
    .where(eq(enrollmentTokens.tokenHash, tokenHash));

  const now = nowIso();
  if (
    !tokenRow ||
    tokenRow.expiresAt <= now ||
    tokenRow.redeemedAt !== null ||
    tokenRow.revokedAt !== null
  ) {
    return { ok: false, status: 400, error: INVALID_TOKEN_ERROR };
  }

  const thumbprint = await calculateJwkThumbprint(input.device.publicKeyJwk, "sha256");
  const deviceId = newId("device");
  const deviceName = await nextDeviceName(db);

  // Conditional update run alone, then checked, before anything else touches the database
  // (agent-notes cloudflare-workers "a transaction cannot be made conditional on one row changed"):
  // `db.batch` would still commit even if this WHERE matched zero rows. It can't set
  // `redeemed_device_id` yet — that column's FK requires the device row to already exist, and the
  // device doesn't exist until the batch below.
  const [redeemed] = await db
    .update(enrollmentTokens)
    .set({ redeemedAt: now })
    .where(
      and(
        eq(enrollmentTokens.id, tokenRow.id),
        isNull(enrollmentTokens.redeemedAt),
        isNull(enrollmentTokens.revokedAt),
      ),
    )
    .returning({ id: enrollmentTokens.id });

  if (!redeemed) {
    // Someone else redeemed/revoked it between our read and this write.
    return { ok: false, status: 400, error: INVALID_TOKEN_ERROR };
  }

  const deviceToken = randomOpaqueToken();
  try {
    await db.batch([
      db.insert(devices).values({
        id: deviceId,
        tenantId: tokenRow.tenantId,
        name: deviceName,
        status: "enrolled",
        devicePublicKeyJwk: JSON.stringify(input.device.publicKeyJwk),
        deviceKeyThumbprint: thumbprint,
        keyProtection: input.device.keyProtection,
        hostname: input.device.hostname,
        windowsBuild: input.device.windowsBuild,
        agentVersion: input.device.agentVersion,
        enrolledAt: now,
      }),
      db.insert(deviceCredentials).values({
        id: newId("deviceCredential"),
        deviceId,
        tokenHash: await sha256Hex(deviceToken),
        createdAt: now,
      }),
      // Same transaction, runs after the device insert above, so the FK is satisfied.
      db
        .update(enrollmentTokens)
        .set({ redeemedDeviceId: deviceId })
        .where(eq(enrollmentTokens.id, tokenRow.id)),
      audit(db, {
        eventType: "DEVICE_ENROLLED",
        entityType: "device",
        entityId: deviceId,
        actor: { type: "device", id: deviceId, tenantId: tokenRow.tenantId },
        before: null,
        after: { hostname: input.device.hostname, name: deviceName },
        source: "agent",
      }),
    ]);
  } catch (error) {
    // Compensate: give the token back so a genuine retry (not a duplicate key) can redeem it.
    await db
      .update(enrollmentTokens)
      .set({ redeemedAt: null })
      .where(eq(enrollmentTokens.id, tokenRow.id));

    if (isUniqueConstraintError(error, "device_key_thumbprint")) {
      return { ok: false, status: 409, error: "device_already_enrolled" };
    }
    throw error;
  }

  return {
    ok: true,
    response: {
      deviceId,
      tenantId: tokenRow.tenantId,
      tenantCode: tokenRow.tenantCode,
      deviceName,
      deviceToken,
    },
  };
}

export async function recordHeartbeat(
  db: Db,
  device: AppDevice,
  health: AgentHealth,
): Promise<HeartbeatResponse> {
  const now = nowIso();
  await db
    .update(devices)
    .set({
      lastSeenAt: now,
      lastHealthJson: JSON.stringify(health),
      agentVersion: health.agent.version,
    })
    .where(eq(devices.id, device.id));

  const entitlement = await currentEntitlementForDevice(db, device.id);

  return {
    serverTime: now,
    entitlementGeneration: entitlement?.generation ?? null,
    commands: [],
  };
}

export async function uninstallDevice(env: Bindings, db: Db, device: AppDevice): Promise<void> {
  const [current] = await db
    .select({ status: devices.status })
    .from(devices)
    .where(eq(devices.id, device.id));
  if (!current || current.status === "revoked") return; // idempotent

  const now = nowIso();
  await db.batch([
    db.update(devices).set({ status: "revoked", revokedAt: now }).where(eq(devices.id, device.id)),
    db
      .update(deviceCredentials)
      .set({ revokedAt: now })
      .where(and(eq(deviceCredentials.deviceId, device.id), isNull(deviceCredentials.revokedAt))),
    audit(db, {
      eventType: "DEVICE_UNINSTALLED",
      entityType: "device",
      entityId: device.id,
      actor: { type: "device", id: device.id, tenantId: device.tenantId },
      before: { status: current.status },
      after: { status: "revoked" },
      source: "agent",
    }),
  ]);
  // Best-effort: an unreachable NetBird server must not fail the uninstall itself.
  await revokeDevicePeer(env, db, device.id).catch((error: unknown) => {
    console.error("uninstallDevice: peer revocation failed", device.id, error);
  });
}

const agent = new Hono<AppEnv>();

agent.post(
  "/enroll",
  zValidator("json", EnrollRequest, (result, c) => {
    if (!result.success) return c.json({ error: "invalid_request" }, 400);
  }),
  async (c) => {
    const db = createDb(c.env.DB);
    const ip = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? "unknown";
    const withinLimit = await checkEnrollRateLimit(db, ip);
    if (!withinLimit) return c.json({ error: "rate_limited" }, 429);

    const outcome = await enrollDevice(db, c.req.valid("json"));
    if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
    // Activation: redeem the tenant's pending plan (first server only) and issue this device's
    // entitlement. The device is enrolled whatever the licence outcome.
    const { deviceId, tenantId } = outcome.response;
    const licence = await activateLicense(
      c.env,
      db,
      { id: deviceId, tenantId },
      { source: "activation", correlationId: c.var.correlationId },
    ).catch((error: unknown) => {
      console.error("enroll: activation failed", deviceId, error);
      return { generation: null } as Awaited<ReturnType<typeof activateLicense>>;
    });
    // WT-9: mint this server's NetBird setup key. Best-effort — a NetBird hiccup must not fail
    // enrollment; the agent simply gets no `network` field and skips the Netclient install.
    const network = await mintServerSetupKey(c.env, db, { deviceId, tenantId }).catch(
      (error: unknown) => {
        console.error("enroll: network provisioning failed", deviceId, error);
        return { configured: false } as const;
      },
    );
    return c.json(
      {
        ...outcome.response,
        ...(licence.licenseState ? { licenseState: licence.licenseState } : {}),
        ...(licence.message ? { message: licence.message } : {}),
        ...(network.configured
          ? { network: { setupKey: network.setupKey, managementUrl: network.managementUrl } }
          : {}),
      },
      201,
    );
  },
);

agent.post(
  "/heartbeat",
  requireDevice(),
  zValidator("json", HeartbeatRequest, (result, c) => {
    if (!result.success) return c.json({ error: "invalid_request" }, 400);
  }),
  async (c) => {
    const { health } = c.req.valid("json");
    const db = createDb(c.env.DB);
    const response = await recordHeartbeat(db, c.var.device, health);
    if (response.entitlementGeneration !== null) {
      return c.json({ ...response, licenseState: "licensed" as const });
    }
    // No live entitlement: redeem/issue if the tenant's plan allows it (WT-14 auto-issuance).
    const licence = await activateLicense(c.env, db, c.var.device, {
      source: "auto",
      correlationId: c.var.correlationId,
    }).catch((error: unknown) => {
      console.error("heartbeat: auto-issuance failed", c.var.device.id, error);
      return { generation: null } as Awaited<ReturnType<typeof activateLicense>>;
    });
    return c.json({
      ...response,
      entitlementGeneration: licence.generation,
      ...(licence.licenseState ? { licenseState: licence.licenseState } : {}),
      ...(licence.message ? { message: licence.message } : {}),
    });
  },
);

agent.get("/entitlement", requireDevice(), async (c) => {
  const entitlement = await currentEntitlementForDevice(createDb(c.env.DB), c.var.device.id);
  c.header("Cache-Control", "no-store"); // the compact JWE is a confidential artefact
  if (!entitlement) return c.json({ error: "not_found" }, 404);
  return c.json({ entitlement: entitlement.token, generation: entitlement.generation });
});

// Not requireDevice(): a retried uninstall call must still 204 after the device (and its
// credential) are already revoked, so the lookup here tolerates a revoked-but-real credential —
// see resolveDevice()'s `allowRevoked` doc comment.
agent.post("/uninstalled", async (c) => {
  const db = createDb(c.env.DB);
  const token = bearerToken(c.req.header("authorization"));
  if (!token) return c.json({ error: "unauthenticated" }, 401);

  const device = await resolveDevice(db, token, { allowRevoked: true });
  if (!device) return c.json({ error: "unauthenticated" }, 401);

  await uninstallDevice(c.env, db, device);
  return c.body(null, 204);
});

export default agent;
