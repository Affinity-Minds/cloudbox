// Owner: WT-1. Better Auth over D1 (Drizzle adapter) with email OTP as the only sign-in method.
// The plugin list is shared with the schema generator (src/auth/cli.ts) so the generated tables
// cannot drift from the running app (agent-notes cloudflare-workers #17). Change the plugin list
// only together with a regenerated schema (`pnpm auth:generate`).
import { Email, OtpSendRequest } from "@cloudbox/contracts";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, getIP, getSessionFromCtx } from "better-auth/api";
import { emailOTP, twoFactor } from "better-auth/plugins";
import { and, count, eq, gt, sql } from "drizzle-orm";
import type { Context } from "hono";
import { audit } from "../audit";
import { createDb, type Db } from "../db/client";
import * as schema from "../db/schema";
import { sendOtpEmail } from "../email";
import type { AppEnv, Bindings } from "../env";
import {
  bumpCounter,
  COUNTER_HORIZON_SECONDS,
  claimOnce,
  counterKey,
  readCounter,
} from "./counters";
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

/** Staff passwords: initial ones set by an admin, and every change. */
export const MIN_PASSWORD_LENGTH = 12;

/** Honeypot: the login form copies its hidden field here; any non-empty value is a bot. */
export const HONEYPOT_HEADER = "x-cloudbox-hp";

/**
 * OTP send cap on top of Better Auth's per-IP limit (3 / 60 s per IP or IPv6 /64), counted from
 * `AUTH_OTP_SENT` audit rows: 5 per (email, client /64) in 15 min, so a caller can neither mail-bomb
 * an address from one client nor spend anyone else's quota. There is deliberately no per-email
 * ceiling: any ceiling that other clients can fill locks the owner out (reviews H-1, S-2). Over the
 * cap the caller gets the same 200 and nothing is generated, sent or recorded, for known and
 * unknown addresses alike, so the cap is neither a lockout nor an existence oracle.
 */
export const OTP_SEND_CAP = { windowSeconds: 15 * 60, max: 5 };

/**
 * Failed code sign-ins per (email, client /64) across codes (review S-6): above it every attempt
 * fails like a wrong code without being checked, which bounds slow guessing to 10 per hour per
 * client on top of the 3 attempts per code.
 */
export const OTP_FAILURE_CAP = { windowSeconds: 60 * 60, max: 10 };

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

async function otpSendsFromClient(db: Db, email: string, client: string): Promise<number> {
  const since = new Date(Date.now() - OTP_SEND_CAP.windowSeconds * 1000).toISOString();
  const { auditLog } = schema;
  const [row] = await db
    .select({ n: count() })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, AUTH_EMAIL_ENTITY),
        eq(auditLog.entityId, email),
        eq(auditLog.eventType, "AUTH_OTP_SENT"),
        gt(auditLog.createdAt, since),
        sql`json_extract(${auditLog.afterJson}, '$.client') = ${client}`,
      ),
    );
  return row?.n ?? 0;
}

async function recentFailure(db: Db, email: string, method: string): Promise<boolean> {
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
        sql`json_extract(${auditLog.afterJson}, '$.method') = ${method}`,
      ),
    );
  return (row?.n ?? 0) > 0;
}

const SIGN_IN_PASSWORD_PATH = "/sign-in/email";
const CHANGE_PASSWORD_PATH = "/change-password";
const TWO_FACTOR_ENABLE_PATH = "/two-factor/enable";
const TWO_FACTOR_DISABLE_PATH = "/two-factor/disable";
const TOTP_VERIFY_PATH = "/two-factor/verify-totp";
const BACKUP_CODE_VERIFY_PATH = "/two-factor/verify-backup-code";
const SESSION_SETUP_PATHS = new Set([
  CHANGE_PASSWORD_PATH,
  TWO_FACTOR_ENABLE_PATH,
  TWO_FACTOR_DISABLE_PATH,
  TOTP_VERIFY_PATH,
  BACKUP_CODE_VERIFY_PATH,
  "/two-factor/generate-backup-codes",
]);

/** Better Auth's wrong-code answers, reused so our refusals are indistinguishable from its own. */
const INVALID_OTP = { code: "INVALID_OTP", message: "Invalid OTP" };
const INVALID_CODE = { code: "INVALID_CODE", message: "Invalid code" };

/** Better Auth's wrong-password answer; every refused password sign-in answers with this body. */
const INVALID_EMAIL_OR_PASSWORD = {
  code: "INVALID_EMAIL_OR_PASSWORD",
  message: "Invalid email or password",
};

/**
 * Failed password sign-ins per (email, client /64): 5 in 15 min locks that client out with a 429
 * carrying the same body as a wrong password. There is no per-account ceiling: any ceiling other
 * clients can fill would refuse the owner's correct password (review S-1). The account itself is
 * protected by the authenticator step (Better Auth's challenge limit and account lockout) and by
 * Better Auth's per-IP limit. Counted uniformly for every address in `counters.ts`.
 */
export const PASSWORD_FAILURE_CAP = { windowSeconds: 15 * 60, max: 5 };

/** A sign-in authenticator code is refused if already accepted within this time (review S-3). */
const TOTP_REUSE_WINDOW_SECONDS = 120;

type Actor = {
  userId: string;
  email?: string;
  staff?: boolean;
  mustChangePassword?: boolean;
  twoFactorEnabled?: boolean;
  /** True on the second step of a password sign-in (no session yet). */
  viaChallenge?: boolean;
};

/** Deletes every trusted-device record of a user (Better Auth keeps them as verification rows). */
export function deleteTrustedDevices(db: Db, userId: string) {
  return db.run(
    sql`DELETE FROM verification WHERE identifier LIKE 'trust-device-%' AND value = ${userId}`,
  );
}

/** Lets hooks call the instance's own endpoints (the fresh-TOTP check on disable). */
type AuthSelf = {
  auth?: {
    api: { verifyTOTP: (input: { headers: Headers; body: { code: string } }) => Promise<unknown> };
  };
};

/** The user row and staff state for an email: one query. */
async function accountByEmail(db: Db, email: string) {
  const [row] = await db
    .select({
      userId: schema.user.id,
      staffRole: schema.staffMembers.role,
      mustChangePassword: schema.staffMembers.mustChangePassword,
    })
    .from(schema.user)
    .leftJoin(schema.staffMembers, eq(schema.staffMembers.userId, schema.user.id))
    .where(eq(schema.user.email, email.toLowerCase()))
    .limit(1);
  return row ?? null;
}

function auditLoginFailure(
  db: Db,
  email: string,
  after: Record<string, unknown>,
  correlationId: string | null,
) {
  // Never the submitted code or password.
  return audit(db, {
    eventType: "AUTH_LOGIN_FAILED",
    entityType: AUTH_EMAIL_ENTITY,
    entityId: email,
    actor: { type: "system", id: "sign-in" },
    before: null,
    after,
    correlationId,
    source: "api",
  });
}

function auditLoginSuccess(
  db: Db,
  userId: string,
  after: Record<string, unknown>,
  correlationId: string | null,
) {
  return audit(db, {
    eventType: "AUTH_LOGIN_SUCCEEDED",
    entityType: "user",
    entityId: userId,
    actor: { type: "user", id: userId },
    before: null,
    after,
    correlationId,
    source: "api",
  });
}

function auditUserEvent(
  db: Db,
  eventType: string,
  userId: string,
  after: Record<string, unknown> | null,
  correlationId: string | null,
) {
  return audit(db, {
    eventType,
    entityType: "user",
    entityId: userId,
    actor: { type: "user", id: userId },
    before: null,
    after,
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

export function authOptions(env: Bindings, request: AuthRequestContext = {}, self: AuthSelf = {}) {
  const correlationId = request.correlationId ?? null;
  const db = createDb(env.DB);
  // Who is acting on a session or two-factor endpoint; set by the before hook, read by the after
  // hook. One auth instance serves one request, so this closure is per request.
  let actor: Actor | null = null;
  // True while the disable pre-check runs its nested authenticator verification.
  let disabling = false;
  return {
    baseURL: request.baseURL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: trustedOrigins(env),
    database: drizzleAdapter(db, { provider: "sqlite", schema: { ...schema, rateLimit } }),
    // Passwords exist only for staff (ADR 0009). No sign-up and no reset by email: an admin sets
    // an initial password (POST /api/v1/staff), which forces a change and re-enrolment.
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: 256,
      revokeSessionsOnPasswordReset: true,
    },
    // Per-IP limits, stored in D1 so every isolate shares them. The emailOTP plugin's rules apply
    // to its paths (OTP send and sign-in: 3 / 60 s each); everything else under /api/auth is 60/min.
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 60,
      // Never matches a request: it only makes Better Auth keep idle rows for an hour, so the
      // counters in counters.ts (same table) outlive their 15/60-minute windows.
      customRules: { "/cloudbox-counter-horizon": { window: COUNTER_HORIZON_SECONDS, max: 1 } },
    },
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
        const client = clientKey(ctx.request ?? ctx.headers, ctx.context.options);
        switch (ctx.path) {
          case SEND_OTP_PATH: {
            // Only sign-in codes exist here; other types would answer differently for unknown emails.
            const parsed = OtpSendRequest.safeParse(ctx.body);
            if (!parsed.success) throw new APIError("BAD_REQUEST", { message: "Invalid request" });
            const email = parsed.data.email;
            if ((await otpSendsFromClient(db, email, client)) >= OTP_SEND_CAP.max) {
              // Same answer as a send; any code already sent stays valid (resendStrategy "reuse").
              return ctx.json({ success: true });
            }
            // Closed sign-in (ADR 0002/0009): an address without a user row, or a staff address
            // (staff sign in with password + authenticator, never with a code), gets exactly the
            // answer a customer gets, but no code is generated, stored or sent. Recorded like a
            // send (with the client), so the caps above bound these rows too.
            const account = await accountByEmail(db, email);
            if (!account || account.staffRole) {
              const record = audit(db, {
                eventType: "AUTH_OTP_SENT",
                entityType: AUTH_EMAIL_ENTITY,
                entityId: email,
                actor: { type: "system", id: "email-otp" },
                before: null,
                after: { outcome: account ? "staff_email" : "unknown_email", client },
                correlationId,
                source: "api",
              }).then(() => undefined);
              await ctx.context.runInBackgroundOrAwait(record);
              return ctx.json({ success: true });
            }
            return;
          }
          case SIGN_IN_OTP_PATH: {
            const email = Email.safeParse((ctx.body as { email?: unknown } | undefined)?.email);
            if (!email.success) return;
            // Too many failed codes from this client for this address (S-6): fail like a wrong
            // code, without checking it and without consuming an attempt.
            const failures = await counterKey("otp-fail", email.data, client);
            if (
              (await readCounter(db, failures, OTP_FAILURE_CAP.windowSeconds)) >=
              OTP_FAILURE_CAP.max
            ) {
              throw APIError.from("BAD_REQUEST", INVALID_OTP);
            }
            // A staff address never holds a code; refuse it exactly like a wrong code.
            if ((await accountByEmail(db, email.data))?.staffRole) {
              await bumpCounter(db, failures, OTP_FAILURE_CAP.windowSeconds);
              await auditLoginFailure(
                db,
                email.data,
                { method: "email_otp", reason: "INVALID_OTP", client },
                correlationId,
              );
              throw APIError.from("BAD_REQUEST", INVALID_OTP);
            }
            return;
          }
          case SIGN_IN_PASSWORD_PATH: {
            const body = ctx.body as { email?: unknown; password?: unknown } | undefined;
            const email = Email.safeParse(body?.email);
            if (!email.success) return; // Better Auth answers INVALID_EMAIL.
            const failures = await counterKey("pw-fail", email.data, client);
            if (
              (await readCounter(db, failures, PASSWORD_FAILURE_CAP.windowSeconds)) >=
              PASSWORD_FAILURE_CAP.max
            ) {
              // Locked for this client only; nothing is hashed or recorded beyond the limit.
              throw APIError.from("TOO_MANY_REQUESTS", INVALID_EMAIL_OR_PASSWORD);
            }
            // Passwords are for staff only: anyone else fails exactly like a wrong password, after
            // the same hashing work Better Auth does for an unknown user (so timing does not tell
            // staff addresses apart), and counts toward the same per-client limit.
            if (!(await accountByEmail(db, email.data))?.staffRole) {
              await ctx.context.password.hash(
                typeof body?.password === "string" ? body.password : "",
              );
              await bumpCounter(db, failures, PASSWORD_FAILURE_CAP.windowSeconds);
              // Not an account anyone can sign in to: one audit row per window, not per attempt.
              if (!(await recentFailure(db, email.data, "password"))) {
                await auditLoginFailure(
                  db,
                  email.data,
                  { method: "password", reason: "INVALID_EMAIL_OR_PASSWORD", client },
                  correlationId,
                );
              }
              throw APIError.from("UNAUTHORIZED", INVALID_EMAIL_OR_PASSWORD);
            }
            return;
          }
        }
        if (!SESSION_SETUP_PATHS.has(ctx.path)) return;

        // Password change and authenticator endpoints: who is acting, and in which order.
        const session = await getSessionFromCtx(ctx);
        if (session) {
          const staff = await accountByEmail(db, session.user.email);
          actor = {
            userId: session.user.id,
            email: session.user.email,
            staff: Boolean(staff?.staffRole),
            mustChangePassword: Boolean(staff?.mustChangePassword),
            twoFactorEnabled: Boolean(
              (session.user as { twoFactorEnabled?: boolean }).twoFactorEnabled,
            ),
          };
        } else if (ctx.path === TOTP_VERIFY_PATH || ctx.path === BACKUP_CODE_VERIFY_PATH) {
          // Second step of a password sign-in: the pending challenge names the user.
          const cookie = ctx.context.createAuthCookie("two_factor");
          const challenge = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
          const pending = challenge
            ? await ctx.context.internalAdapter.findVerificationValue(challenge)
            : null;
          actor = pending ? { userId: pending.value, viaChallenge: true } : null;
        }
        if (ctx.path === CHANGE_PASSWORD_PATH) {
          const body = ctx.body as { currentPassword?: unknown; newPassword?: unknown } | undefined;
          if (body?.currentPassword === body?.newPassword) {
            throw APIError.from("BAD_REQUEST", {
              code: "PASSWORD_UNCHANGED",
              message: "Choose a password different from the current one",
            });
          }
          // A password change always ends every other session (review S-8), whatever the client sent.
          return { context: { body: { ...(ctx.body as object), revokeOtherSessions: true } } };
        }
        if (ctx.path === TWO_FACTOR_ENABLE_PATH) {
          // Authenticators are for staff, and only after the initial password was replaced.
          if (!actor?.staff)
            throw APIError.from("FORBIDDEN", { code: "NOT_STAFF", message: "Forbidden" });
          if (actor.mustChangePassword) {
            throw APIError.from("FORBIDDEN", {
              code: "PASSWORD_CHANGE_REQUIRED",
              message: "Change the initial password first",
            });
          }
        }
        if (ctx.path === TWO_FACTOR_DISABLE_PATH) {
          // Turning the second factor off needs a fresh authenticator code, not only the password.
          const code = (ctx.body as { code?: unknown } | undefined)?.code;
          if (typeof code !== "string" || !self.auth) {
            throw APIError.from("UNAUTHORIZED", INVALID_CODE);
          }
          // The nested verification goes through these hooks too, including the replay claim.
          disabling = true;
          try {
            await self.auth.api.verifyTOTP({
              headers: ctx.headers ?? new Headers(),
              body: { code },
            });
          } finally {
            disabling = false;
          }
        }
        if (ctx.path === TOTP_VERIFY_PATH || ctx.path === BACKUP_CODE_VERIFY_PATH) {
          const body = (ctx.body ?? {}) as { code?: unknown };
          // A sign-in or step-up code that was already accepted is refused like a wrong one (S-3).
          if (
            ctx.path === TOTP_VERIFY_PATH &&
            actor &&
            (actor.viaChallenge || disabling) &&
            typeof body.code === "string" &&
            (await readCounter(
              db,
              await counterKey("totp-used", actor.userId, body.code),
              TOTP_REUSE_WINDOW_SECONDS,
            )) > 0
          ) {
            throw APIError.from("UNAUTHORIZED", INVALID_CODE);
          }
          // CloudBox never trusts a device to skip the authenticator (review S-4).
          return { context: { body: { ...body, trustDevice: false } } };
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        const returned = ctx.context.returned;
        const failed = returned instanceof APIError;
        const client = clientKey(ctx.request ?? ctx.headers, ctx.context.options);
        const signedIn = ctx.context.newSession;
        switch (ctx.path) {
          case SIGN_IN_OTP_PATH: {
            if (signedIn) {
              await auditLoginSuccess(
                db,
                signedIn.user.id,
                { method: "email_otp", sessionId: signedIn.session.id },
                correlationId,
              );
              return;
            }
            const body = ctx.body as { email?: unknown } | undefined;
            const parsedEmail = Email.safeParse(body?.email);
            const email = parsedEmail.success ? parsedEmail.data : "invalid";
            if (parsedEmail.success) {
              await bumpCounter(
                db,
                await counterKey("otp-fail", email, client),
                OTP_FAILURE_CAP.windowSeconds,
              );
            }
            // An address with no user row can only ever fail; record it once per window, not per
            // attempt, so anonymous callers cannot grow the append-only log without bound (M-3).
            if (
              (!parsedEmail.success ||
                !(await ctx.context.internalAdapter.findUserByEmail(email))) &&
              (await recentFailure(db, email, "email_otp"))
            ) {
              return;
            }
            await auditLoginFailure(
              db,
              email,
              { method: "email_otp", reason: errorCode(returned), client },
              correlationId,
            );
            return;
          }
          case SIGN_IN_PASSWORD_PATH: {
            if (signedIn) {
              // No authenticator yet (first sign-in): the session only reaches the setup steps.
              await auditLoginSuccess(
                db,
                signedIn.user.id,
                { method: "password", setupPending: true, sessionId: signedIn.session.id },
                correlationId,
              );
              return;
            }
            if (failed) {
              const email = Email.safeParse((ctx.body as { email?: unknown } | undefined)?.email);
              if (email.success) {
                await bumpCounter(
                  db,
                  await counterKey("pw-fail", email.data, client),
                  PASSWORD_FAILURE_CAP.windowSeconds,
                );
                // Only staff reach this point (everyone else is refused before the check), so a
                // failure is for an account that exists: audited per attempt.
                await auditLoginFailure(
                  db,
                  email.data,
                  { method: "password", reason: errorCode(returned), client },
                  correlationId,
                );
              }
            }
            // Otherwise the password was right and a second factor is pending (twoFactorRedirect).
            return;
          }
          case TOTP_VERIFY_PATH:
          case BACKUP_CODE_VERIFY_PATH: {
            const method = ctx.path === TOTP_VERIFY_PATH ? "totp" : "backup_code";
            if (!actor) return;
            if (failed) {
              await audit(db, {
                eventType: "AUTH_LOGIN_FAILED",
                entityType: "user",
                entityId: actor.userId,
                actor: { type: "system", id: "two-factor" },
                before: null,
                after: { method, reason: errorCode(returned), client },
                correlationId,
                source: "api",
              });
              return;
            }
            const code = (ctx.body as { code?: unknown } | undefined)?.code;
            if (
              method === "totp" &&
              (actor.viaChallenge || disabling) &&
              typeof code === "string" &&
              !(await claimOnce(
                db,
                await counterKey("totp-used", actor.userId, code),
                TOTP_REUSE_WINDOW_SECONDS,
              ))
            ) {
              // Lost a race with a concurrent use of the same code: undo the session it created.
              if (signedIn) await ctx.context.internalAdapter.deleteSession(signedIn.session.token);
              throw APIError.from("UNAUTHORIZED", INVALID_CODE);
            }
            if (actor.viaChallenge) {
              await auditLoginSuccess(
                db,
                actor.userId,
                { method: `password+${method}`, sessionId: signedIn?.session.id ?? null },
                correlationId,
              );
            } else if (!actor.twoFactorEnabled && method === "totp") {
              await auditUserEvent(
                db,
                "AUTH_2FA_ENABLED",
                actor.userId,
                { method: "totp" },
                correlationId,
              );
            }
            return;
          }
        }
        if (failed || !actor || !SESSION_SETUP_PATHS.has(ctx.path)) return;
        if (ctx.path === CHANGE_PASSWORD_PATH) {
          await db
            .update(schema.staffMembers)
            .set({ mustChangePassword: false })
            .where(eq(schema.staffMembers.userId, actor.userId));
          await deleteTrustedDevices(db, actor.userId);
          await auditUserEvent(db, "AUTH_PASSWORD_CHANGED", actor.userId, null, correlationId);
        } else if (ctx.path === TWO_FACTOR_ENABLE_PATH) {
          await auditUserEvent(
            db,
            "AUTH_2FA_ENROLLMENT_STARTED",
            actor.userId,
            null,
            correlationId,
          );
        } else if (ctx.path === "/two-factor/generate-backup-codes") {
          await auditUserEvent(
            db,
            "AUTH_2FA_BACKUP_CODES_REGENERATED",
            actor.userId,
            null,
            correlationId,
          );
        } else if (ctx.path === TWO_FACTOR_DISABLE_PATH) {
          await auditUserEvent(db, "AUTH_2FA_DISABLED", actor.userId, null, correlationId);
        }
      }),
    },
    plugins: [
      // Staff second factor: authenticator app (TOTP) with backup codes. Better Auth's own
      // account lockout (10 consecutive failures → 15 min) applies to sign-in verification.
      twoFactor({
        issuer: "CloudBox",
        totpOptions: { digits: 6, period: 30 },
        backupCodeOptions: { amount: 10, length: 10 },
      }),
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
  const self: AuthSelf = {};
  const auth = betterAuth(authOptions(env, request, self));
  self.auth = auth;
  return auth;
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
