// Owner: WT-1. Per-account step-up for customer code sign-in (review T-1).
//
// Per-client limits cannot bound guessing spread over many networks, so every address also has a
// failure budget: OTP_ACCOUNT_BUDGET failed code checks per hour, counted across all clients.
// Above it nothing is locked: sending and checking codes for that address additionally need a
// valid Cloudflare Turnstile token, which a person passes and a guessing script does not. The login
// UI shows the widget only after the API answers 403 {error:'challenge_required'}.
//
// Fallback while TURNSTILE_SECRET_KEY is not configured: a 15-minute per-account cooldown
// (429 {error:'account_cooldown'}, audited AUTH_ACCOUNT_COOLDOWN). This is the only per-account
// denial in the system, and it exists only until the owner configures Turnstile.
import { sql } from "drizzle-orm";
import type { Context } from "hono";
import { audit } from "../audit";
import { createDb, type Db } from "../db/client";
import type { AppEnv, Bindings } from "../env";
import { claimOnce, counterKey } from "./counters";

export const OTP_ACCOUNT_BUDGET = { windowSeconds: 60 * 60, max: 30 };
export const ACCOUNT_COOLDOWN_SECONDS = 15 * 60;
/** Request header carrying the Turnstile token (Better Auth fixes the body shape). */
export const TURNSTILE_HEADER = "x-cloudbox-turnstile";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export const accountBudgetKey = (email: string) => counterKey("otp-fail-account", email);
const cooldownKey = (email: string) => counterKey("otp-cooldown", email);

/**
 * Validates a Turnstile token with siteverify (agent-notes cloudflare-workers traps 1–3: tokens are
 * single use; the hostname the challenge was solved on must be ours; pre-clearance stays off).
 */
export async function verifyTurnstile(
  env: Pick<Bindings, "TURNSTILE_SECRET_KEY">,
  token: string | undefined,
  request: { host: string; ip: string | null },
): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY || !token || token.length > 2048) return false;
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET_KEY);
  form.append("response", token);
  if (request.ip) form.append("remoteip", request.ip);
  try {
    const response = await fetch(SITEVERIFY, { method: "POST", body: form });
    const outcome = (await response.json()) as { success?: boolean; hostname?: string };
    return outcome.success === true && outcome.hostname === request.host;
  } catch (error) {
    console.error("turnstile siteverify failed", error);
    return false;
  }
}

async function counters(db: Db, email: string) {
  const [budget, cooldown] = await Promise.all([accountBudgetKey(email), cooldownKey(email)]);
  const rows = await db.all<{ key: string; count: number; last_request: number }>(
    sql`SELECT key, count, last_request FROM customer_rate_limit WHERE key IN (${budget}, ${cooldown})`,
  );
  const now = Date.now();
  const live = (key: string, windowSeconds: number) => {
    const row = rows.find((r) => r.key === key);
    return row && row.last_request >= now - windowSeconds * 1000 ? row.count : 0;
  };
  return {
    budgetKey: budget,
    cooldownKey: cooldown,
    failures: live(budget, OTP_ACCOUNT_BUDGET.windowSeconds),
    coolingDown: live(cooldown, ACCOUNT_COOLDOWN_SECONDS) > 0,
  };
}

/**
 * For POST /api/auth/email-otp/send-verification-otp and /api/auth/sign-in/email-otp: null to go
 * on, or the response that asks for the step-up. Uniform for every address (known, unknown, staff):
 * the budget only counts failures, which anyone can cause for any address.
 */
export async function customerCodeStepUp(
  c: Context<AppEnv>,
  normalisedEmail: string,
): Promise<Response | null> {
  const email = { data: normalisedEmail };
  const db = createDb(c.env.DB);
  const state = await counters(db, email.data);

  if (c.env.TURNSTILE_SECRET_KEY) {
    if (state.failures < OTP_ACCOUNT_BUDGET.max) return null;
    const url = new URL(c.req.url);
    const passed = await verifyTurnstile(c.env, c.req.header(TURNSTILE_HEADER), {
      host: url.hostname,
      ip: c.req.header("cf-connecting-ip") ?? null,
    });
    if (passed) return null;
    return c.json(
      { error: "challenge_required", detail: { siteKey: c.env.TURNSTILE_SITE_KEY ?? null } },
      403,
    );
  }

  // Fallback without Turnstile: a per-account cooldown, then a fresh budget.
  const cooldown = () =>
    c.json(
      { error: "account_cooldown", detail: { retryAfterSeconds: ACCOUNT_COOLDOWN_SECONDS } },
      429,
    );
  if (state.coolingDown) return cooldown();
  if (state.failures < OTP_ACCOUNT_BUDGET.max) return null;
  if (await claimOnce(db, state.cooldownKey, ACCOUNT_COOLDOWN_SECONDS)) {
    await db.run(sql`DELETE FROM customer_rate_limit WHERE key = ${state.budgetKey}`);
    await audit(db, {
      eventType: "AUTH_ACCOUNT_COOLDOWN",
      entityType: "auth_email",
      entityId: email.data,
      actor: { type: "system", id: "sign-in" },
      before: null,
      after: {
        failures: state.failures,
        cooldownSeconds: ACCOUNT_COOLDOWN_SECONDS,
        reason: "turnstile_not_configured",
      },
      correlationId: c.var.correlationId,
      source: "api",
    });
  }
  return cooldown();
}
