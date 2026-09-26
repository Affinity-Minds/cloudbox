// Owner: WT-3. Module `enrollment`, mounted at `/api/v1/tenants/:tenantId/enrollment-tokens` in
// routes/v1/index.ts. Routes: POST /, GET /, DELETE /:id.
//
// Gate: staff `device.manage` OR tenant standing `admin` (docs/plans/briefs/WT-3-enrollment-devices.md).
// `requirePermission`/`requireTenantStanding` are WT-1's fixed signatures and currently answer 501
// (docs/handoffs/foundation.md "Authorization dependency") — wired now per the brief so the gate is
// real the moment WT-1 lands, at the cost of every mutation here 501ing until then. The handler
// logic below is exported as plain functions and unit-tested directly, bypassing the gate.
import {
  CreateEnrollmentTokenRequest,
  type CreateEnrollmentTokenResponse,
  type EnrollmentToken,
} from "@cloudbox/contracts";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, isNull } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { audit } from "../../audit";
import { guard } from "../../auth/middleware";
import { getTenantStanding } from "../../authz/permissions";
import { randomCrockfordBase32, sha256Hex } from "../../crypto";
import { createDb, type Db } from "../../db/client";
import { enrollmentTokens } from "../../db/schema";
import type { AppEnv } from "../../env";
import { newId, nowIso } from "../../ids";

/** `:tenantId` is declared on the parent mount (`/tenants/:tenantId/enrollment-tokens`), so Hono
 * can't statically type it on this sub-router; it is always present at runtime. */
function tenantIdParam(c: Context<AppEnv>): string {
  const tenantId = c.req.param("tenantId");
  if (!tenantId) throw new HTTPException(400, { message: "invalid_request" });
  return tenantId;
}

/** `CBX-ENROLL-XXXX-XXXX`: 8 Crockford base32 symbols (40 bits), no ambiguous characters. */
function formatEnrollmentCode(): string {
  const symbols = randomCrockfordBase32(8);
  return `CBX-ENROLL-${symbols.slice(0, 4)}-${symbols.slice(4)}`;
}

function toEnrollmentToken(row: typeof enrollmentTokens.$inferSelect): EnrollmentToken {
  return {
    id: row.id,
    tenantId: row.tenantId,
    label: row.label,
    createdBy: row.createdBy,
    expiresAt: row.expiresAt,
    redeemedAt: row.redeemedAt,
    redeemedDeviceId: row.redeemedDeviceId,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}

export async function createEnrollmentToken(
  db: Db,
  input: {
    tenantId: string;
    label: string;
    expiresInHours: number;
    createdBy: string;
    correlationId?: string | null;
  },
): Promise<CreateEnrollmentTokenResponse> {
  const plaintext = formatEnrollmentCode();
  const row = {
    id: newId("enrollmentToken"),
    tenantId: input.tenantId,
    tokenHash: await sha256Hex(plaintext),
    label: input.label,
    createdBy: input.createdBy,
    expiresAt: new Date(Date.now() + input.expiresInHours * 3_600_000).toISOString(),
    redeemedAt: null as string | null,
    redeemedDeviceId: null as string | null,
    revokedAt: null as string | null,
    createdAt: nowIso(),
  };

  await db.batch([
    db.insert(enrollmentTokens).values(row),
    audit(db, {
      eventType: "ENROLLMENT_TOKEN_CREATED",
      entityType: "enrollment_token",
      entityId: row.id,
      actor: { type: "user", id: input.createdBy, tenantId: input.tenantId },
      before: null,
      after: { label: row.label, expiresAt: row.expiresAt },
      correlationId: input.correlationId,
      source: "api",
    }),
  ]);

  return { ...toEnrollmentToken(row), token: plaintext };
}

export async function listEnrollmentTokens(db: Db, tenantId: string): Promise<EnrollmentToken[]> {
  const rows = await db
    .select()
    .from(enrollmentTokens)
    .where(eq(enrollmentTokens.tenantId, tenantId))
    .orderBy(desc(enrollmentTokens.createdAt));
  return rows.map(toEnrollmentToken);
}

export type RevokeEnrollmentTokenResult =
  | "revoked"
  | "already_revoked"
  | "not_found"
  | "already_redeemed";

export async function revokeEnrollmentToken(
  db: Db,
  input: { tenantId: string; tokenId: string; actorId: string; correlationId?: string | null },
): Promise<RevokeEnrollmentTokenResult> {
  const [existing] = await db
    .select()
    .from(enrollmentTokens)
    .where(
      and(eq(enrollmentTokens.id, input.tokenId), eq(enrollmentTokens.tenantId, input.tenantId)),
    );
  if (!existing) return "not_found";
  if (existing.redeemedAt) return "already_redeemed";
  if (existing.revokedAt) return "already_revoked";

  const revokedAt = nowIso();
  await db.batch([
    db
      .update(enrollmentTokens)
      .set({ revokedAt })
      .where(and(eq(enrollmentTokens.id, input.tokenId), isNull(enrollmentTokens.revokedAt))),
    audit(db, {
      eventType: "ENROLLMENT_TOKEN_REVOKED",
      entityType: "enrollment_token",
      entityId: input.tokenId,
      actor: { type: "user", id: input.actorId, tenantId: input.tenantId },
      before: { revokedAt: null },
      after: { revokedAt },
      correlationId: input.correlationId,
      source: "api",
    }),
  ]);
  return "revoked";
}

const enrollment = new Hono<AppEnv>();
/** Staff `device.manage` OR tenant standing `admin`+ on `:tenantId`. `requireTenantStanding()`
 * alone doesn't admit staff (WT-1) — a route open to both composes a single `guard()` check
 * instead of trying both gates in sequence. */
const gate = guard(async (principal, c) => {
  if (principal.permissions.has("device.manage")) return true;
  const tenantId = c.req.param("tenantId");
  if (!tenantId) return false;
  const standing = await getTenantStanding(c, tenantId);
  return standing === "admin" || standing === "owner";
});

enrollment.post(
  "/",
  gate,
  zValidator("json", CreateEnrollmentTokenRequest, (result, c) => {
    if (!result.success) return c.json({ error: "invalid_request" }, 400);
  }),
  async (c) => {
    const input = c.req.valid("json");
    const response = await createEnrollmentToken(createDb(c.env.DB), {
      tenantId: tenantIdParam(c),
      label: input.label,
      expiresInHours: input.expiresInHours,
      createdBy: c.var.user.id,
      correlationId: c.var.correlationId,
    });
    return c.json(response, 201);
  },
);

enrollment.get("/", gate, async (c) => {
  const tokens = await listEnrollmentTokens(createDb(c.env.DB), tenantIdParam(c));
  return c.json(tokens);
});

enrollment.delete("/:id", gate, async (c) => {
  const result = await revokeEnrollmentToken(createDb(c.env.DB), {
    tenantId: tenantIdParam(c),
    tokenId: c.req.param("id"),
    actorId: c.var.user.id,
    correlationId: c.var.correlationId,
  });
  if (result === "not_found") return c.json({ error: "not_found" }, 404);
  if (result === "already_redeemed") return c.json({ error: "already_redeemed" }, 409);
  return c.body(null, 204);
});

export default enrollment;
