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
import { and, eq } from "drizzle-orm";
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

onboardingAuth.post("/connect/send-code", async (c) => {
  const input = await body(c, ConnectSendCodeRequest);
  if (!input) return c.json({ error: "invalid_request" }, 400);
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
  return delegate(
    c,
    SEND_PATH,
    { email: input.email, type: "sign-in" },
    { flow: "connect", connectTenantId: member.tenantId },
  );
});

onboardingAuth.post("/connect/verify", async (c) => {
  const input = await body(c, ConnectVerifyRequest);
  if (!input) return c.json({ error: "invalid_request" }, 400);
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
  if (!response.ok) return response;
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
