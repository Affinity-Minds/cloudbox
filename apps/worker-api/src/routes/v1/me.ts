// Owner: WT-2. Module `me`, mounted at `/api/v1/me` in routes/v1/index.ts.
// Routes (docs/handoffs/foundation.md): GET /tenants, POST /active-tenant.
import { Hono } from "hono";
import type { AppEnv } from "../../env";

const me = new Hono<AppEnv>();

me.get("/", (c) => c.json({ module: "me", status: "stub" }));

export default me;
