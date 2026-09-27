// Owner: WT-18. GET /api/v1/screens/releases and /:id. Each is one D1 round trip (db.batch): every
// statement inside one `db.batch()` call travels to D1 together, so batching several SELECTs still
// counts as one round trip (agent-notes fast-data-hydration; see docs/handoffs/wt-p3-entitlement.md
// and wt-p2-enrollment.md for the same pattern). Result counts and assignment counts are derived
// here at read time, never stored (spec §45: never infer success only from "downloaded").
import type { ReleaseDetailScreen, ReleaseListItem, ReleasesScreen } from "@cloudbox/contracts";
import { asc, desc, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { requirePermission } from "../../../authz/permissions";
import { createDb, type Db } from "../../../db/client";
import { devices, releaseAssignments, releaseResults, releases, tenants } from "../../../db/schema";
import type { AppEnv } from "../../../env";
import { toRelease } from "../../../releases/service";
import { releaseSigningKeyConfigured } from "../../../releases/signing-key";

type ReleaseRow = typeof releases.$inferSelect;

function withCounts(
  row: ReleaseRow,
  resultRows: { releaseId: string; state: string; n: number }[],
  assignmentCountRows: { releaseId: string; n: number }[],
): ReleaseListItem {
  const resultCounts: Record<string, number> = {};
  for (const r of resultRows) if (r.releaseId === row.id) resultCounts[r.state] = r.n;
  const assignmentCount = assignmentCountRows.find((a) => a.releaseId === row.id)?.n ?? 0;
  return { ...toRelease(row), resultCounts, assignmentCount };
}

export async function loadReleases(
  db: Db,
  now = new Date(),
): Promise<Omit<ReleasesScreen, "signingKeyConfigured">> {
  const [releaseRows, resultRows, assignmentCountRows] = await db.batch([
    db.select().from(releases).orderBy(desc(releases.createdAt)),
    db
      .select({
        releaseId: releaseResults.releaseId,
        state: releaseResults.state,
        n: sql<number>`count(*)`.mapWith(Number),
      })
      .from(releaseResults)
      .groupBy(releaseResults.releaseId, releaseResults.state),
    db
      .select({ releaseId: releaseAssignments.releaseId, n: sql<number>`count(*)`.mapWith(Number) })
      .from(releaseAssignments)
      .groupBy(releaseAssignments.releaseId),
  ]);

  return {
    serverTime: now.toISOString(),
    items: releaseRows.map((row) => withCounts(row, resultRows, assignmentCountRows)),
  };
}

export async function loadReleaseDetail(
  db: Db,
  id: string,
  now = new Date(),
): Promise<Omit<ReleaseDetailScreen, "signingKeyConfigured"> | null> {
  const [
    releaseRows,
    resultRows,
    assignmentCountRows,
    assignmentRows,
    resultDetailRows,
    deviceRows,
    tenantRows,
  ] = await db.batch([
    db.select().from(releases).where(eq(releases.id, id)),
    db
      .select({
        releaseId: releaseResults.releaseId,
        state: releaseResults.state,
        n: sql<number>`count(*)`.mapWith(Number),
      })
      .from(releaseResults)
      .where(eq(releaseResults.releaseId, id))
      .groupBy(releaseResults.releaseId, releaseResults.state),
    db
      .select({ releaseId: releaseAssignments.releaseId, n: sql<number>`count(*)`.mapWith(Number) })
      .from(releaseAssignments)
      .where(eq(releaseAssignments.releaseId, id))
      .groupBy(releaseAssignments.releaseId),
    db
      .select({
        assignment: releaseAssignments,
        deviceName: devices.name,
        tenantName: tenants.displayName,
      })
      .from(releaseAssignments)
      .leftJoin(devices, eq(devices.id, releaseAssignments.deviceId))
      .leftJoin(tenants, eq(tenants.id, releaseAssignments.tenantId))
      .where(eq(releaseAssignments.releaseId, id))
      .orderBy(desc(releaseAssignments.createdAt)),
    db
      .select({
        id: releaseResults.id,
        releaseId: releaseResults.releaseId,
        deviceId: releaseResults.deviceId,
        deviceName: devices.name,
        state: releaseResults.state,
        detailJson: releaseResults.detailJson,
        reportedAt: releaseResults.reportedAt,
      })
      .from(releaseResults)
      .innerJoin(devices, eq(devices.id, releaseResults.deviceId))
      .where(eq(releaseResults.releaseId, id))
      .orderBy(desc(releaseResults.reportedAt)),
    db
      .select({
        id: devices.id,
        name: devices.name,
        tenantId: devices.tenantId,
        tenantName: tenants.displayName,
      })
      .from(devices)
      .innerJoin(tenants, eq(tenants.id, devices.tenantId))
      .where(eq(devices.status, "enrolled"))
      .orderBy(asc(devices.name)),
    db
      .select({ id: tenants.id, publicCode: tenants.publicCode, displayName: tenants.displayName })
      .from(tenants)
      .where(isNull(tenants.archivedAt))
      .orderBy(asc(tenants.publicCode)),
  ]);

  const row = releaseRows[0];
  if (!row) return null;

  return {
    serverTime: now.toISOString(),
    release: withCounts(row, resultRows, assignmentCountRows),
    assignments: assignmentRows.map((r) => ({
      id: r.assignment.id,
      releaseId: r.assignment.releaseId,
      scope: r.assignment.scope,
      deviceId: r.assignment.deviceId,
      deviceName: r.deviceName ?? null,
      tenantId: r.assignment.tenantId,
      tenantName: r.tenantName ?? null,
      percent: r.assignment.percent,
      createdBy: r.assignment.createdBy,
      createdAt: r.assignment.createdAt,
    })),
    results: resultDetailRows.map((r) => ({
      id: r.id,
      releaseId: r.releaseId,
      deviceId: r.deviceId,
      deviceName: r.deviceName,
      state: r.state,
      detail: r.detailJson === null ? null : JSON.parse(r.detailJson),
      reportedAt: r.reportedAt,
    })),
    devices: deviceRows,
    tenants: tenantRows,
  };
}

const screen = new Hono<AppEnv>();

screen.get("/", requirePermission("update.view"), async (c) => {
  const body: ReleasesScreen = {
    ...(await loadReleases(createDb(c.env.DB))),
    signingKeyConfigured: releaseSigningKeyConfigured(c.env),
  };
  return c.json(body);
});

screen.get("/:id", requirePermission("update.view"), async (c) => {
  const detail = await loadReleaseDetail(createDb(c.env.DB), c.req.param("id"));
  if (!detail) return c.json({ error: "not_found" }, 404);
  const body: ReleaseDetailScreen = {
    ...detail,
    signingKeyConfigured: releaseSigningKeyConfigured(c.env),
  };
  return c.json(body);
});

export default screen;
