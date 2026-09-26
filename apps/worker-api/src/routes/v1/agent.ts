// Owner: WT-3. Module `agent`, mounted at `/api/v1/agent` in routes/v1/index.ts.
// Routes (docs/handoffs/foundation.md): POST /enroll, POST /heartbeat, GET /entitlement, POST /uninstalled (Bearer deviceToken except /enroll; client WT-4).
import { Hono } from "hono";
import type { AppEnv } from "../../env";

const agent = new Hono<AppEnv>();

agent.get("/", (c) => c.json({ module: "agent", status: "stub" }));

export default agent;
