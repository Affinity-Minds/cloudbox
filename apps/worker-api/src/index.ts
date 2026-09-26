import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { authContextFor, createAuth, HONEYPOT_HEADER } from "./auth";
import { customerCodeStepUp } from "./auth/challenge";
import { isSameOriginWrite, requireUser } from "./auth/middleware";
import { ensureBootstrapSuperAdmin } from "./auth/users";
import { createDb } from "./db/client";
import type { AppEnv, Bindings } from "./env";
import { changeFoundationRelease, loadFoundation } from "./foundation";
import { apiVersion, correlationId } from "./http";
import v1 from "./routes/v1";
import { logout } from "./routes/v1/auth";

export type { Bindings } from "./env";

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

const app = new Hono<AppEnv>();

app.use("/api/*", correlationId());
app.use("/api/v1/*", apiVersion());

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
    environment: c.env.ENVIRONMENT ?? "development",
  }),
);

// Better Auth. Only the endpoints the product uses answer (review H-2; ADR 0009: passwords for
// staff only, no sign-up, no reset by email);
// every other Better Auth or plugin path is 404, so a hidden endpoint cannot be a second way in.
// Exact match: a trailing-slash or case variant is not on the list either.
const AUTH_ROUTES = new Set([
  // Customers (tenant members): email code.
  "POST /api/auth/email-otp/send-verification-otp", // login, customer email step (type "sign-in")
  "POST /api/auth/sign-in/email-otp", // login, customer code step
  // Staff (ADR 0009): password + authenticator.
  "POST /api/auth/sign-in/email", // login, staff password step
  "POST /api/auth/two-factor/verify-totp", // login, staff authenticator step; setup confirmation
  "POST /api/auth/two-factor/verify-backup-code", // login, staff backup-code fallback
  "POST /api/auth/change-password", // /setup-password (forced at first sign-in)
  "POST /api/auth/two-factor/enable", // /setup-authenticator (QR + backup codes)
  "POST /api/auth/two-factor/generate-backup-codes", // regenerate backup codes (password)
  "POST /api/auth/two-factor/disable", // password + fresh authenticator code
  // Everyone.
  "POST /api/auth/sign-out", // routed to the audited v1 logout below
  "GET /api/auth/get-session", // Better Auth's session read (no state change beyond sliding expiry)
]);

const CUSTOMER_CODE_PATHS = new Set([
  "/api/auth/email-otp/send-verification-otp",
  "/api/auth/sign-in/email-otp",
]);

app.use("/api/auth/*", async (c, next) => {
  if (!AUTH_ROUTES.has(`${c.req.method} ${new URL(c.req.url).pathname}`)) {
    return c.json({ error: "not_found" }, 404);
  }
  // Login CSRF: auth writes must prove they come from our pages, with or without a cookie (L-2).
  if (!isSameOriginWrite(c)) return c.json({ error: "forbidden" }, 403);
  // Honeypot enforced server-side: a plain 400 that names nothing (agent-notes ux-patterns).
  if (c.req.header(HONEYPOT_HEADER)) return c.json({ error: "invalid_request" }, 400);
  // Customer codes: per-account step-up above the failure budget (Turnstile; review T-1).
  if (CUSTOMER_CODE_PATHS.has(new URL(c.req.url).pathname)) {
    const stepUp = await customerCodeStepUp(c);
    if (stepUp) return stepUp;
  }
  await next();
});
// Sign-out goes through the audited v1 logout so there is one way out.
app.post("/api/auth/sign-out", requireUser({ allowSetupPending: true }), logout);
app.on(["GET", "POST"], "/api/auth/*", async (c): Promise<Response> => {
  const request = authContextFor(c);
  // Until a super admin exists, the bootstrap address needs a user row to be able to sign in.
  await ensureBootstrapSuperAdmin(c.env, request);
  return createAuth(c.env, request).handler(c.req.raw);
});

app.get("/api/v1/foundation", async (c) => {
  try {
    const foundation = await loadFoundation(createDb(c.env.DB));
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

/** Length-hiding constant-time comparison for short secrets (compares SHA-256 digests). */
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

app.patch("/api/v1/foundation/release", async (c) => {
  const configuredKey = c.env.PHASE0_ADMIN_KEY;
  const suppliedKey = c.req.header("X-CloudBox-Phase0-Key");

  if (!configuredKey || !suppliedKey || !(await constantTimeEqual(suppliedKey, configuredKey))) {
    return c.json({ error: "forbidden" }, 403);
  }

  const parsed = releaseInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid_request" }, 400);
  }

  const result = await changeFoundationRelease(createDb(c.env.DB), parsed.data, {
    actor: { type: "bootstrap-admin", id: "github-actions" },
    correlationId: c.var.correlationId,
  });

  return c.json(result);
});

app.route("/api/v1", v1);

app.onError((error, c) => {
  if (error instanceof HTTPException) return error.getResponse();
  console.error("unhandled", c.var.correlationId, error);
  return c.json({ error: "internal_error" }, 500);
});

// Return directly: calling c.notFound() in here recurses (agent-notes cloudflare-workers #6).
app.notFound((c) => {
  if (new URL(c.req.url).pathname.startsWith("/api/")) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.text("Not Found", 404);
});

export default app;
