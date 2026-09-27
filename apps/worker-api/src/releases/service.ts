// Owner: WT-18. Release lifecycle: upload → draft, promote (draft→pilot→stable, with a health gate
// on pilot→stable), withdraw. Master spec §18, §45; Slices 10.1/10.3/10.4.
import type { Release, ReleaseChannel, UploadReleaseFields } from "@cloudbox/contracts";
import { type ReleaseManifest, signManifest } from "@cloudbox/update-contracts";
import { and, eq } from "drizzle-orm";
import { audit } from "../audit";
import type { Db } from "../db/client";
import { releases } from "../db/schema";
import type { Bindings } from "../env";
import { newId, nowIso } from "../ids";
import { healthGatePassed } from "./results";
import { ensureReleaseSigningKey, ReleaseSigningKeyError } from "./signing-key";
import { storePackage, UploadRefusal } from "./upload";

/** A refusal with its HTTP status and error code (error shape in docs/handoffs/foundation.md). */
export class ReleaseRefusal extends Error {
  override readonly name = "ReleaseRefusal";
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 422 | 503,
    readonly code: string,
    readonly detail?: string,
  ) {
    super(detail ?? code);
  }
}

export type Actor = { id: string; correlationId?: string | null };

type ReleaseRow = typeof releases.$inferSelect;

export function toRelease(row: ReleaseRow): Release {
  return {
    id: row.id,
    component: row.component,
    version: row.version,
    channel: row.channel,
    status: row.status,
    package: { r2Key: row.packageR2Key, sha256: row.packageSha256, sizeBytes: row.packageSize },
    minAgentVersion: row.minAgentVersion,
    rollbackOf: row.rollbackOf,
    notes: row.notes,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    promotedAt: row.promotedAt,
    withdrawnAt: row.withdrawnAt,
    withdrawReason: row.withdrawReason,
  };
}

/**
 * Validates, stores the package in R2, signs the manifest and inserts the `releases` row as
 * `status='draft'` — every new release starts as draft regardless of the chosen target `channel`
 * and must be explicitly promoted (see `promoteRelease`) before any device can see it, matching the
 * spec's "Internal lab" first rollout stage (a draft can still be assigned to specific lab devices).
 */
export async function createRelease(
  env: Bindings,
  db: Db,
  input: { fields: UploadReleaseFields; file: File; actor: Actor },
): Promise<{ release: Release }> {
  const { fields, actor } = input;

  const [existing] = await db
    .select({ id: releases.id })
    .from(releases)
    .where(and(eq(releases.component, fields.component), eq(releases.version, fields.version)));
  if (existing) throw new ReleaseRefusal(409, "version_exists");

  let key: Awaited<ReturnType<typeof ensureReleaseSigningKey>>;
  try {
    key = await ensureReleaseSigningKey(env, db);
  } catch (error) {
    if (error instanceof ReleaseSigningKeyError) throw new ReleaseRefusal(503, error.code);
    throw error;
  }

  let stored: Awaited<ReturnType<typeof storePackage>>;
  try {
    stored = await storePackage(env.ARTIFACTS, {
      component: fields.component,
      version: fields.version,
      file: input.file,
    });
  } catch (error) {
    if (error instanceof UploadRefusal)
      throw new ReleaseRefusal(error.status, error.code, error.detail);
    throw error;
  }

  const id = newId("release");
  const createdAt = nowIso();
  const manifest: ReleaseManifest = {
    component: fields.component,
    version: fields.version,
    channel: fields.channel,
    minAgentVersion: fields.minAgentVersion ?? null,
    package: stored,
    rollbackOf: fields.rollbackOf ?? null,
    notes: fields.notes ?? null,
    createdBy: actor.id,
    createdAt,
  };

  let manifestJws: string;
  try {
    manifestJws = await signManifest({ manifest, serverPrivateJwk: key.privateJwk, kid: key.kid });
  } catch (error) {
    throw new ReleaseRefusal(
      422,
      "manifest_invalid",
      error instanceof Error ? error.message : undefined,
    );
  }

  const row: ReleaseRow = {
    id,
    component: manifest.component,
    version: manifest.version,
    channel: manifest.channel,
    manifestJson: JSON.stringify(manifest),
    manifestJws,
    packageR2Key: stored.r2Key,
    packageSha256: stored.sha256,
    packageSize: stored.sizeBytes,
    minAgentVersion: manifest.minAgentVersion,
    rollbackOf: manifest.rollbackOf,
    notes: manifest.notes,
    status: "draft",
    createdBy: actor.id,
    createdAt,
    promotedAt: null,
    withdrawnAt: null,
    withdrawReason: null,
  };
  const release = toRelease(row);

  await db.batch([
    db.insert(releases).values(row),
    audit(db, {
      eventType: "UPDATE_RELEASED",
      entityType: "release",
      entityId: id,
      actor: { type: "user", id: actor.id },
      before: null,
      after: release,
      correlationId: actor.correlationId,
      source: "api",
    }),
  ]);

  return { release };
}

/**
 * Promotion transitions (deviation from a literal read of the brief's two enums — documented in the
 * handoff): `channel` is the rollout target, `status` is the workflow gate.
 *   draft   → pilot:   always allowed, no gate.
 *   pilot   → stable:  requires the health gate (≥1 `installed_healthy`, 0 `installed_unhealthy`/
 *                       `rolled_back`); TODO(WT-1): also requires a fresh-TOTP step-up (ADR 0009) —
 *                       no such helper is exported yet, so this is not yet enforced (see handoff).
 *   stable  → pinned:  channel only; the release stays `status='stable'` (still a live, valid
 *                       release — pinning takes it out of the broadcast default, see resolve.ts).
 *   pinned  → stable:  channel only, back to the broadcast default.
 *   draft   → stable/pinned, or anything on a `withdrawn` release: refused.
 */
export async function promoteRelease(
  db: Db,
  input: { id: string; channel: ReleaseChannel; actor: Actor },
): Promise<Release> {
  const [current] = await db.select().from(releases).where(eq(releases.id, input.id));
  if (!current) throw new ReleaseRefusal(404, "not_found");
  if (current.status === "withdrawn") throw new ReleaseRefusal(409, "already_withdrawn");

  const { channel } = input;
  let nextStatus: ReleaseRow["status"] = current.status;

  if (channel === "development") {
    if (current.status !== "draft") throw new ReleaseRefusal(409, "already_promoted");
  } else if (channel === "pilot") {
    if (current.status !== "draft" && current.status !== "pilot") {
      throw new ReleaseRefusal(409, "invalid_transition", `cannot move ${current.status} to pilot`);
    }
    nextStatus = "pilot";
  } else if (channel === "stable") {
    if (current.status !== "pilot" && current.status !== "stable") {
      throw new ReleaseRefusal(409, "must_pilot_first");
    }
    if (current.status === "pilot") {
      const gate = await healthGatePassed(db, current.id);
      if (!gate.passed) throw new ReleaseRefusal(409, "health_gate_failed", gate.reason);
    }
    nextStatus = "stable";
  } else {
    // pinned
    if (current.status !== "stable") throw new ReleaseRefusal(409, "must_be_stable_first");
    nextStatus = "stable";
  }

  if (current.channel === channel && current.status === nextStatus) return toRelease(current);

  const promotedAt = nowIso();
  const next: ReleaseRow = { ...current, channel, status: nextStatus, promotedAt };
  const before = toRelease(current);
  const after = toRelease(next);

  await db.batch([
    db
      .update(releases)
      .set({ channel, status: nextStatus, promotedAt })
      .where(eq(releases.id, input.id)),
    audit(db, {
      eventType: "UPDATE_PROMOTED",
      entityType: "release",
      entityId: input.id,
      actor: { type: "user", id: input.actor.id },
      before,
      after,
      correlationId: input.actor.correlationId,
      source: "api",
    }),
  ]);

  return after;
}

export async function withdrawRelease(
  db: Db,
  input: { id: string; reason: string; actor: Actor },
): Promise<Release> {
  const [current] = await db.select().from(releases).where(eq(releases.id, input.id));
  if (!current) throw new ReleaseRefusal(404, "not_found");
  if (current.status === "withdrawn") throw new ReleaseRefusal(409, "already_withdrawn");
  if (current.status === "draft") throw new ReleaseRefusal(409, "not_released_yet");

  const withdrawnAt = nowIso();
  const next: ReleaseRow = {
    ...current,
    status: "withdrawn",
    withdrawnAt,
    withdrawReason: input.reason,
  };
  const before = toRelease(current);
  const after = toRelease(next);

  await db.batch([
    db
      .update(releases)
      .set({ status: "withdrawn", withdrawnAt, withdrawReason: input.reason })
      .where(eq(releases.id, input.id)),
    audit(db, {
      eventType: "UPDATE_WITHDRAWN",
      entityType: "release",
      entityId: input.id,
      actor: { type: "user", id: input.actor.id },
      before,
      after,
      correlationId: input.actor.correlationId,
      source: "api",
    }),
  ]);

  return after;
}
