// Owner: WT-12. Wraps the Cloudflare Email Service `send_email` binding (`env.EMAIL`), the same
// call WT-1's `sendOtpEmail` made directly before this registry existed.
import type { Bindings } from "../../env";
import {
  type EmailMessage,
  type EmailProvider,
  EmailProviderError,
  type SendResult,
} from "./types";

export function createCloudflareBindingProvider(env: Bindings): EmailProvider {
  return {
    kind: "cloudflare_binding",
    async send(message: EmailMessage): Promise<SendResult> {
      if (!env.EMAIL || !env.EMAIL_FROM) {
        throw new EmailProviderError(
          "E_NO_EMAIL_BINDING",
          "EMAIL binding or EMAIL_FROM is not configured",
        );
      }
      try {
        const result = await env.EMAIL.send({
          to: message.to,
          from: message.from ?? env.EMAIL_FROM,
          subject: message.subject,
          text: message.text,
          html: message.html,
        });
        return { messageId: result.messageId };
      } catch (error) {
        const code = (error as { code?: unknown })?.code;
        throw new EmailProviderError(typeof code === "string" ? code : "E_SEND_FAILED");
      }
    },
  };
}
