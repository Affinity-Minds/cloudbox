// Owner: WT-5. Module `entitlements`, mounted at `/api/v1/devices/:deviceId/entitlements` in routes/v1/index.ts.
// Routes (docs/handoffs/foundation.md): POST /issue, POST /renew, POST /revoke.
import { Hono } from "hono";
import type { AppEnv } from "../../env";

const entitlements = new Hono<AppEnv>();

entitlements.get("/", (c) => c.json({ module: "entitlements", status: "stub" }));

export default entitlements;
