import { Email } from "@cloudbox/contracts";
import type { Context, Next } from "hono";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { authContextFor, createAuth, customerAuthFor, HONEYPOT_HEADER } from "./auth";
import { customerCodeStepUp } from "./auth/challenge";
import { guardFor, isSameOriginWrite } from "./auth/middleware";
import { ensureBootstrapSuperAdmin } from "./auth/users";
import { createDb } from "./db/client";
import type { AppEnv } from "./env";
import { changeFoundationRelease, loadFoundation } from "./foundation";
import { apiVersion, correlationId } from "./http";
import { onboardingAuth } from "./onboarding/auth-routes";
import { serveAsset } from "./ops-shell";
// WT-16: the FleetPresence Durable Object lives in src/realtime/fleet-presence.ts; re-exported
// here because `main`/`exports` (wrangler.jsonc) bind the class from this file.
import { FleetPresence } from "./realtime/fleet-presence";
import v1 from "./routes/v1";
import { logoutFor } from "./routes/v1/auth";
import { scheduled } from "./scheduled";

export type { Bindings } from "./env";
export { FleetPresence };

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

// Better Auth, two separate surfaces (owner decision; ADR 0002/0009). Each mount answers only the
// endpoints its product uses (review H-2), exact match; everything else is the ordinary 404, so a
// staff endpoint does not exist under /api/auth and a customer one does not exist under /api/ops/auth.
const CUSTOMER_AUTH_ROUTES = new Set([
  "POST /api/auth/email-otp/send-verification-otp", // /login, email step (type "sign-in")
  "POST /api/auth/sign-in/email-otp", // /login, code step
  "POST /api/auth/sign-out", // routed to the audited logout below
  "GET /api/auth/get-session",
  // WT-14 (ADR 0011), served by src/onboarding/auth-routes.ts through the same customer instance:
  "POST /api/auth/start/send-code", // /start: self-service, Turnstile always
  "POST /api/auth/start/verify",
  "POST /api/auth/connect/send-code", // CloudBox Connect: Tenant ID + email + code
  "POST /api/auth/connect/verify",
]);
const STAFF_AUTH_ROUTES = new Set([
  "POST /api/ops/auth/sign-in/email", // <ops>/login, password step
  "POST /api/ops/auth/two-factor/verify-totp", // <ops>/login authenticator step; setup confirmation
  "POST /api/ops/auth/two-factor/verify-backup-code", // <ops>/login backup-code fallback
  "POST /api/ops/auth/change-password", // <ops>/setup-password (forced at first sign-in)
  "POST /api/ops/auth/two-factor/enable", // <ops>/setup-authenticator (QR + backup codes)
  "POST /api/ops/auth/two-factor/generate-backup-codes", // regenerate backup codes (password)
  "POST /api/ops/auth/two-factor/disable", // password + fresh authenticator code
  "POST /api/ops/auth/sign-out", // routed to the audited logout below
  "GET /api/ops/auth/get-session",
]);
/** Paths whose body names an email: parsed and normalised here, before anything counts (U-1). */
const EMAIL_BODY_PATHS = new Set([
  "/api/auth/email-otp/send-verification-otp",
  "/api/auth/sign-in/email-otp",
  "/api/ops/auth/sign-in/email",
  "/api/auth/start/send-code",
  "/api/auth/start/verify",
  "/api/auth/connect/send-code",
  "/api/auth/connect/verify",
]);
// The start paths are not here: they require a Turnstile token on every call (a stronger rule),
// and a token is single use, so the step-up must not spend it first.
const CUSTOMER_CODE_PATHS = new Set([
  "/api/auth/email-otp/send-verification-otp",
  "/api/auth/sign-in/email-otp",
  "/api/auth/connect/send-code",
  "/api/auth/connect/verify",
]);

/** The request Better Auth sees: the original, or one whose `email` was normalised (U-1). */
const normalisedRequests = new WeakMap<Request, Request>();

function authGate(routes: Set<string>) {
  return async (c: Context<AppEnv>, next: Next) => {
    const path = new URL(c.req.url).pathname;
    if (!routes.has(`${c.req.method} ${path}`)) return c.json({ error: "not_found" }, 404);
    // Login CSRF: auth writes must prove they come from our pages, with or without a cookie (L-2).
    if (!isSameOriginWrite(c)) return c.json({ error: "forbidden" }, 403);
    // Honeypot enforced server-side: a plain 400 that names nothing (agent-notes ux-patterns).
    if (c.req.header(HONEYPOT_HEADER)) return c.json({ error: "invalid_request" }, 400);
    if (EMAIL_BODY_PATHS.has(path)) {
      // One spelling per mailbox: NFKC + lower-case, then validated. An address that does not
      // parse is refused here, never passed on (review U-1: Better Auth would lower-case a
      // variant CloudBox's own limits did not recognise).
      const body = (await c.req.raw
        .clone()
        .json()
        .catch(() => null)) as Record<string, unknown> | null;
      const email = Email.safeParse(body?.email);
      if (!body || !email.success) return c.json({ error: "invalid_request" }, 400);
      normalisedRequests.set(
        c.req.raw,
        new Request(c.req.raw, { body: JSON.stringify({ ...body, email: email.data }) }),
      );
      // Customer codes: per-account step-up above the failure budget (Turnstile; review T-1).
      if (CUSTOMER_CODE_PATHS.has(path)) {
        const stepUp = await customerCodeStepUp(c, email.data);
        if (stepUp) return stepUp;
      }
    }
    await next();
  };
}

app.use("/api/auth/*", authGate(CUSTOMER_AUTH_ROUTES));
app.use("/api/ops/auth/*", authGate(STAFF_AUTH_ROUTES));
// Staff API responses are never indexed (the discreet ops surface).
app.use("/api/ops/*", async (c, next) => {
  await next();
  c.res.headers.set("X-Robots-Tag", "noindex, nofollow");
});
// Sign-out goes through the audited logout so there is one way out per surface.
app.post(
  "/api/auth/sign-out",
  guardFor("customer", () => true),
  logoutFor("customer"),
);
app.post(
  "/api/ops/auth/sign-out",
  guardFor("staff", () => true, { allowSetupPending: true }),
  logoutFor("staff"),
);
// Self-service start and Connect sign-in (WT-14): exact paths, before the Better Auth catch-all.
app.route("/api/auth", onboardingAuth);
app.on(
  ["GET", "POST"],
  "/api/auth/*",
  (c): Promise<Response> =>
    customerAuthFor(c).handler(normalisedRequests.get(c.req.raw) ?? c.req.raw),
);
app.on(["GET", "POST"], "/api/ops/auth/*", async (c): Promise<Response> => {
  const context = authContextFor(c);
  // Until a super admin exists, the bootstrap address needs a staff identity (one read once it does).
  await ensureBootstrapSuperAdmin(c.env, context);
  return createAuth(c.env, context).handler(normalisedRequests.get(c.req.raw) ?? c.req.raw);
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
// Everything outside /api is the SPA and its assets (run_worker_first), served through
// ops-shell.ts so the staff console document is marked only under OPS_BASE_PATH.
app.notFound((c) => {
  if (new URL(c.req.url).pathname.startsWith("/api/")) {
    return c.json({ error: "not_found" }, 404);
  }
  return serveAsset(c);
});

// WT-19: the Worker's Cron entry point (`src/scheduled.ts`'s own hook list). A module worker's
// default export needs a `scheduled` method alongside `fetch` for Cron Triggers to fire
// (`wrangler.jsonc`'s `triggers.crons`) — attached to the same `app` object, not a replacement
// default export, so every existing test's `app.request(...)` (Hono's own test helper) keeps
// working unchanged; Hono's `fetch` is already an instance property, so this only adds one.
export default Object.assign(app, { scheduled });
