// Owner: WT-3. Module `enrollment`, mounted at `/api/v1/tenants/:tenantId/enrollment-tokens` in routes/v1/index.ts.
// Routes (docs/handoffs/foundation.md): POST /, GET /, DELETE /:id.
import { Hono } from "hono";
import type { AppEnv } from "../../env";

const enrollment = new Hono<AppEnv>();

enrollment.get("/", (c) => c.json({ module: "enrollment", status: "stub" }));

export default enrollment;
