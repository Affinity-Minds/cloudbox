// Owner: WT-0. GET /api/v1/screens/overview: every count in one D1 round trip.
import type { OverviewScreen } from "@cloudbox/contracts";
import { count, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createDb, type Db } from "../../../db/client";
import { auditLog, devices, subscriptions, tenants } from "../../../db/schema";
import type { AppEnv } from "../../../env";

const countWhere = (condition: ReturnType<typeof sql>) =>
  sql<number>`coalesce(sum(case when ${condition} then 1 else 0 end), 0)`.mapWith(Number);

export async function loadOverview(db: Db): Promise<OverviewScreen> {
  const [tenantRows, deviceRows, subscriptionRows, auditRows] = await db.batch([
    db
      .select({ total: count(), active: countWhere(sql`${tenants.status} = 'active'`) })
      .from(tenants),
    db
      .select({ total: count(), enrolled: countWhere(sql`${devices.status} = 'enrolled'`) })
      .from(devices),
    db
      .select({
        total: count(),
        active: countWhere(sql`${subscriptions.status} = 'active'`),
      })
      .from(subscriptions),
    db
      .select({
        total: count(),
        lastEventAt: sql<
          string | null
        >`(select ${auditLog.createdAt} from ${auditLog} order by rowid desc limit 1)`,
      })
      .from(auditLog),
  ]);

  return {
    tenants: { total: tenantRows[0]?.total ?? 0, active: tenantRows[0]?.active ?? 0 },
    devices: { total: deviceRows[0]?.total ?? 0, enrolled: deviceRows[0]?.enrolled ?? 0 },
    subscriptions: {
      total: subscriptionRows[0]?.total ?? 0,
      active: subscriptionRows[0]?.active ?? 0,
    },
    audit: { total: auditRows[0]?.total ?? 0, lastEventAt: auditRows[0]?.lastEventAt ?? null },
  };
}

// WT-1: gate with requireStaff() once sessions exist (see authz/permissions.ts).
const overview = new Hono<AppEnv>();

overview.get("/", async (c) => c.json(await loadOverview(createDb(c.env.DB))));

export default overview;
