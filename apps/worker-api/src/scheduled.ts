// Owner: WT-19 (created); WT-17's alerts evaluator folded in at integration (both worktrees
// independently wired their own Cron consumer into src/index.ts — see docs/BUILD_STATE.md's
// wt-p14-alerts merge evidence). The Worker's `scheduled` export (Cron Triggers), wired from
// `src/index.ts` alongside `fetch`. Add a new periodic job as its own module plus one additive
// line in the hook list below — never inline new logic directly in this file.
import { eq } from "drizzle-orm";
import { evaluateAlerts } from "./alerts/evaluate";
import { runBackupRetentionSweep } from "./backups/retention";
import { createDb } from "./db/client";
import { settings } from "./db/schema";
import type { Bindings } from "./env";
import { nowIso } from "./ids";

export type ScheduledHook = (env: Bindings) => Promise<void>;

const RETENTION_THROTTLE_KEY = "backups.retention_sweep.last_run_at";
const RETENTION_THROTTLE_MS = 60 * 60_000; // hourly

/**
 * WT-17: the alerts evaluator runs every tick (the cron is now `*/5 * * * *`, the cadence
 * `evaluate.ts`'s own doc comment assumes for its offline/cooldown windows).
 */
async function alertsEvaluationHook(env: Bindings): Promise<void> {
  const result = await evaluateAlerts(env, createDb(env.DB));
  console.log("scheduled: alerts evaluation", result);
}

/**
 * WT-19: §23.7 retention deletion sweep. Not cheap (per-artifact D1 writes and R2 deletes,
 * sequential per device — see `retention.ts`'s own note), so with the cron now firing every 5
 * minutes (moved to that cadence for WT-17's evaluator) this self-throttles to hourly via a
 * `settings` timestamp, the same key/value pattern `foundation.ts`/`policy.ts` already use. A
 * missed hour just runs on the next tick; two overlapping ticks both read a stale timestamp in
 * the worst case and run twice, which the sweep already tolerates (idempotent, review its own
 * doc comment) — worth the extra run rather than a second table/lock for this.
 */
async function backupRetentionHook(env: Bindings): Promise<void> {
  const db = createDb(env.DB);
  const [row] = await db
    .select({ valueJson: settings.valueJson })
    .from(settings)
    .where(eq(settings.key, RETENTION_THROTTLE_KEY));
  const lastRunAt = row ? Date.parse(JSON.parse(row.valueJson) as string) : 0;
  if (Number.isFinite(lastRunAt) && Date.now() - lastRunAt < RETENTION_THROTTLE_MS) return;

  const result = await runBackupRetentionSweep(db, env.ARTIFACTS);
  console.log("scheduled: backup retention sweep", result);

  const now = nowIso();
  await db
    .insert(settings)
    .values({ key: RETENTION_THROTTLE_KEY, valueJson: JSON.stringify(now), updatedAt: now })
    .onConflictDoUpdate({
      target: settings.key,
      set: { valueJson: JSON.stringify(now), updatedAt: now },
    });
}

const HOOKS: ScheduledHook[] = [
  alertsEvaluationHook, // WT-17: spec §25/§44 alert reconciliation.
  backupRetentionHook, // WT-19: §23.7 retention deletion sweep (self-throttled to hourly).
];

/**
 * Runs every hook to completion (one failing hook does not stop the others) before this settles —
 * the Cron event's lifetime already extends to cover the returned promise, so `ctx.waitUntil` adds
 * nothing here besides matching the convention other Worker entry points use it for.
 */
export async function scheduled(
  _event: ScheduledController,
  env: Bindings,
  ctx: ExecutionContext,
): Promise<void> {
  const run = Promise.allSettled(HOOKS.map((hook) => hook(env))).then((results) => {
    for (const result of results) {
      if (result.status === "rejected") console.error("scheduled hook failed", result.reason);
    }
  });
  ctx.waitUntil(run);
  await run;
}
