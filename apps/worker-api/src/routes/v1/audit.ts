// Owner: WT-0. Module `audit`, mounted at `/api/v1/audit` in routes/v1/index.ts.
// Routes (docs/handoffs/foundation.md): reserved for audit export; the audit screen is GET /api/v1/screens/audit.
import { Hono } from "hono";
import type { AppEnv } from "../../env";

const audit = new Hono<AppEnv>();

audit.get("/", (c) => c.json({ module: "audit", status: "stub" }));

export default audit;
