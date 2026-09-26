// Owner: WT-12. Unit-level coverage for the provider abstraction and `sendEmail`'s ordering,
// fallback and audit behaviour — everything below `routes/v1/email-providers.ts`.
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/client";
import { auditLog } from "../src/db/schema";
import {
  decryptSecret,
  encryptSecret,
  ProviderSecretsKeyMissingError,
} from "../src/email/providers/crypto";
import { emailProviders } from "../src/email/providers/schema";
import { createSmtpProvider, type WorkerMailerSend } from "../src/email/providers/smtp";
import { invalidateProviderCache, sendEmail } from "../src/email/send";
import type { Bindings } from "../src/env";

// 32 raw bytes, base64 — matches PROVIDER_SECRETS_KEY's documented shape.
const TEST_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

describe("provider secret encryption", () => {
  it("round-trips and never reuses an IV", async () => {
    const a = await encryptSecret("hunter2", TEST_KEY);
    const b = await encryptSecret("hunter2", TEST_KEY);
    expect(a.iv).not.toEqual(b.iv);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
    expect(await decryptSecret(a, TEST_KEY)).toBe("hunter2");
    expect(await decryptSecret(b, TEST_KEY)).toBe("hunter2");
  });

  it("refuses to encrypt or decrypt without PROVIDER_SECRETS_KEY", async () => {
    await expect(encryptSecret("x", undefined)).rejects.toBeInstanceOf(
      ProviderSecretsKeyMissingError,
    );
    const encrypted = await encryptSecret("x", TEST_KEY);
    await expect(decryptSecret(encrypted, undefined)).rejects.toBeInstanceOf(
      ProviderSecretsKeyMissingError,
    );
  });
});

describe("smtp provider (fake worker-mailer, no socket opened)", () => {
  const config = {
    host: "smtp.example.test",
    port: 587,
    secure: false,
    username: "bot@example.test",
    password: "secret",
    from: "bot@example.test",
  };

  it("sends and returns a synthesised messageId (worker-mailer's send() resolves void)", async () => {
    const calls: unknown[] = [];
    const fakeSend: WorkerMailerSend = (async (options, email) => {
      calls.push({ options, email });
    }) as WorkerMailerSend;

    const provider = createSmtpProvider(config, fakeSend);
    const result = await provider.send({ to: "user@example.test", subject: "Hi", text: "Hello" });
    expect(result.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls).toEqual([
      {
        options: expect.objectContaining({ host: "smtp.example.test", port: 587, secure: false }),
        email: expect.objectContaining({ to: "user@example.test", subject: "Hi", text: "Hello" }),
      },
    ]);
  });

  it("wraps a failure as EmailProviderError with a stable code, never the password", async () => {
    const fakeSend: WorkerMailerSend = (async () => {
      throw new Error("535 authentication failed");
    }) as WorkerMailerSend;

    const provider = createSmtpProvider(config, fakeSend);
    const failure = provider.send({ to: "user@example.test", subject: "Hi", text: "Hello" });
    await expect(failure).rejects.toMatchObject({ code: "E_SMTP_SEND_FAILED" });
    await expect(failure).rejects.not.toMatchObject({ message: expect.stringContaining("secret") });
  });
});

async function auditAfter(entityType: string, entityId: string) {
  const rows = await createDb(env.DB)
    .select()
    .from(auditLog)
    .where(eq(auditLog.entityId, entityId));
  return rows
    .filter((row) => row.entityType === entityType)
    .map((row) => ({
      eventType: row.eventType,
      after: row.afterJson ? JSON.parse(row.afterJson) : null,
    }));
}

describe("sendEmail: ordering, fallback, audit", () => {
  it("falls back to the EMAIL binding when no providers are configured", async () => {
    // Guarantee zero rows and an uncached view of them, regardless of test order.
    await env.DB.prepare("DELETE FROM email_providers").run();
    invalidateProviderCache(env);

    const sent: unknown[] = [];
    const bindingEnv: Bindings = {
      ...env,
      EMAIL: {
        send: async (m: unknown) => {
          sent.push(m);
          return { messageId: "bound-1" };
        },
      } as never,
    };
    const outcome = await sendEmail(
      bindingEnv,
      { to: "fallback@example.test", subject: "Hi", text: "Hello" },
      { purpose: "test-fallback" },
    );
    expect(outcome).toEqual({ messageId: "bound-1" });
    expect(sent).toHaveLength(1);

    const events = await auditAfter("email_send", "fallback@example.test");
    expect(events).toContainEqual({
      eventType: "EMAIL_SENT",
      after: {
        purpose: "test-fallback",
        providerId: "binding-fallback",
        kind: "cloudflare_binding",
        messageId: "bound-1",
      },
    });
  });

  it("tries providers in priority order; a failing provider is audited and skipped, the next one is used", async () => {
    await env.DB.prepare("DELETE FROM email_providers").run();
    invalidateProviderCache(env);
    const db = createDb(env.DB);
    const now = new Date().toISOString();
    await db.insert(emailProviders).values([
      {
        id: "eprv_first",
        name: "First (fails)",
        kind: "cloudflare_binding",
        priority: 1,
        enabled: true,
        fromAddress: "first@example.test",
        configJson: "{}",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "eprv_second",
        name: "Second (succeeds)",
        kind: "log",
        priority: 2,
        enabled: true,
        fromAddress: "second@example.test",
        configJson: "{}",
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const failingEnv: Bindings = {
      ...env,
      EMAIL: {
        send: async () => {
          throw Object.assign(new Error("nope"), { code: "E_SENDER_NOT_VERIFIED" });
        },
      } as never,
    };
    const outcome = await sendEmail(
      failingEnv,
      { to: "order-test@example.test", subject: "Hi", text: "Hello" },
      { purpose: "test-order" },
    );
    expect(outcome.messageId).toBeDefined();

    const events = await auditAfter("email_send", "order-test@example.test");
    expect(events).toContainEqual({
      eventType: "EMAIL_FAILED",
      after: {
        purpose: "test-order",
        providerId: "eprv_first",
        kind: "cloudflare_binding",
        errorCode: "E_SENDER_NOT_VERIFIED",
      },
    });
    expect(events).toContainEqual({
      eventType: "EMAIL_SENT",
      after: {
        purpose: "test-order",
        providerId: "eprv_second",
        kind: "log",
        messageId: outcome.messageId,
      },
    });
  });
});
