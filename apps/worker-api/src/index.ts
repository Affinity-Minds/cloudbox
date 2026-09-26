import { Hono } from "hono";
import { z } from "zod";
import { changeFoundationRelease, loadFoundation } from "./db/audit";

export type Bindings = {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  FLEET_PRESENCE: DurableObjectNamespace;
  BUILD_SHA?: string;
  BUILD_TIME?: string;
  PHASE0_ADMIN_KEY?: string;
};

export class FleetPresence {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Bindings,
  ) {}

  async fetch(): Promise<Response> {
    void this.state;
    void this.env;
    return new Response(null, { status: 204 });
  }
}

const app = new Hono<{ Bindings: Bindings }>();

app.get("/api/health", (c) =>
  c.json({
    status: "ok",
    service: "cloudbox-control-plane",
  }),
);

app.get("/api/version", (c) =>
  c.json({
    service: "cloudbox-control-plane",
    gitSha: c.env.BUILD_SHA ?? "development",
    builtAt: c.env.BUILD_TIME ?? "development",
  }),
);

app.use("/api/v1/*", async (c, next) => {
  await next();
  c.header("X-API-Version", "v1");
});

app.get("/api/v1", (c) =>
  c.json({
    name: "CloudBox API",
    version: "v1",
    status: "foundation",
  }),
);

app.get("/api/v1/foundation", async (c) => {
  try {
    const foundation = await loadFoundation(c.env.DB);
    return c.json({
      version: {
        gitSha: c.env.BUILD_SHA ?? "development",
        builtAt: c.env.BUILD_TIME ?? "development",
      },
      ...foundation,
    });
  } catch (error) {
    console.error("foundation loader failed", error);
    return c.json({ error: "foundation_unavailable" }, 503);
  }
});

const releaseInput = z.object({
  status: z.string().min(1).max(64),
  sha: z.string().min(1).max(128),
});

app.patch("/api/v1/foundation/release", async (c) => {
  const configuredKey = c.env.PHASE0_ADMIN_KEY;
  const suppliedKey = c.req.header("X-CloudBox-Phase0-Key");

  if (!configuredKey || !suppliedKey || suppliedKey !== configuredKey) {
    return c.json({ error: "forbidden" }, 403);
  }

  const parsed = releaseInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid_request" }, 400);
  }

  const result = await changeFoundationRelease(c.env.DB, parsed.data, {
    type: "bootstrap-admin",
    id: "github-actions",
  });

  return c.json(result);
});

app.notFound((c) => {
  if (new URL(c.req.url).pathname.startsWith("/api/")) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.text("Not Found", 404);
});

export default app;
