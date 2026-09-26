// Owner: WT-1. Sends through the configured email provider registry (WT-12, `../email/send.ts`),
// which falls back to the Cloudflare Email Service `send_email` binding `EMAIL` when no providers
// are configured, preserving this file's original behaviour.
// Better Auth answers the OTP request with 200 whatever happens here (anti-enumeration), so the
// outcome is recorded in audit_log as AUTH_OTP_SENT; a broken mailer must not look healthy.
import type { EmailProviderKind } from "@cloudbox/contracts";
import { audit } from "../audit";
import { createDb } from "../db/client";
import type { Bindings } from "../env";
import { sendEmail } from "./send";

export type OtpEmail = { to: string; code: string };

export const OTP_EMAIL_SUBJECT = "Your CloudBox sign-in code";

export function otpEmailBody(code: string): { text: string; html: string } {
  const text = [
    `Your CloudBox sign-in code is ${code}`,
    "",
    "It expires in 5 minutes and works once.",
    "If you did not request this code, ignore this email.",
  ].join("\n");
  const html = [
    `<p>Your CloudBox sign-in code is <strong style="font-size:20px;letter-spacing:2px">${code}</strong></p>`,
    "<p>It expires in 5 minutes and works once.</p>",
    "<p>If you did not request this code, ignore this email.</p>",
  ].join("");
  return { text, html };
}

type SendOutcome = {
  /** Same field as the `unknown_email` record written by the sign-in hook (src/auth/index.ts). */
  outcome: "sent" | "send_failed";
  messageId?: string;
  errorCode?: string;
  echoed?: true;
  /** Which registered provider (or the `EMAIL` binding fallback) handled this send (WT-12). */
  providerId: string;
  kind: EmailProviderKind;
};

/** Sends the code; never throws, so a send failure cannot change the HTTP response. */
export async function sendOtpEmail(
  env: Bindings,
  message: OtpEmail,
  context: { correlationId?: string | null; client?: string } = {},
): Promise<SendOutcome> {
  const to = message.to.toLowerCase();
  const sent = await sendEmail(
    env,
    { to, subject: OTP_EMAIL_SUBJECT, ...otpEmailBody(message.code) },
    { purpose: "otp", correlationId: context.correlationId },
  );
  let outcome: SendOutcome = sent.messageId
    ? { outcome: "sent", messageId: sent.messageId, providerId: sent.providerId, kind: sent.kind }
    : {
        outcome: "send_failed",
        errorCode: sent.errorCode,
        providerId: sent.providerId,
        kind: sent.kind,
      };

  // Local development only: `wrangler dev` without remote bindings, and tests.
  if (env.OTP_DEV_ECHO === "1" && env.ENVIRONMENT !== "production") {
    console.log("[otp-dev-echo]", to, message.code);
    outcome = { ...outcome, echoed: true };
  }

  try {
    await audit(createDb(env.DB), {
      eventType: "AUTH_OTP_SENT",
      entityType: "auth_email",
      entityId: to,
      actor: { type: "system", id: "email-otp" },
      before: null,
      // `client` (IP or IPv6 /64) keys the per-(email, client) send cap in src/auth/index.ts.
      after: context.client ? { ...outcome, client: context.client } : outcome,
      correlationId: context.correlationId ?? null,
      source: "api",
    });
  } catch (error) {
    console.error("otp send audit failed", error);
  }
  return outcome;
}
