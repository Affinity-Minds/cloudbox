// fast-data-hydration.md "two tests that stop regressions", test 1: no table scan on a
// tenant-scoped or otherwise large table. Registry lives in ./queries.ts; owners append there,
// not here. Demo path (docs/plans/briefs/WT-6-qa-harness.md): drop an index used by one of these
// queries and watch the matching case here go red.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { queries } from "./queries";

/** Tables large or tenant-scoped enough that a full scan is a real regression. */
const GUARDED_TABLES = [
  "tenants",
  "devices",
  "tenant_memberships",
  "subscriptions",
  "entitlements",
  "enrollment_tokens",
  "audit_log",
];

type PlanRow = { id: number; parent: number; notused: number; detail: string };

/**
 * A `SCAN` line that names a guarded table and does not say it used an index (or the rowid
 * primary key) is a full heap scan — the regression this test exists to catch. `SEARCH` lines,
 * and `SCAN … USING (COVERING) INDEX …` / `USING INTEGER PRIMARY KEY`, are fine.
 */
function isUnindexedScanOfGuardedTable(detail: string): boolean {
  if (!/^SCAN /.test(detail)) return false;
  if (detail.includes("INDEX") || detail.includes("PRIMARY KEY")) return false;
  return GUARDED_TABLES.some((table) => detail.includes(`TABLE ${table}`));
}

describe("query plans avoid unindexed scans on tenant-scoped tables", () => {
  it("the registry is not empty", () => {
    expect(queries.length).toBeGreaterThan(0);
  });

  for (const query of queries) {
    it(query.name, async () => {
      const statement = env.DB.prepare(`EXPLAIN QUERY PLAN ${query.sql}`);
      const bound =
        query.params && query.params.length > 0 ? statement.bind(...query.params) : statement;
      const plan = await bound.all<PlanRow>();

      const badScans = plan.results.filter((row) => isUnindexedScanOfGuardedTable(row.detail));
      expect(
        badScans,
        `plan for "${query.name}":\n${JSON.stringify(plan.results, null, 2)}`,
      ).toEqual([]);
    });
  }
});
