// Owner: WT-5. Module `subscriptions`: three routers because its paths span three prefixes.
// Routes (docs/handoffs/foundation.md): GET /plans, POST /tenants/:tenantId/subscriptions,
// PATCH /subscriptions/:id. Subscription screens live in routes/v1/screens/.
import { Hono } from "hono";
import type { AppEnv } from "../../env";

/** Mounted at /api/v1/plans. */
export const plans = new Hono<AppEnv>();
plans.get("/", (c) => c.json({ module: "subscriptions", status: "stub" }));

/** Mounted at /api/v1/tenants/:tenantId/subscriptions. */
export const tenantSubscriptions = new Hono<AppEnv>();
tenantSubscriptions.get("/", (c) => c.json({ module: "subscriptions", status: "stub" }));

/** Mounted at /api/v1/subscriptions. */
const subscriptions = new Hono<AppEnv>();
subscriptions.get("/", (c) => c.json({ module: "subscriptions", status: "stub" }));

export default subscriptions;
