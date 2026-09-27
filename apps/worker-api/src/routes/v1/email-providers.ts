// Owner: WT-12. Module `emailProviders`, mounted at `/api/v1/settings/email-providers` in
// routes/v1/index.ts. GET / (list, masked), POST / (create), PATCH /:id (update, incl. reorder
// via `priority` and enable/disable), DELETE /:id (refuse if the only enabled provider: 409),
// POST /:id/test (send a test message to the caller's own email). All gated by `settings.manage`
// and audited EMAIL_PROVIDER_CREATED/UPDATED/DELETED/TESTED with before/after minus secrets.
import {
  CreateEmailProviderRequest,
  DeleteEmailProviderRequest,
  type EmailProvider,
  formatReason,
  SmtpConfig,
  UpdateEmailProviderRequest,
} from "@cloudbox/contracts";
import { zValidator } from "@hono/zod-validator";
import { and, asc, eq, ne } from "drizzle-orm";
import { Hono } from "hono";
import type { ZodType } from "zod";
import { audit } from "../../audit";
import { requirePermission } from "../../authz/permissions";
import { createDb, type Db } from "../../db/client";
import { encryptSecret, ProviderSecretsKeyMissingError } from "../../email/providers/crypto";
import { emailProviders } from "../../email/providers/schema";
import { invalidateProviderCache, testEmailProvider } from "../../email/send";
import type { AppEnv } from "../../env";
import { newId, nowIso } from "../../ids";

const validate = <T extends ZodType>(target: "json", schema: T) =>
  zValidator(target, schema, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: "invalid_request",
          detail: result.error.issues.map((issue) => ({
            path: issue.path,
            message: issue.message,
          })),
        },
        400,
      );
    }
  });

type ProviderRow = typeof emailProviders.$inferSelect;

function toEmailProvider(row: ProviderRow): EmailProvider {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    priority: row.priority,
    enabled: row.enabled,
    fromAddress: row.fromAddress,
    config: JSON.parse(row.configJson) as Record<string, unknown>,
    hasSecret: row.secretCiphertext !== null,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function findRow(db: Db, id: string): Promise<ProviderRow | undefined> {
  const [row] = await db.select().from(emailProviders).where(eq(emailProviders.id, id));
  return row;
}

/** True when `id` is the only currently-enabled row (deleting or disabling it leaves zero). */
async function isOnlyEnabled(db: Db, id: string): Promise<boolean> {
  const others = await db
    .select({ id: emailProviders.id })
    .from(emailProviders)
    .where(and(eq(emailProviders.enabled, true), ne(emailProviders.id, id)))
    .limit(1);
  return others.length === 0;
}

const emailProvidersRoute = new Hono<AppEnv>();

emailProvidersRoute.get("/", requirePermission("settings.manage"), async (c) => {
  const rows = await createDb(c.env.DB)
    .select()
    .from(emailProviders)
    .orderBy(asc(emailProviders.priority));
  return c.json({ items: rows.map(toEmailProvider) });
});

emailProvidersRoute.post(
  "/",
  requirePermission("settings.manage"),
  validate("json", CreateEmailProviderRequest),
  async (c) => {
    const body = c.req.valid("json");
    if (body.kind === "log" && c.env.ENVIRONMENT === "production") {
      return c.json(
        { error: "invalid_request", detail: "log_provider_disabled_in_production" },
        400,
      );
    }

    let configJson = "{}";
    let secret: { ciphertext: string; iv: string } | null = null;
    if (body.kind === "smtp") {
      configJson = JSON.stringify(SmtpConfig.parse(body.config));
      try {
        secret = await encryptSecret(body.secret, c.env.PROVIDER_SECRETS_KEY);
      } catch (error) {
        if (error instanceof ProviderSecretsKeyMissingError) {
          return c.json({ error: "provider_secrets_key_missing" }, 503);
        }
        throw error;
      }
    }

    const db = createDb(c.env.DB);
    const id = newId("emailProvider");
    const now = nowIso();
    const row: ProviderRow = {
      id,
      name: body.name,
      kind: body.kind,
      priority: body.priority,
      enabled: body.enabled,
      fromAddress: body.fromAddress,
      configJson,
      secretCiphertext: secret?.ciphertext ?? null,
      secretIv: secret?.iv ?? null,
      updatedBy: c.var.user.id,
      createdAt: now,
      updatedAt: now,
    };

    await db.batch([
      db.insert(emailProviders).values(row),
      audit(db, {
        eventType: "EMAIL_PROVIDER_CREATED",
        entityType: "email_provider",
        entityId: id,
        actor: { type: "user", id: c.var.user.id },
        before: null,
        after: toEmailProvider(row),
        correlationId: c.var.correlationId,
        source: "api",
      }),
    ]);
    invalidateProviderCache(c.env);
    return c.json(toEmailProvider(row), 201);
  },
);

emailProvidersRoute.patch(
  "/:id",
  requirePermission("settings.manage"),
  validate("json", UpdateEmailProviderRequest),
  async (c) => {
    const id = c.req.param("id");
    const db = createDb(c.env.DB);
    const existing = await findRow(db, id);
    if (!existing) return c.json({ error: "not_found" }, 404);

    const body = c.req.valid("json");
    if (body.config !== undefined && existing.kind !== "smtp") {
      return c.json({ error: "invalid_request", detail: "config_not_applicable" }, 400);
    }
    if (body.secret !== undefined && existing.kind !== "smtp") {
      return c.json({ error: "invalid_request", detail: "secret_not_applicable" }, 400);
    }
    if (
      existing.kind === "log" &&
      (body.enabled ?? existing.enabled) &&
      c.env.ENVIRONMENT === "production"
    ) {
      return c.json(
        { error: "invalid_request", detail: "log_provider_disabled_in_production" },
        400,
      );
    }
    if (existing.enabled && body.enabled === false && (await isOnlyEnabled(db, id))) {
      return c.json({ error: "conflict", detail: "last_enabled_provider" }, 409);
    }

    let configJson = existing.configJson;
    if (body.config !== undefined) {
      configJson = JSON.stringify(
        SmtpConfig.parse({ ...JSON.parse(existing.configJson), ...body.config }),
      );
    }

    let secretCiphertext = existing.secretCiphertext;
    let secretIv = existing.secretIv;
    if (body.secret !== undefined) {
      try {
        const secret = await encryptSecret(body.secret, c.env.PROVIDER_SECRETS_KEY);
        secretCiphertext = secret.ciphertext;
        secretIv = secret.iv;
      } catch (error) {
        if (error instanceof ProviderSecretsKeyMissingError) {
          return c.json({ error: "provider_secrets_key_missing" }, 503);
        }
        throw error;
      }
    }

    const updated: ProviderRow = {
      ...existing,
      name: body.name ?? existing.name,
      fromAddress: body.fromAddress ?? existing.fromAddress,
      priority: body.priority ?? existing.priority,
      enabled: body.enabled ?? existing.enabled,
      configJson,
      secretCiphertext,
      secretIv,
      updatedBy: c.var.user.id,
      updatedAt: nowIso(),
    };

    await db.batch([
      db.update(emailProviders).set(updated).where(eq(emailProviders.id, id)),
      audit(db, {
        eventType: "EMAIL_PROVIDER_UPDATED",
        entityType: "email_provider",
        entityId: id,
        actor: { type: "user", id: c.var.user.id },
        before: toEmailProvider(existing),
        after: toEmailProvider(updated),
        correlationId: c.var.correlationId,
        source: "api",
      }),
    ]);
    invalidateProviderCache(c.env);
    return c.json(toEmailProvider(updated));
  },
);

emailProvidersRoute.delete(
  "/:id",
  requirePermission("settings.manage"),
  validate("json", DeleteEmailProviderRequest),
  async (c) => {
    const { reasonCode, reasonText } = c.req.valid("json");
    const id = c.req.param("id");
    const db = createDb(c.env.DB);
    const existing = await findRow(db, id);
    if (!existing) return c.json({ error: "not_found" }, 404);
    if (existing.enabled && (await isOnlyEnabled(db, id))) {
      return c.json({ error: "conflict", detail: "last_enabled_provider" }, 409);
    }

    await db.batch([
      db.delete(emailProviders).where(eq(emailProviders.id, id)),
      audit(db, {
        eventType: "EMAIL_PROVIDER_DELETED",
        entityType: "email_provider",
        entityId: id,
        actor: { type: "user", id: c.var.user.id },
        before: toEmailProvider(existing),
        after: { reasonCode, reasonText, reason: formatReason({ reasonCode, reasonText }) },
        correlationId: c.var.correlationId,
        source: "api",
      }),
    ]);
    invalidateProviderCache(c.env);
    return c.body(null, 204);
  },
);

emailProvidersRoute.post("/:id/test", requirePermission("settings.manage"), async (c) => {
  const id = c.req.param("id");
  const db = createDb(c.env.DB);
  const existing = await findRow(db, id);
  if (!existing) return c.json({ error: "not_found" }, 404);

  const outcome = await testEmailProvider(c.env, existing, c.var.user.email, c.var.user.id);
  return c.json({
    ok: outcome.messageId !== undefined,
    messageId: outcome.messageId,
    errorCode: outcome.errorCode,
  });
});

export default emailProvidersRoute;
