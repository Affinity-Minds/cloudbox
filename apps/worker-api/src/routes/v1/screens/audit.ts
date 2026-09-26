// Owner: WT-0. GET /api/v1/screens/audit?cursor&limit: newest first, keyset on rowid (insertion
// order; agent-notes cloudflare-workers #8), explicit columns, one D1 round trip.
import { type AuditEntry, type AuditScreen, PageQuery } from "@cloudbox/contracts";
import { zValidator } from "@hono/zod-validator";
import { desc, lt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createDb, type Db } from "../../../db/client";
import { auditLog } from "../../../db/schema";
import type { AppEnv } from "../../../env";

const rowid = sql<number>`${auditLog}.rowid`.mapWith(Number);

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export async function loadAuditPage(db: Db, page: PageQuery): Promise<AuditScreen> {
  const cursor = page.cursor === undefined ? undefined : Number.parseInt(page.cursor, 10);
  const rows = await db
    .select({
      rowid,
      id: auditLog.id,
      eventType: auditLog.eventType,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      actorType: auditLog.actorType,
      actorId: auditLog.actorId,
      actorTenantId: auditLog.actorTenantId,
      action: auditLog.action,
      beforeJson: auditLog.beforeJson,
      afterJson: auditLog.afterJson,
      correlationId: auditLog.correlationId,
      source: auditLog.source,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .where(cursor === undefined || Number.isNaN(cursor) ? undefined : lt(rowid, cursor))
    .orderBy(desc(rowid))
    .limit(page.limit + 1);

  const pageRows = rows.slice(0, page.limit);
  const items: AuditEntry[] = pageRows.map(({ rowid: _rowid, beforeJson, afterJson, ...row }) => ({
    ...row,
    before: parseJson(beforeJson),
    after: parseJson(afterJson),
  }));
  const last = pageRows.at(-1);

  return {
    items,
    nextCursor: rows.length > page.limit && last ? String(last.rowid) : null,
  };
}

// WT-1: gate with requirePermission("audit.view") once sessions exist.
const audit = new Hono<AppEnv>();

audit.get(
  "/",
  zValidator("query", PageQuery, (result, c) => {
    if (!result.success) return c.json({ error: "invalid_request" }, 400);
  }),
  async (c) => c.json(await loadAuditPage(createDb(c.env.DB), c.req.valid("query"))),
);

export default audit;
