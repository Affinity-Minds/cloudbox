// Owner: WT-19 (created; none of WT-17's other Cron consumers existed yet — see this file's own
// note in the handoff). The Worker's `scheduled` export (Cron Triggers), wired from `src/index.ts`
// alongside `fetch`. Add a new periodic job as its own module plus one additive line in the hook
// list below — never inline new logic directly in this file.
import { runBackupRetentionSweep } from "./backups/retention";
import { createDb } from "./db/client";
import type { Bindings } from "./env";

export type ScheduledHook = (env: Bindings) => Promise<void>;

/**
 * Hook list, run in order on every Cron invocation (see `wrangler.jsonc`'s `triggers.crons` for
 * the schedule — currently once daily). A hook that fails is logged and does not block the
 * others; each hook owns its own idempotency (a re-run must converge, not double-apply).
 */
async function backupRetentionHook(env: Bindings): Promise<void> {
  const result = await runBackupRetentionSweep(createDb(env.DB), env.ARTIFACTS);
  console.log("scheduled: backup retention sweep", result);
}

const HOOKS: ScheduledHook[] = [
  backupRetentionHook, // WT-19: §23.7 retention deletion sweep.
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
