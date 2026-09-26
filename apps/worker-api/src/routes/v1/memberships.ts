// Owner: WT-2. Module `memberships`, mounted at `/api/v1/tenants/:tenantId/memberships` in routes/v1/index.ts.
// Routes (docs/handoffs/foundation.md): POST /, PATCH /:id, DELETE /:id.
import { Hono } from "hono";
import type { AppEnv } from "../../env";

const memberships = new Hono<AppEnv>();

memberships.get("/", (c) => c.json({ module: "memberships", status: "stub" }));

export default memberships;
