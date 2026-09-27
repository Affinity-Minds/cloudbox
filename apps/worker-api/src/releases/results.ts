// Owner: WT-18. `release_results`: device-reported terminal states (master spec §45) and the
// aggregate counts the Updates screen shows per release, plus the pilot→stable health gate.
// "Never infer successful rollout only from downloaded" — the counts always carry the full
// breakdown, and the gate looks at `installed_healthy`/`installed_unhealthy`/`rolled_back` only.
import type { ReleaseResultState } from "@cloudbox/contracts";
import { eq, sql } from "drizzle-orm";
import { audit } from "../audit";
import type { Db } from "../db/client";
import { releaseResults } from "../db/schema";
import { newId, nowIso } from "../ids";

export async function recordResult(
  db: Db,
  input: { releaseId: string; deviceId: string; state: ReleaseResultState; detail?: unknown },
): Promise<{ id: string; reportedAt: string }> {
  const id = newId("releaseResult");
  const reportedAt = nowIso();
  const detailJson = input.detail === undefined ? null : JSON.stringify(input.detail);

  await db.batch([
    db.insert(releaseResults).values({
      id,
      releaseId: input.releaseId,
      deviceId: input.deviceId,
      state: input.state,
      detailJson,
      reportedAt,
    }),
    audit(db, {
      eventType: "UPDATE_RESULT_REPORTED",
      entityType: "release_result",
      entityId: id,
      actor: { type: "device", id: input.deviceId },
      before: null,
      after: { releaseId: input.releaseId, deviceId: input.deviceId, state: input.state },
      source: "agent",
    }),
  ]);

  return { id, reportedAt };
}

/** Every state's count for a release, `0` for a state with no rows (never omitted). */
export async function resultCounts(db: Db, releaseId: string): Promise<Record<string, number>> {
  const rows = await db
    .select({ state: releaseResults.state, n: sql<number>`count(*)`.mapWith(Number) })
    .from(releaseResults)
    .where(eq(releaseResults.releaseId, releaseId))
    .groupBy(releaseResults.state);
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.state] = row.n;
  return counts;
}

export type HealthGate = { passed: boolean; reason?: string };

/** Slice 10.4: ≥1 `installed_healthy` and zero `installed_unhealthy`/`rolled_back`. */
export async function healthGatePassed(db: Db, releaseId: string): Promise<HealthGate> {
  const counts = await resultCounts(db, releaseId);
  const healthy = counts.installed_healthy ?? 0;
  const unhealthy = (counts.installed_unhealthy ?? 0) + (counts.rolled_back ?? 0);
  if (unhealthy > 0)
    return { passed: false, reason: "installed_unhealthy or rolled_back result present" };
  if (healthy < 1) return { passed: false, reason: "needs at least one installed_healthy result" };
  return { passed: true };
}
