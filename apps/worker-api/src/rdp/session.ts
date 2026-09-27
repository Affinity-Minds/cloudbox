// Owner: WT-11. RDP session credential broker, cloud side (ADR 0013, docs/decisions/0013-*.md).
//
// `grantSession` implements the minimal cloud half of "CloudBox Connect launches mstsc without ever
// putting a password on a command line": pick the lowest managed-user slot (`cloudNN`) that has no
// live grant for this device, mint a random password, hand the plaintext to the caller once, and
// store only its hash plus a copy encrypted to the device's own RSA public key (so a later
// heartbeat can queue it for the Agent without the cloud ever holding the plaintext again).
//
// `pendingCommandsForDevice` is read by `routes/v1/agent.ts`'s heartbeat handler (additive; see its
// header comment) to fill `HeartbeatResponse.commands`.
import {
  effectiveMaxManagedUsers,
  managedUserName,
  type SetManagedUserPasswordCommand,
} from "@cloudbox/contracts";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { CompactEncrypt, importJWK } from "jose";
import { audit } from "../audit";
import { sha256Hex } from "../crypto";
import type { Db } from "../db/client";
import { devices, plans, subscriptions, tenantMemberships } from "../db/schema";
import { newId, nowIso } from "../ids";
import { rdpSessionGrants } from "./session-grants-table";

/** Same key management scheme as the entitlement envelope (`@cloudbox/licensing-contracts`). */
const KEY_MANAGEMENT_ALG = "RSA-OAEP-256";
const CONTENT_ENCRYPTION = "A256GCM";

/** Grants are good for 15 minutes — long enough for a heartbeat cycle to deliver them and mstsc to launch. */
export const RDP_SESSION_TTL_MINUTES = 15;

export type SessionRefusalCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "device_not_enrolled"
  | "no_active_subscription"
  | "no_free_slot"
  | "device_key_unusable";

export class SessionRefusal extends Error {
  override readonly name = "SessionRefusal";
  constructor(
    readonly status: 403 | 404 | 409 | 422,
    readonly code: SessionRefusalCode,
  ) {
    super(code);
  }
}

/** Cryptographically random password meeting Windows default complexity (3 of 4 classes), 20 chars. */
function randomManagedPassword(): string {
  const classes = [
    "ABCDEFGHJKLMNPQRSTUVWXYZ",
    "abcdefghijkmnpqrstuvwxyz",
    "23456789",
    "!@#$%^&*-_=+",
  ];
  const all = classes.join("");
  const length = 20;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    const pwd = Array.from(bytes, (b) => all[b % all.length]).join("");
    if (classes.every((set) => [...pwd].some((ch) => set.includes(ch)))) return pwd;
  }
  // Astronomically unlikely; fall back to a password built one character per class then padded.
  return classes
    .map((set) => set.charAt((crypto.getRandomValues(new Uint8Array(1)).at(0) ?? 0) % set.length))
    .join("");
}

async function encryptToDevice(devicePublicKeyJwk: string, password: string): Promise<string> {
  let jwk: { n?: string; e?: string };
  try {
    jwk = JSON.parse(devicePublicKeyJwk);
  } catch {
    throw new SessionRefusal(422, "device_key_unusable");
  }
  try {
    const key = await importJWK({ kty: "RSA", n: jwk.n, e: jwk.e }, KEY_MANAGEMENT_ALG);
    const plaintext = new TextEncoder().encode(JSON.stringify({ password }));
    return await new CompactEncrypt(plaintext)
      .setProtectedHeader({ alg: KEY_MANAGEMENT_ALG, enc: CONTENT_ENCRYPTION, cty: "json" })
      .encrypt(key);
  } catch {
    throw new SessionRefusal(422, "device_key_unusable");
  }
}

/** The tenant (any active standing) the caller belongs to, or null. */
export async function activeMembership(db: Db, tenantId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: tenantMemberships.id })
    .from(tenantMemberships)
    .where(
      and(
        eq(tenantMemberships.tenantId, tenantId),
        eq(tenantMemberships.userId, userId),
        eq(tenantMemberships.status, "active"),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export type GrantSessionResult = {
  deviceId: string;
  user: string;
  password: string;
  expiresAt: string;
};

/**
 * Mints a managed-user RDP credential for `deviceId` on behalf of `userId`. The caller must already
 * be proven an active member of the device's tenant (checked by the route via `activeMembership`,
 * same as `GET /connect/devices` — both read `tenant_memberships` fresh, so a membership revoked a
 * moment ago is refused here too, not just hidden from the list).
 */
export async function grantSession(
  db: Db,
  input: { deviceId: string; tenantId: string; userId: string; correlationId?: string | null },
  now = new Date(),
): Promise<GrantSessionResult> {
  const [device] = await db
    .select({
      id: devices.id,
      tenantId: devices.tenantId,
      status: devices.status,
      devicePublicKeyJwk: devices.devicePublicKeyJwk,
    })
    .from(devices)
    .where(eq(devices.id, input.deviceId));
  if (!device || device.tenantId !== input.tenantId) throw new SessionRefusal(404, "not_found");
  if (device.status !== "enrolled") throw new SessionRefusal(409, "device_not_enrolled");

  const [sub] = await db
    .select({
      maxManagedUsers: subscriptions.maxManagedUsers,
      addonUsers: subscriptions.addonUsers,
    })
    .from(subscriptions)
    .innerJoin(plans, eq(plans.code, subscriptions.planCode))
    .where(
      and(
        eq(subscriptions.tenantId, input.tenantId),
        sql`${subscriptions.status} IN ('trial', 'active')`,
      ),
    )
    .orderBy(sql`${subscriptions.validUntil} DESC`)
    .limit(1);
  if (!sub) throw new SessionRefusal(409, "no_active_subscription");
  const maxSlots = effectiveMaxManagedUsers(sub.maxManagedUsers, sub.addonUsers);

  const nowIsoValue = now.toISOString();
  const occupiedRows = await db
    .select({ slot: rdpSessionGrants.slot })
    .from(rdpSessionGrants)
    .where(
      and(
        eq(rdpSessionGrants.deviceId, device.id),
        isNull(rdpSessionGrants.revokedAt),
        gt(rdpSessionGrants.expiresAt, nowIsoValue),
      ),
    );
  const occupied = new Set(occupiedRows.map((r) => r.slot));
  let slot = 0;
  for (let candidate = 1; candidate <= maxSlots; candidate += 1) {
    if (!occupied.has(candidate)) {
      slot = candidate;
      break;
    }
  }
  if (slot === 0) throw new SessionRefusal(409, "no_free_slot");

  const password = randomManagedPassword();
  const user = managedUserName(slot);
  const expiresAt = new Date(now.getTime() + RDP_SESSION_TTL_MINUTES * 60_000).toISOString();
  const passwordCiphertext = await encryptToDevice(device.devicePublicKeyJwk, password);
  const passwordHash = await sha256Hex(password);
  const id = newId("rdpSessionGrant");

  await db.batch([
    db.insert(rdpSessionGrants).values({
      id,
      deviceId: device.id,
      tenantId: input.tenantId,
      managedUser: user,
      slot,
      passwordHash,
      passwordCiphertext,
      grantedBy: input.userId,
      createdAt: nowIso(),
      expiresAt,
      deliveredAt: null,
      revokedAt: null,
    }),
    audit(db, {
      eventType: "RDP_SESSION_GRANTED",
      entityType: "device",
      entityId: device.id,
      actor: { type: "user", id: input.userId, tenantId: input.tenantId },
      before: null,
      // Never the password or its hash: only what the grant was, for support/audit purposes.
      after: { grantId: id, user, slot, expiresAt },
      correlationId: input.correlationId ?? null,
      source: "connect",
    }),
  ]);

  return { deviceId: device.id, user, password, expiresAt };
}

/**
 * Undelivered, unexpired, unrevoked grants for `deviceId`, marked delivered in the same call so a
 * heartbeat a few seconds later doesn't queue the same command twice. Called from the heartbeat
 * handler (`routes/v1/agent.ts`), which folds the result into `HeartbeatResponse.commands`.
 */
export async function pendingCommandsForDevice(
  db: Db,
  deviceId: string,
  now = new Date(),
): Promise<SetManagedUserPasswordCommand[]> {
  const nowIsoValue = now.toISOString();
  const rows = await db
    .select({
      id: rdpSessionGrants.id,
      user: rdpSessionGrants.managedUser,
      passwordCiphertext: rdpSessionGrants.passwordCiphertext,
    })
    .from(rdpSessionGrants)
    .where(
      and(
        eq(rdpSessionGrants.deviceId, deviceId),
        isNull(rdpSessionGrants.deliveredAt),
        isNull(rdpSessionGrants.revokedAt),
        gt(rdpSessionGrants.expiresAt, nowIsoValue),
      ),
    );
  if (rows.length === 0) return [];

  // Independent per-row updates (each idempotent); no need for the tuple-typed `db.batch`.
  await Promise.all(
    rows.map((row) =>
      db
        .update(rdpSessionGrants)
        .set({ deliveredAt: nowIso() })
        .where(eq(rdpSessionGrants.id, row.id)),
    ),
  );

  return rows.map((row) => ({
    type: "SET_MANAGED_USER_PASSWORD" as const,
    user: row.user,
    passwordCiphertext: row.passwordCiphertext,
  }));
}
