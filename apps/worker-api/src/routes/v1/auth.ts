// Owner: WT-1. Module `auth`, mounted at `/api/v1/auth` in routes/v1/index.ts.
// Routes (docs/handoffs/foundation.md): GET /session, POST /logout. Better Auth itself is mounted at /api/auth/* in src/index.ts.
import { Hono } from "hono";
import type { AppEnv } from "../../env";

const auth = new Hono<AppEnv>();

auth.get("/", (c) => c.json({ module: "auth", status: "stub" }));

export default auth;
