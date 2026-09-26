import { z } from "zod";
import { Email } from "./auth";
import { prefixedId } from "./common";

/** `/api/v1/settings/email-providers` (owner: WT-12). */
export const EMAIL_PROVIDER_KINDS = ["cloudflare_binding", "smtp", "log"] as const;
export const EmailProviderKind = z.enum(EMAIL_PROVIDER_KINDS);
export type EmailProviderKind = z.infer<typeof EmailProviderKind>;

/** Non-secret SMTP fields, stored in `config_json`. The password never appears here. */
export const SmtpConfig = z.object({
  host: z.string().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535),
  secure: z.boolean().default(false),
  username: z.string().min(1).max(255),
});
export type SmtpConfig = z.infer<typeof SmtpConfig>;

const commonCreateFields = {
  name: z.string().min(1).max(120),
  fromAddress: Email,
  priority: z.number().int().min(0).max(1000).default(100),
  enabled: z.boolean().default(true),
};

/** `POST /api/v1/settings/email-providers`. `secret` is write-only (the SMTP password). */
export const CreateEmailProviderRequest = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cloudflare_binding"), ...commonCreateFields }),
  z.object({ kind: z.literal("log"), ...commonCreateFields }),
  z.object({
    kind: z.literal("smtp"),
    ...commonCreateFields,
    config: SmtpConfig,
    secret: z.string().min(1).max(1000),
  }),
]);
export type CreateEmailProviderRequest = z.infer<typeof CreateEmailProviderRequest>;

/**
 * `PATCH /api/v1/settings/email-providers/:id`. Every field optional; omitting `secret` keeps the
 * existing one, an empty string is rejected (use `enabled: false` to stop using a provider).
 */
export const UpdateEmailProviderRequest = z.object({
  name: z.string().min(1).max(120).optional(),
  fromAddress: Email.optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  enabled: z.boolean().optional(),
  config: SmtpConfig.partial().optional(),
  secret: z.string().min(1).max(1000).optional(),
});
export type UpdateEmailProviderRequest = z.infer<typeof UpdateEmailProviderRequest>;

/** GET response shape: the secret is never echoed, only whether one is set. */
export const EmailProvider = z.object({
  id: prefixedId("emailProvider"),
  name: z.string(),
  kind: EmailProviderKind,
  priority: z.number(),
  enabled: z.boolean(),
  fromAddress: z.string(),
  config: z.record(z.string(), z.unknown()),
  hasSecret: z.boolean(),
  updatedBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type EmailProvider = z.infer<typeof EmailProvider>;

/** `POST /api/v1/settings/email-providers/:id/test`. */
export const TestEmailProviderResponse = z.object({
  ok: z.boolean(),
  messageId: z.string().optional(),
  errorCode: z.string().optional(),
});
export type TestEmailProviderResponse = z.infer<typeof TestEmailProviderResponse>;
