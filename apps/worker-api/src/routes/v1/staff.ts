// Owner: WT-1. Module `staff`, mounted at `/api/v1/staff` in routes/v1/index.ts.
// Routes (docs/handoffs/foundation.md): GET /, POST /, DELETE /:userId.
import { Hono } from "hono";
import type { AppEnv } from "../../env";

const staff = new Hono<AppEnv>();

staff.get("/", (c) => c.json({ module: "staff", status: "stub" }));

export default staff;
