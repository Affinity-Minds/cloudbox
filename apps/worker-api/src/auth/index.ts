// Owner: WT-1. Better Auth over D1 (Drizzle adapter) with email OTP as the only sign-in method.
// The plugin list is shared with the schema generator (src/auth/cli.ts) so the generated tables
// cannot drift from the running app (agent-notes cloudflare-workers #17). Change the plugin list
// only together with a regenerated schema (`pnpm auth:generate`).
import { OtpSendRequest } from "@cloudbox/contracts";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
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
/** Origins allowed to post to `/api/auth/*` with a cookie. The request's own origin is added by Better Auth. */
export const TRUSTED_ORIGINS = [PRODUCTION_ORIGIN, "http://localhost:5173"];

/** Honeypot: the login form copies its hidden field here; any non-empty value is a bot. */
export const HONEYPOT_HEADER = "x-cloudbox-hp";

/** OTP sends per email address (on top of Better Auth's per-IP limits), counted from the audit log. */
export const OTP_SENDS_PER_EMAIL = { windowSeconds: 15 * 60, max: 5 };

/** Audit entity for events keyed by an email address rather than a user id (anti-enumeration). */
export const AUTH_EMAIL_ENTITY = "auth_email";

const SEND_OTP_PATH = "/email-otp/send-verification-otp";
const SIGN_IN_OTP_PATH = "/sign-in/email-otp";

export type AuthRequestContext = {
  correlationId?: string | null;
  /** Origin of the incoming request. Better Auth would infer the same; passing it is explicit. */
  baseURL?: string;
};

/**
 * OTP echo is for local development only. A production deploy that carries `OTP_DEV_ECHO=1` is
 * misconfigured: refuse to build the auth instance at all rather than risk leaking codes.
 */
export function assertOtpEchoSafe(env: Pick<Bindings, "ENVIRONMENT" | "OTP_DEV_ECHO">): void {
  if (env.ENVIRONMENT === "production" && env.OTP_DEV_ECHO === "1") {
    throw new Error("OTP_DEV_ECHO must not be set in production");
  }
}

async function otpSendsInWindow(db: Db, email: string): Promise<number> {
  const since = new Date(Date.now() - OTP_SENDS_PER_EMAIL.windowSeconds * 1000).toISOString();
  const [row] = await db
    .select({ n: count() })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.entityType, AUTH_EMAIL_ENTITY),
        eq(schema.auditLog.entityId, email),
        eq(schema.auditLog.eventType, "AUTH_OTP_SENT"),
        gt(schema.auditLog.createdAt, since),
      ),
    );
  return row?.n ?? 0;
}

/**
 * First successful sign-in of `BOOTSTRAP_SUPER_ADMIN_EMAIL` while no super admin exists grants the
 * role. The existence check and the insert are one statement, so two racing sign-ins cannot both win.
 */
async function bootstrapSuperAdmin(
  env: Bindings,
  db: Db,
  user: { id: string; email: string },
  correlationId: string | null,
): Promise<void> {
  const bootstrapEmail = env.BOOTSTRAP_SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  if (!bootstrapEmail || user.email.toLowerCase() !== bootstrapEmail) return;
  const result = await db.run(sql`
    INSERT INTO staff_members (user_id, role, created_by)
    SELECT ${user.id}, 'super_admin', 'system'
    WHERE NOT EXISTS (SELECT 1 FROM staff_members WHERE role = 'super_admin')
    ON CONFLICT (user_id) DO NOTHING`);
  if ((result.meta?.changes ?? 0) === 0) return;
  await audit(db, {
    eventType: "STAFF_ROLE_GRANTED",
    entityType: "staff_member",
    entityId: user.id,
    actor: { type: "system", id: "bootstrap" },
    before: null,
    after: { role: "super_admin", email: user.email, reason: "bootstrap" },
    correlationId,
    source: "api",
  });
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
    trustedOrigins: TRUSTED_ORIGINS,
    database: drizzleAdapter(db, { provider: "sqlite", schema: { ...schema, rateLimit } }),
    emailAndPassword: { enabled: false },
    // Per-IP limits, stored in D1 so every isolate shares them. Better Auth's defaults apply per
    // path (sign-in 3/10 s, OTP send 3/60 s); everything else under /api/auth is 60/min.
    rateLimit: { enabled: true, storage: "database", window: 60, max: 60 },
    advanced: {
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      // Session + user in one D1 round trip (the relations are in db/schema.ts).
      database: { joins: true },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== SEND_OTP_PATH) return;
        // Only sign-in codes exist here; other types would answer differently for unknown emails.
        const parsed = OtpSendRequest.safeParse(ctx.body);
        if (!parsed.success) throw new APIError("BAD_REQUEST", { message: "Invalid request" });
        if ((await otpSendsInWindow(db, parsed.data.email)) >= OTP_SENDS_PER_EMAIL.max) {
          throw new APIError("TOO_MANY_REQUESTS", {
            message: "Too many requests. Please try again later.",
          });
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
          await bootstrapSuperAdmin(env, db, signedIn.user, correlationId);
          return;
        }
        const body = ctx.body as { email?: unknown } | undefined;
        const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
        // Never the submitted code; the reason is Better Auth's error code.
        await audit(db, {
          eventType: "AUTH_LOGIN_FAILED",
          entityType: AUTH_EMAIL_ENTITY,
          entityId: email.slice(0, 254) || "unknown",
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
        expiresIn: 5 * 60,
        allowedAttempts: 3,
        storeOTP: "hashed",
        // A resend replaces the stored code, so only the newest code verifies.
        resendStrategy: "rotate",
        async sendVerificationOTP({ email, otp }) {
          await sendOtpEmail(env, { to: email, code: otp }, { correlationId });
        },
      }),
    ],
  } satisfies BetterAuthOptions;
}

export function createAuth(env: Bindings, request: AuthRequestContext = {}) {
  assertOtpEchoSafe(env);
  return betterAuth(authOptions(env, request));
}

/** The auth instance for a Hono request: its correlation id and its own origin as base URL. */
export function authFor(c: Context<AppEnv>) {
  return createAuth(c.env, {
    correlationId: c.var.correlationId,
    baseURL: new URL(c.req.url).origin,
  });
}

export type Auth = ReturnType<typeof createAuth>;
