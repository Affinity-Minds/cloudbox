// Owner: WT-18. Resolves the highest applicable release for a device (spec §18.2 rollout example):
// an explicit device assignment beats a tenant assignment, beats a fleet-percent bucket, beats the
// channel default (the newest `channel='stable'`, `status='stable'` release — everyone gets it
// unless overridden). Within a tier, the newest `createdAt` wins.
import type { ReleaseComponent } from "@cloudbox/contracts";
import { and, desc, eq, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import { releaseAssignments, releases } from "../db/schema";

export type ReleaseRow = typeof releases.$inferSelect;

/** Deterministic 0–99 bucket from a stable hash of the device id: `sha256(deviceId)`'s first 4
 * bytes as a big-endian uint32, mod 100. A `fleet_percent` assignment of `percent=N` is eligible
 * for the `N` lowest-numbered buckets, so the same device always lands in or out of a given
 * percentage, and widening the percentage only ever adds devices, never removes any. */
export async function percentBucket(deviceId: string): Promise<number> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(deviceId));
  return new DataView(digest).getUint32(0, false) % 100;
}

export async function resolveAssignedRelease(
  db: Db,
  input: { deviceId: string; tenantId: string; component: ReleaseComponent },
): Promise<ReleaseRow | null> {
  const { deviceId, tenantId, component } = input;

  const candidates = await db
    .select({ release: releases, assignment: releaseAssignments })
    .from(releases)
    .innerJoin(releaseAssignments, eq(releaseAssignments.releaseId, releases.id))
    .where(and(eq(releases.component, component), ne(releases.status, "withdrawn")))
    .orderBy(desc(releases.createdAt));

  const byDevice = candidates.find(
    (c) => c.assignment.scope === "device" && c.assignment.deviceId === deviceId,
  );
  if (byDevice) return byDevice.release;

  const byTenant = candidates.find(
    (c) => c.assignment.scope === "tenant" && c.assignment.tenantId === tenantId,
  );
  if (byTenant) return byTenant.release;

  const percentCandidates = candidates.filter((c) => c.assignment.scope === "fleet_percent");
  if (percentCandidates.length > 0) {
    const bucket = await percentBucket(deviceId);
    const eligible = percentCandidates.find((c) => bucket < (c.assignment.percent ?? 0));
    if (eligible) return eligible.release;
  }

  const [channelDefault] = await db
    .select()
    .from(releases)
    .where(
      and(
        eq(releases.component, component),
        eq(releases.channel, "stable"),
        eq(releases.status, "stable"),
      ),
    )
    .orderBy(desc(releases.createdAt))
    .limit(1);
  return channelDefault ?? null;
}
