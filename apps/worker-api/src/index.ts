import { Hono } from "hono";

type Bindings = {
  BUILD_SHA?: string;
  BUILD_TIME?: string;
};

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

app.notFound((c) => {
  if (new URL(c.req.url).pathname.startsWith("/api/")) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.text("Not Found", 404);
});

export default app;
