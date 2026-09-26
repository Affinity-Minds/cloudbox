// Owner: WT-3. Bearer-device-token gate for `/api/v1/agent/*` (everything except `/enroll`,
// which is token-gated instead — see routes/v1/agent.ts). No staff session involved: the Windows
// agent authenticates with the opaque device token it received from `POST /agent/enroll`.
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { sha256Hex } from "../crypto";
import type { Db } from "../db/client";
import { createDb } from "../db/client";
import { deviceCredentials, devices } from "../db/schema";
import type { AppDevice, AppEnv } from "../env";

const BEARER_PREFIX = /^Bearer\s+/i;

export function bearerToken(header: string | undefined): string | null {
  if (!header || !BEARER_PREFIX.test(header)) return null;
  const token = header.replace(BEARER_PREFIX, "").trim();
  return token || null;
}

/**
 * Looks the device credential up by its hash. `allowRevoked` matches even a revoked credential
 * (still requires the real, once-issued token — not a forgery) for `POST /agent/uninstalled`,
 * which must answer 204 idempotently on a retried call after the device is already revoked
 * (docs/plans/briefs/WT-3-enrollment-devices.md "idempotent"). Every other `/agent/*` route uses
 * the default (`allowRevoked: false`): a revoked device or credential is 401, full stop.
 */
export async function resolveDevice(
  db: Db,
  token: string,
  options: { allowRevoked?: boolean } = {},
): Promise<AppDevice | null> {
  const tokenHash = await sha256Hex(token);
  const [row] = await db
    .select({ deviceId: devices.id, tenantId: devices.tenantId, status: devices.status, revokedAt: deviceCredentials.revokedAt })
    .from(deviceCredentials)
    .innerJoin(devices, eq(devices.id, deviceCredentials.deviceId))
    .where(eq(deviceCredentials.tokenHash, tokenHash))
    .limit(1);

  if (!row) return null;
  if (!options.allowRevoked && (row.revokedAt !== null || row.status !== "enrolled")) return null;
  return { id: row.deviceId, tenantId: row.tenantId };
}

/**
 * Resolves the Bearer device token into `c.var.device`; 401 `{error:'unauthenticated'}` when the
 * header is missing/malformed, the token is unknown or revoked, or the device itself is revoked.
 */
export function requireDevice(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = bearerToken(c.req.header("authorization"));
    if (!token) return c.json({ error: "unauthenticated" }, 401);

    const device = await resolveDevice(createDb(c.env.DB), token);
    if (!device) return c.json({ error: "unauthenticated" }, 401);

    c.set("device", device);
    await next();
  };
}
