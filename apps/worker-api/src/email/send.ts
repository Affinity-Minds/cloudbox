// Owner: WT-12. Loads enabled `email_providers` rows ordered by priority, tries each in turn,
// returns the first success, audits every attempt. Falls back to the `EMAIL` binding when no
// rows exist, so `sendOtpEmail`'s pre-registry behaviour (WT-1) is unchanged.
//
// Caching: one D1 query per isolate, TTL 60 s (agent-notes cloudflare-workers #11 "two-tier
// caching" — this Worker only needs the in-memory tier; nothing here is expensive enough for
// `caches.default`). Agent-notes #5 warns that module-level state in a multi-hostname Worker
// needs the host in its key; CloudBox serves one hostname, so instead the cache is keyed by the
// `D1Database` binding identity (a `WeakMap`) — every isolate/test gets its own binding instance,
// which gives the same isolation guarantee without inventing an origin nobody passes in here.
import { type EmailProviderKind, SmtpConfig } from "@cloudbox/contracts";
import { asc, eq } from "drizzle-orm";
import { type AuditInput, audit } from "../audit";
import { createDb, type Db } from "../db/client";
import type { Bindings } from "../env";
import { createCloudflareBindingProvider } from "./providers/cloudflare-binding";
import { decryptSecret } from "./providers/crypto";
import { createLogProvider } from "./providers/log";
import { emailProviders } from "./providers/schema";
import { createSmtpProvider } from "./providers/smtp";
import { type EmailMessage, type EmailProvider, EmailProviderError } from "./providers/types";

export type SendEmailOptions = { purpose: string; correlationId?: string | null };
/**
 * `providerId`/`kind` are always set (even on failure) so a caller that writes its own audit row
 * — `sendOtpEmail`'s `AUTH_OTP_SENT` (WT-1) — can record which provider actually handled the send
 * without re-deriving it.
 */
export type SendEmailOutcome = {
  messageId?: string;
  errorCode?: string;
  providerId: string;
  kind: EmailProviderKind;
};

export type ProviderRow = {
  id: string;
  name: string;
  kind: EmailProviderKind;
  fromAddress: string;
  configJson: string;
  secretCiphertext: string | null;
  secretIv: string | null;
};

const CACHE_TTL_MS = 60_000;
const cache = new WeakMap<D1Database, { rows: ProviderRow[]; expiresAt: number }>();

async function loadEnabledProviders(env: Bindings): Promise<ProviderRow[]> {
  const cached = cache.get(env.DB);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.rows;

  const rows = await createDb(env.DB)
    .select({
      id: emailProviders.id,
      name: emailProviders.name,
      kind: emailProviders.kind,
      fromAddress: emailProviders.fromAddress,
      configJson: emailProviders.configJson,
      secretCiphertext: emailProviders.secretCiphertext,
      secretIv: emailProviders.secretIv,
    })
    .from(emailProviders)
    .where(eq(emailProviders.enabled, true))
    .orderBy(asc(emailProviders.priority));

  cache.set(env.DB, { rows, expiresAt: now + CACHE_TTL_MS });
  return rows;
}

/** Call after any write to `email_providers` so the next send sees it within the request. */
export function invalidateProviderCache(env: Bindings): void {
  cache.delete(env.DB);
}

async function buildProvider(env: Bindings, row: ProviderRow): Promise<EmailProvider> {
  if (row.kind === "cloudflare_binding") return createCloudflareBindingProvider(env);
  if (row.kind === "log") {
    if (env.ENVIRONMENT === "production") {
      throw new EmailProviderError("E_LOG_PROVIDER_DISABLED_IN_PRODUCTION");
    }
    return createLogProvider();
  }
  // smtp
  if (!row.secretCiphertext || !row.secretIv) {
    throw new EmailProviderError("E_SMTP_SECRET_MISSING");
  }
  const config = SmtpConfig.parse(JSON.parse(row.configJson)); // agent-notes #16: parse, don't trust raw JSON
  const password = await decryptSecret(
    { ciphertext: row.secretCiphertext, iv: row.secretIv },
    env.PROVIDER_SECRETS_KEY,
  );
  return createSmtpProvider({ ...config, password, from: row.fromAddress });
}

/** `sendEmail` never throws (callers, e.g. Better Auth's OTP hook, must not see a rejected
 * promise), so an audit-write failure is swallowed the same way `sendOtpEmail` swallows its own. */
async function safeAudit(db: Db, input: AuditInput): Promise<void> {
  try {
    await audit(db, input);
  } catch (error) {
    console.error("email send audit failed", error);
  }
}

async function auditAttempt(
  env: Bindings,
  eventType: "EMAIL_SENT" | "EMAIL_FAILED",
  entityId: string,
  after: Record<string, unknown>,
  correlationId: string | null | undefined,
): Promise<void> {
  await safeAudit(createDb(env.DB), {
    eventType,
    entityType: "email_send",
    entityId,
    actor: { type: "system", id: "email-send" },
    before: null,
    after,
    correlationId: correlationId ?? null,
    source: "api",
  });
}

async function attempt(
  env: Bindings,
  row: Pick<ProviderRow, "id" | "kind" | "fromAddress">,
  provider: EmailProvider,
  message: EmailMessage,
  options: SendEmailOptions,
): Promise<SendEmailOutcome> {
  const entityId = message.to.toLowerCase();
  try {
    const result = await provider.send({ ...message, from: message.from ?? row.fromAddress });
    await auditAttempt(
      env,
      "EMAIL_SENT",
      entityId,
      { purpose: options.purpose, providerId: row.id, kind: row.kind, messageId: result.messageId },
      options.correlationId,
    );
    return { messageId: result.messageId, providerId: row.id, kind: row.kind };
  } catch (error) {
    const errorCode = error instanceof EmailProviderError ? error.code : "E_SEND_FAILED";
    await auditAttempt(
      env,
      "EMAIL_FAILED",
      entityId,
      { purpose: options.purpose, providerId: row.id, kind: row.kind, errorCode },
      options.correlationId,
    );
    return { errorCode, providerId: row.id, kind: row.kind };
  }
}

/** Sends `message`, trying configured providers in priority order, then the `EMAIL` binding if
 * none are configured. Never throws — callers get `{errorCode}` on total failure. */
export async function sendEmail(
  env: Bindings,
  message: EmailMessage,
  options: SendEmailOptions,
): Promise<SendEmailOutcome> {
  let rows: ProviderRow[];
  try {
    rows = await loadEnabledProviders(env);
  } catch (error) {
    console.error("loading email providers failed", error);
    rows = [];
  }

  if (rows.length === 0) {
    return attempt(
      env,
      { id: "binding-fallback", kind: "cloudflare_binding", fromAddress: env.EMAIL_FROM ?? "" },
      createCloudflareBindingProvider(env),
      message,
      options,
    );
  }

  let last: SendEmailOutcome = {
    errorCode: "E_ALL_PROVIDERS_FAILED",
    providerId: rows[0]?.id ?? "unknown",
    kind: rows[0]?.kind ?? "cloudflare_binding",
  };
  for (const row of rows) {
    let provider: EmailProvider;
    try {
      provider = await buildProvider(env, row);
    } catch (error) {
      const errorCode = error instanceof EmailProviderError ? error.code : "E_PROVIDER_UNAVAILABLE";
      await auditAttempt(
        env,
        "EMAIL_FAILED",
        message.to.toLowerCase(),
        { purpose: options.purpose, providerId: row.id, kind: row.kind, errorCode },
        options.correlationId,
      );
      last = { errorCode, providerId: row.id, kind: row.kind };
      continue;
    }
    const outcome = await attempt(env, row, provider, message, options);
    if (outcome.messageId) return outcome;
    last = outcome;
  }
  return last;
}

/**
 * Sends a one-off test message through exactly `row` (bypassing priority/fallback), for
 * `POST /:id/test`. Audits `EMAIL_PROVIDER_TESTED` itself; `sendEmail`'s own audit events are not
 * reused because a test is not a `purpose`-carrying application send.
 */
export async function testEmailProvider(
  env: Bindings,
  row: ProviderRow,
  to: string,
  actorId: string,
): Promise<SendEmailOutcome> {
  const db = createDb(env.DB);
  let outcome: SendEmailOutcome;
  try {
    const provider = await buildProvider(env, row);
    const result = await provider.send({
      to,
      from: row.fromAddress,
      subject: "CloudBox test email",
      text: `This is a test message from the "${row.name}" email provider (${row.kind}).`,
    });
    outcome = { messageId: result.messageId, providerId: row.id, kind: row.kind };
  } catch (error) {
    outcome = {
      errorCode: error instanceof EmailProviderError ? error.code : "E_SEND_FAILED",
      providerId: row.id,
      kind: row.kind,
    };
  }
  await safeAudit(db, {
    eventType: "EMAIL_PROVIDER_TESTED",
    entityType: "email_provider",
    entityId: row.id,
    actor: { type: "user", id: actorId },
    before: null,
    after: outcome,
    source: "api",
  });
  return outcome;
}
