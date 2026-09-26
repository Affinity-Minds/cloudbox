// Owner: WT-1. Better Auth over D1 (Drizzle adapter) with email OTP as the only sign-in method.
// The plugin list is shared with the schema generator (src/auth/cli.ts) so the generated tables
// cannot drift from the running app (agent-notes cloudflare-workers #17). Change the plugin list
// only together with a regenerated schema (`pnpm auth:generate`).
import { Email, OtpSendRequest } from "@cloudbox/contracts";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, getIP } from "better-auth/api";
import { emailOTP } from "better-auth/plugins";
import { and, count, eq, gt, sql } from "drizzle-orm";
import type { Context } from "hono";
import { audit } from "../audit";
import { createDb, type Db } from "../db/client";
import * as schema from "../db/schema";
import { sendOtpEmail } from "../email";
import type { AppEnv, Bindings } from "../env";
import { rateLimit } from "./rate-limit-table";

export const PRODUCTION_ORIGIN = "https://box.affinityminds.in";
const VITE_DEV_ORIGIN = "http://localhost:5173";

/**
 * Origins allowed to write with a cookie, besides the request's own origin. The Vite dev server is
 * trusted only outside production (review L-1).
 */
export function trustedOrigins(env: Pick<Bindings, "ENVIRONMENT">): string[] {
  return env.ENVIRONMENT === "production"
    ? [PRODUCTION_ORIGIN]
    : [PRODUCTION_ORIGIN, VITE_DEV_ORIGIN];
}

/** Honeypot: the login form copies its hidden field here; any non-empty value is a bot. */
export const HONEYPOT_HEADER = "x-cloudbox-hp";

/**
 * OTP send caps on top of Better Auth's per-IP limit (3 / 60 s per IP or IPv6 /64), counted from
 * `AUTH_OTP_SENT` audit rows. The tight cap is per (email, client /64), so a third party cannot
 * spend the owner's quota (review H-1); the per-email ceiling only stops mail bombing. Over either
 * cap the caller gets the same 200 and nothing is generated, sent or recorded, for known and
 * unknown addresses alike, so the cap is neither a lockout nor an existence oracle.
 */
export const OTP_SEND_CAPS = {
  perEmailAndClient: { windowSeconds: 15 * 60, max: 5 },
  perEmail: { windowSeconds: 60 * 60, max: 30 },
};

/** Failed verifies for an address with no user row: at most one audit row per window (review M-3). */
export const UNKNOWN_EMAIL_FAILURE_WINDOW_SECONDS = 15 * 60;

/** Audit entity for events keyed by an email address rather than a user id (anti-enumeration). */
export const AUTH_EMAIL_ENTITY = "auth_email";

const SEND_OTP_PATH = "/email-otp/send-verification-otp";
const SIGN_IN_OTP_PATH = "/sign-in/email-otp";

export type AuthRequestContext = {
  correlationId?: string | null;
  /** `executionCtx.waitUntil` when serving a request: the email send runs after the response. */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Origin of the incoming request. Better Auth would infer the same; passing it is explicit. */
  baseURL?: string;
};

/**
 * Fail closed on configuration that would weaken auth: no secret (review L-10), or the OTP echo
 * in production. Called by `createAuth`, so every auth request refuses to run misconfigured.
 */
export function assertAuthConfig(
  env: Pick<Bindings, "ENVIRONMENT" | "OTP_DEV_ECHO" | "BETTER_AUTH_SECRET">,
): void {
  if (!env.BETTER_AUTH_SECRET) throw new Error("BETTER_AUTH_SECRET is not set");
  if (env.ENVIRONMENT === "production" && env.OTP_DEV_ECHO === "1") {
    throw new Error("OTP_DEV_ECHO must not be set in production");
  }
}

/** The client key used for per-client caps: Better Auth's IP resolution (IPv6 masked to /64). */
function clientKey(
  source: Request | Headers | undefined,
  options: Parameters<typeof getIP>[1],
): string {
  return (source && getIP(source, options)) || "unknown";
}

async function otpSendCounts(db: Db, email: string, client: string) {
  const now = Date.now();
  const tightSince = new Date(now - OTP_SEND_CAPS.perEmailAndClient.windowSeconds * 1000);
  const wideSince = new Date(now - OTP_SEND_CAPS.perEmail.windowSeconds * 1000);
  const { auditLog } = schema;
  const [row] = await db
    .select({
      total: count(),
      fromClient:
        sql<number>`coalesce(sum(case when ${auditLog.createdAt} > ${tightSince.toISOString()}
        and json_extract(${auditLog.afterJson}, '$.client') = ${client} then 1 else 0 end), 0)`.mapWith(
          Number,
        ),
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, AUTH_EMAIL_ENTITY),
        eq(auditLog.entityId, email),
        eq(auditLog.eventType, "AUTH_OTP_SENT"),
        gt(auditLog.createdAt, wideSince.toISOString()),
      ),
    );
  return { total: row?.total ?? 0, fromClient: row?.fromClient ?? 0 };
}

async function recentFailure(db: Db, email: string): Promise<boolean> {
  const since = new Date(Date.now() - UNKNOWN_EMAIL_FAILURE_WINDOW_SECONDS * 1000).toISOString();
  const { auditLog } = schema;
  const [row] = await db
    .select({ n: count() })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, AUTH_EMAIL_ENTITY),
        eq(auditLog.entityId, email),
        eq(auditLog.eventType, "AUTH_LOGIN_FAILED"),
        gt(auditLog.createdAt, since),
      ),
    );
  return (row?.n ?? 0) > 0;
}

function errorCode(returned: unknown): string {
  if (returned instanceof APIError) {
    const body = returned.body as { code?: string } | undefined;
    return body?.code ?? returned.status.toString();
  }
  return "unknown";
}

export function authOptions(env: Bindings, request: AuthRequestContext = {}) {
  const correlationId = request.correlationId ?? null;
  const db = createDb(env.DB);
  return {
    baseURL: request.baseURL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: trustedOrigins(env),
    database: drizzleAdapter(db, { provider: "sqlite", schema: { ...schema, rateLimit } }),
    emailAndPassword: { enabled: false },
    // Per-IP limits, stored in D1 so every isolate shares them. The emailOTP plugin's rules apply
    // to its paths (OTP send and sign-in: 3 / 60 s each); everything else under /api/auth is 60/min.
    rateLimit: { enabled: true, storage: "database", window: 60, max: 60 },
    advanced: {
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      // Session + user in one D1 round trip (the relations are in db/schema.ts).
      database: { joins: true },
      // Send the email after answering, so a known address does not answer measurably slower than
      // an unknown one (Better Auth's own advice for the OTP sender). Without a request context
      // (tests, scripts) the send is awaited.
      ...(request.waitUntil ? { backgroundTasks: { handler: request.waitUntil } } : {}),
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== SEND_OTP_PATH) return;
        // Only sign-in codes exist here; other types would answer differently for unknown emails.
        const parsed = OtpSendRequest.safeParse(ctx.body);
        if (!parsed.success) throw new APIError("BAD_REQUEST", { message: "Invalid request" });
        const email = parsed.data.email;
        const client = clientKey(ctx.request ?? ctx.headers, ctx.context.options);
        const sends = await otpSendCounts(db, email, client);
        if (
          sends.fromClient >= OTP_SEND_CAPS.perEmailAndClient.max ||
          sends.total >= OTP_SEND_CAPS.perEmail.max
        ) {
          // Same answer as a send; any code already sent stays valid (resendStrategy "reuse").
          return ctx.json({ success: true });
        }
        // Closed sign-in (ADR 0002): an address without a user row gets exactly the answer a known
        // one gets, but no code is generated, stored or sent. Recorded like a send (with the client),
        // so the caps above bound these rows too.
        if (!(await ctx.context.internalAdapter.findUserByEmail(email))) {
          const record = audit(db, {
            eventType: "AUTH_OTP_SENT",
            entityType: AUTH_EMAIL_ENTITY,
            entityId: email,
            actor: { type: "system", id: "email-otp" },
            before: null,
            after: { outcome: "unknown_email", client },
            correlationId,
            source: "api",
          }).then(() => undefined);
          await ctx.context.runInBackgroundOrAwait(record);
          return ctx.json({ success: true });
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== SIGN_IN_OTP_PATH) return;
        const signedIn = ctx.context.newSession;
        if (signedIn) {
          await audit(db, {
            eventType: "AUTH_LOGIN_SUCCEEDED",
            entityType: "user",
            entityId: signedIn.user.id,
            actor: { type: "user", id: signedIn.user.id },
            before: null,
            after: { sessionId: signedIn.session.id },
            correlationId,
            source: "api",
          });
          return;
        }
        const body = ctx.body as { email?: unknown } | undefined;
        const parsedEmail = Email.safeParse(body?.email);
        const email = parsedEmail.success ? parsedEmail.data : "invalid";
        // An address with no user row can only ever fail; record it once per window, not per
        // attempt, so anonymous callers cannot grow the append-only log without bound (M-3).
        if (
          (!parsedEmail.success || !(await ctx.context.internalAdapter.findUserByEmail(email))) &&
          (await recentFailure(db, email))
        ) {
          return;
        }
        // Never the submitted code; the reason is Better Auth's error code.
        await audit(db, {
          eventType: "AUTH_LOGIN_FAILED",
          entityType: AUTH_EMAIL_ENTITY,
          entityId: email,
          actor: { type: "system", id: "email-otp" },
          before: null,
          after: { reason: errorCode(ctx.context.returned) },
          correlationId,
          source: "api",
        });
      }),
    },
    plugins: [
      emailOTP({
        otpLength: 6,
        // Never create a user at sign-in; rows come only from admin actions (src/auth/users.ts).
        disableSignUp: true,
        expiresIn: 5 * 60,
        allowedAttempts: 3,
        // A resend re-sends the code that is still valid (extending its expiry, keeping its attempt
        // count) instead of replacing it, so nobody else's send request can invalidate the code in
        // the owner's inbox (review H-1). Reuse needs a recoverable form: Better Auth's encryption
        // with BETTER_AUTH_SECRET.
        storeOTP: "encrypted",
        resendStrategy: "reuse",
        async sendVerificationOTP({ email, otp }, ctx) {
          const client = clientKey(ctx?.request ?? ctx?.headers, ctx?.context.options ?? {});
          await sendOtpEmail(env, { to: email, code: otp }, { correlationId, client });
        },
      }),
    ],
  } satisfies BetterAuthOptions;
}

export function createAuth(env: Bindings, request: AuthRequestContext = {}) {
  assertAuthConfig(env);
  return betterAuth(authOptions(env, request));
}

/** The auth instance for a Hono request: its correlation id and its own origin as base URL. */
export function authFor(c: Context<AppEnv>) {
  return createAuth(c.env, authContextFor(c));
}

export function authContextFor(c: Context<AppEnv>): AuthRequestContext {
  let waitUntil: AuthRequestContext["waitUntil"];
  try {
    const executionCtx = c.executionCtx;
    waitUntil = (promise) => executionCtx.waitUntil(promise);
  } catch {
    // app.request() in tests has no ExecutionContext.
  }
  return { correlationId: c.var.correlationId, baseURL: new URL(c.req.url).origin, waitUntil };
}

export type Auth = ReturnType<typeof createAuth>;
