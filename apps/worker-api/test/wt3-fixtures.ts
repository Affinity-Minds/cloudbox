// Owner: WT-3. `seedTenant`/`seedMembership` (test/fixtures.ts) are still `pending()` — WT-6 has
// not merged. These are direct-insert stand-ins scoped to this worktree's own tests only; they are
// not the fixtures contract and other worktrees should not import them.
import { createDb } from "../src/db/client";
import { tenantMemberships, tenants } from "../src/db/schema";
import { newId, nowIso } from "../src/ids";

export async function insertTenant(
  env: { DB: D1Database },
  overrides: { displayName?: string } = {},
): Promise<{ tenantId: string; publicCode: string }> {
  const db = createDb(env.DB);
  const tenantId = newId("tenant");
  const publicCode = `CBX-T${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  await db.insert(tenants).values({
    id: tenantId,
    publicCode,
    displayName: overrides.displayName ?? "Test Tenant",
    status: "active",
  });
  return { tenantId, publicCode };
}

export async function insertMembership(
  env: { DB: D1Database },
  input: { tenantId: string; userId: string; standing: "owner" | "admin" | "user" },
): Promise<void> {
  const db = createDb(env.DB);
  await db.insert(tenantMemberships).values({
    id: newId("membership"),
    tenantId: input.tenantId,
    userId: input.userId,
    standing: input.standing,
    status: "active",
    createdAt: nowIso(),
  });
}
