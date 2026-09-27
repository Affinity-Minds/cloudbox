// Owner: WT-3. Module `devices`, mounted at `/api/v1/devices` in routes/v1/index.ts.
// Routes: POST /:deviceId/revoke, gated `device.manage` (WT-1's `requirePermission`, currently a
// 501 stub — see docs/handoffs/foundation.md "Authorization dependency").
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { audit } from "../../audit";
import { requirePermission } from "../../authz/permissions";
import { createDb, type Db } from "../../db/client";
import { deviceCredentials, devices } from "../../db/schema";
import type { AppEnv, Bindings } from "../../env";
import { nowIso } from "../../ids";
// WT-9 (ADR 0007): removes the device's NetBird peer/setup key. No-op while NetBird is unconfigured.
import { revokeDevicePeer } from "../../network/controller";

export type RevokeDeviceResult = "revoked" | "already_revoked" | "not_found";

export async function revokeDevice(
  env: Bindings,
  db: Db,
  input: { deviceId: string; actorId: string; correlationId?: string | null },
): Promise<RevokeDeviceResult> {
  const [device] = await db
    .select({ status: devices.status, tenantId: devices.tenantId })
    .from(devices)
    .where(eq(devices.id, input.deviceId));
  if (!device) return "not_found";
  if (device.status === "revoked") return "already_revoked";

  const now = nowIso();
  await db.batch([
    db
      .update(devices)
      .set({ status: "revoked", revokedAt: now })
      .where(eq(devices.id, input.deviceId)),
    db
      .update(deviceCredentials)
      .set({ revokedAt: now })
      .where(
        and(eq(deviceCredentials.deviceId, input.deviceId), isNull(deviceCredentials.revokedAt)),
      ),
    audit(db, {
      eventType: "DEVICE_REVOKED",
      entityType: "device",
      entityId: input.deviceId,
      actor: { type: "user", id: input.actorId, tenantId: device.tenantId },
      before: { status: device.status },
      after: { status: "revoked" },
      correlationId: input.correlationId,
      source: "api",
    }),
  ]);
  // Best-effort: an unreachable NetBird server must not fail the device revoke itself.
  await revokeDevicePeer(env, db, input.deviceId).catch((error: unknown) => {
    console.error("revokeDevice: peer revocation failed", input.deviceId, error);
  });
  return "revoked";
}

const devicesRoute = new Hono<AppEnv>();

devicesRoute.post("/:deviceId/revoke", requirePermission("device.manage"), async (c) => {
  const result = await revokeDevice(c.env, createDb(c.env.DB), {
    deviceId: c.req.param("deviceId"),
    actorId: c.var.user.id,
    correlationId: c.var.correlationId,
  });
  if (result === "not_found") return c.json({ error: "not_found" }, 404);
  return c.body(null, 204);
});

export default devicesRoute;
