// Owner: WT-14. Two customer sign-in flows on the customer identity system's mount (`/api/auth/*`,
// ADR 0002), both delegated to the customer Better Auth instance; no session, code or token of our
// own (ADR 0011):
//
//   POST /api/auth/start/send-code   {email}                   Turnstile always; sends to anyone
//   POST /api/auth/start/verify      {email, code}             Turnstile always; creates the identity
//   POST /api/auth/connect/send-code {tenantCode, email}       only active members get a code
//   POST /api/auth/connect/verify    {tenantCode, email, code} session + active tenant = that tenant
//
// src/index.ts's gate runs first (exact allowlist, same-origin writes, honeypot, email
// normalisation; the account step-up for the connect paths). `/login` stays closed as built.
import {
  CONNECT_INVALID,
  ConnectSendCodeRequest,
  ConnectVerifyRequest,
  StartSendCodeRequest,
  StartVerifyRequest,
} from "@cloudbox/contracts";
import { and, eq, sql } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import type { ZodType } from "zod";
import { audit } from "../audit";
import { authContextFor, createCustomerAuth } from "../auth";
import {
  accountBudgetKey,
  OTP_ACCOUNT_BUDGET,
  TURNSTILE_HEADER,
  verifyTurnstile,
} from "../auth/challenge";
import { bumpCounter, counterKey } from "../auth/counters";
import { createDb } from "../db/client";
import { customerUsers, tenantMemberships, tenants } from "../db/schema";
import type { AppEnv } from "../env";
import { nowIso } from "../ids";
import { clientOf, LIMITS, setActiveTenant, withinLimit } from "./common";

const SEND_PATH = "/api/auth/email-otp/send-verification-otp";
const SIGN_IN_PATH = "/api/auth/sign-in/email-otp";
/** WT-1's per-(email, client) failed-code window (auth/index.ts OTP_FAILURE_CAP). */
const OTP_FAILURE_WINDOW_SECONDS = 60 * 60;

/**
 * Start-path codes to an address that has no customer identity yet, per 24 h, across all clients
 * (review P2-5). Above it: the same 200, nothing sent, audited once per day. No account exists, so
 * this ceiling cannot lock anyone out; the code already sent stays valid (resend reuses it).
 */
export const START_NEW_ADDRESS_DAILY_MAX = 10;
const DAY_SECONDS = 24 * 60 * 60;

/** Code emails actually attempted to `email` in the last 24 h (WT-1's `AUTH_OTP_SENT` rows). */
async function codesSentToday(db: ReturnType<typeof createDb>, email: string) {
  const since = new Date(Date.now() - DAY_SECONDS * 1000).toISOString();
  const row = await db.get<{ sent: number; ceiling: number }>(sql`
    SELECT
      (SELECT count(*) FROM audit_log WHERE entity_type = 'auth_email' AND entity_id = ${email}
         AND event_type = 'AUTH_OTP_SENT' AND created_at > ${since}
         AND json_extract(after_json, '$.outcome') IN ('sent', 'send_failed')) AS sent,
      (SELECT count(*) FROM audit_log WHERE entity_type = 'auth_email' AND entity_id = ${email}
         AND event_type = 'AUTH_START_CEILING' AND created_at > ${since}) AS ceiling`);
  return { sent: row?.sent ?? 0, ceilingAudited: (row?.ceiling ?? 0) > 0 };
}

async function body<T>(c: Context<AppEnv>, schema: ZodType<T>): Promise<T | null> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

/** Hands a rewritten request to the customer Better Auth instance for `flow`. */
function delegate(
  c: Context<AppEnv>,
  path: string,
  payload: Record<string, unknown>,
  flow: { flow: "start" | "connect"; connectTenantId?: string },
): Promise<Response> {
  const headers = new Headers(c.req.raw.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  const request = new Request(new URL(path, c.req.url), {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  return createCustomerAuth(c.env, { ...authContextFor(c), ...flow }).handler(request);
}

/** The start path always needs a Turnstile token (siteverify, hostname = ours; single use). */
async function turnstilePassed(c: Context<AppEnv>): Promise<boolean> {
  return verifyTurnstile(c.env, c.req.header(TURNSTILE_HEADER), {
    host: new URL(c.req.url).hostname,
    ip: c.req.header("cf-connecting-ip") ?? null,
  });
}

const challenge = (c: Context<AppEnv>) =>
  c.json(
    { error: "challenge_required", detail: { siteKey: c.env.TURNSTILE_SITE_KEY || null } },
    403,
  );

export const onboardingAuth = new Hono<AppEnv>();

onboardingAuth.post("/start/send-code", async (c) => {
  const input = await body(c, StartSendCodeRequest);
  if (!input) return c.json({ error: "invalid_request" }, 400);
  const db = createDb(c.env.DB);
  const client = clientOf(c);
  if (
    !(await withinLimit(db, LIMITS.startSendPerEmailClient, input.email, client)) ||
    !(await withinLimit(db, LIMITS.startSendPerClient, client))
  ) {
    return c.json({ error: "rate_limited" }, 429);
  }
  if (!(await turnstilePassed(c))) return challenge(c);
  const [existing] = await db
    .select({ id: customerUsers.id })
    .from(customerUsers)
    .where(eq(customerUsers.email, input.email))
    .limit(1);
  if (!existing) {
    const today = await codesSentToday(db, input.email);
    if (today.sent >= START_NEW_ADDRESS_DAILY_MAX) {
      if (!today.ceilingAudited) {
        await audit(db, {
          eventType: "AUTH_START_CEILING",
          entityType: "auth_email",
          entityId: input.email,
          actor: { type: "system", id: "start" },
          before: null,
          after: { sentToday: today.sent, max: START_NEW_ADDRESS_DAILY_MAX, client },
          correlationId: c.var.correlationId,
          source: "self_onboarding",
        });
      }
      return c.json({ success: true });
    }
  }
  return delegate(c, SEND_PATH, { email: input.email, type: "sign-in" }, { flow: "start" });
});

onboardingAuth.post("/start/verify", async (c) => {
  const input = await body(c, StartVerifyRequest);
  if (!input) return c.json({ error: "invalid_request" }, 400);
  const db = createDb(c.env.DB);
  if (!(await withinLimit(db, LIMITS.startVerifyPerClient, clientOf(c)))) {
    return c.json({ error: "rate_limited" }, 429);
  }
  if (!(await turnstilePassed(c))) return challenge(c);
  return delegate(c, SIGN_IN_PATH, { email: input.email, otp: input.code }, { flow: "start" });
});

/** The tenant (by public code) where `email` is an active member, or null. One query. */
async function membership(c: Context<AppEnv>, tenantCode: string, email: string) {
  const [row] = await createDb(c.env.DB)
    .select({ tenantId: tenants.id, tenantCode: tenants.publicCode })
    .from(tenants)
    .innerJoin(
      tenantMemberships,
      and(eq(tenantMemberships.tenantId, tenants.id), eq(tenantMemberships.status, "active")),
    )
    .innerJoin(
      customerUsers,
      and(eq(customerUsers.id, tenantMemberships.userId), eq(customerUsers.email, email)),
    )
    .where(eq(tenants.publicCode, tenantCode))
    .limit(1);
  return row ?? null;
}

/** Our per-client Connect limit, checked before anything else knows who is asking (P2-2). */
async function connectLimited(
  c: Context<AppEnv>,
  limit: { kind: string; max: number; windowSeconds: number },
) {
  return !(await withinLimit(createDb(c.env.DB), limit, clientOf(c)));
}

onboardingAuth.post("/connect/send-code", async (c) => {
  const input = await body(c, ConnectSendCodeRequest);
  if (!input) return c.json({ error: "invalid_request" }, 400);
  if (await connectLimited(c, LIMITS.connectSendPerClient)) {
    return c.json({ error: "rate_limited" }, 429);
  }
  const member = await membership(c, input.tenantCode, input.email);
  if (!member) {
    // Closed sign-in (ADR 0002): the same answer as a send, nothing generated, stored or sent.
    // Recorded at most once per (email, client) window, so anonymous calls cannot grow the log.
    const db = createDb(c.env.DB);
    const client = clientOf(c);
    if (await withinLimit(db, LIMITS.connectUnknownAudit, input.email, client)) {
      await audit(db, {
        eventType: "AUTH_OTP_SENT",
        entityType: "auth_email",
        entityId: input.email,
        actor: { type: "system", id: "email-otp" },
        before: null,
        after: { outcome: "not_member", surface: "connect", client },
        correlationId: c.var.correlationId,
        source: "api",
      });
    }
    return c.json({ success: true });
  }
  const sent = await delegate(
    c,
    SEND_PATH,
    { email: input.email, type: "sign-in" },
    { flow: "connect", connectTenantId: member.tenantId },
  );
  // Whatever Better Auth answered (its own caps included), the caller sees exactly what a
  // non-member sees (review P2-2).
  if (!sent.ok) console.warn("connect send-code: member send refused", sent.status);
  return c.json({ success: true });
});

onboardingAuth.post("/connect/verify", async (c) => {
  const input = await body(c, ConnectVerifyRequest);
  if (!input) return c.json({ error: "invalid_request" }, 400);
  if (await connectLimited(c, LIMITS.connectVerifyPerClient)) {
    return c.json({ error: "rate_limited" }, 429);
  }
  const member = await membership(c, input.tenantCode, input.email);
  if (!member) {
    // Fails exactly like a wrong code, and counts like one (WT-1's per-client and account caps).
    const db = createDb(c.env.DB);
    await bumpCounter(
      db,
      await counterKey("otp-fail", input.email, clientOf(c)),
      OTP_FAILURE_WINDOW_SECONDS,
    );
    await bumpCounter(db, await accountBudgetKey(input.email), OTP_ACCOUNT_BUDGET.windowSeconds);
    return c.json(CONNECT_INVALID, 400);
  }
  const response = await delegate(
    c,
    SIGN_IN_PATH,
    { email: input.email, otp: input.code },
    { flow: "connect", connectTenantId: member.tenantId },
  );
  // Every refusal on the member path is the one Connect answer, serialised by us (review P2-2).
  if (!response.ok) return c.json(CONNECT_INVALID, 400);
  const signedIn = (await response.clone().json()) as { user?: { id?: string } };
  if (signedIn.user?.id) {
    await setActiveTenant(createDb(c.env.DB), signedIn.user.id, member.tenantId, nowIso());
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(
    JSON.stringify({ ...signedIn, tenantId: member.tenantId, tenantCode: member.tenantCode }),
    { status: response.status, headers },
  );
});
