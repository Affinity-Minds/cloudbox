// Owner: WT-2. Module `tenants`, mounted at `/api/v1/tenants` in routes/v1/index.ts.
// Routes (docs/handoffs/foundation.md): POST /, PATCH /:tenantId, POST /:tenantId/archive.
import { Hono } from "hono";
import type { AppEnv } from "../../env";

const tenants = new Hono<AppEnv>();

tenants.get("/", (c) => c.json({ module: "tenants", status: "stub" }));

export default tenants;
