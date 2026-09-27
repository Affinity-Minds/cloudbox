// Owner: WT-19. `seedDevice` (test/fixtures.ts) inserts a `devices` row but no credential — every
// existing consumer authenticates as staff/customer, never as the device itself. Backups routes
// are device-Bearer (`requireDevice()`), so tests need a real, hashed credential the same way
// `POST /agent/enroll` creates one (WT-3's `devices/require-device.ts`), without going through the
// enroll HTTP flow just to get a token.
import { sha256Hex } from "../src/crypto";
import { createDb } from "../src/db/client";
import { deviceCredentials } from "../src/db/schema";
import { newId, nowIso } from "../src/ids";

export async function issueDeviceToken(
  env: { DB: D1Database },
  deviceId: string,
): Promise<{ token: string; headers: Record<string, string> }> {
  const db = createDb(env.DB);
  const token = crypto.randomUUID() + crypto.randomUUID();
  await db.insert(deviceCredentials).values({
    id: newId("deviceCredential"),
    deviceId,
    tokenHash: await sha256Hex(token),
    createdAt: nowIso(),
  });
  return { token, headers: { authorization: `Bearer ${token}` } };
}
