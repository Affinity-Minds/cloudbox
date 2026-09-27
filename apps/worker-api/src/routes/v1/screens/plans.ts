// Owner: WT-13. GET /api/v1/screens/plans. One D1 round trip (db.batch: plans + a grouped
// subscription count), plus the permission-gate's own session/grant lookup — same ceiling as the
// other screen loaders (fast-data-hydration "≤3 D1 round trips beyond auth").
import type { PlansScreen } from "@cloudbox/contracts";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { requirePermission } from "../../../authz/permissions";
import { createDb, type Db } from "../../../db/client";
import { plans as plansTable, subscriptions as subscriptionsTable } from "../../../db/schema";
import type { AppEnv } from "../../../env";
import { toPlan } from "../subscriptions";

export async function loadPlansScreen(db: Db, now = new Date()): Promise<PlansScreen> {
  const [planRows, countRows] = await db.batch([
    db.select().from(plansTable).orderBy(plansTable.code),
    db
      .select({
        planCode: subscriptionsTable.planCode,
        n: sql<number>`count(*)`.mapWith(Number),
      })
      .from(subscriptionsTable)
      .groupBy(subscriptionsTable.planCode),
  ]);

  const counts = new Map(countRows.map((row) => [row.planCode, row.n]));
  return {
    serverTime: now.toISOString(),
    items: planRows.map((row) => ({
      ...toPlan(row),
      subscriptionCount: counts.get(row.code) ?? 0,
    })),
  };
}

const screen = new Hono<AppEnv>();

// Retired plans are part of the designer's own table, same gate as writing them (subscription.manage).
screen.get("/", requirePermission("subscription.manage"), async (c) =>
  c.json(await loadPlansScreen(createDb(c.env.DB))),
);

export default screen;
