// Owner: WT-3. Module `devices`, mounted at `/api/v1/devices` in routes/v1/index.ts.
// Routes (docs/handoffs/foundation.md): POST /:deviceId/revoke.
import { Hono } from "hono";
import type { AppEnv } from "../../env";

const devices = new Hono<AppEnv>();

devices.get("/", (c) => c.json({ module: "devices", status: "stub" }));

export default devices;
