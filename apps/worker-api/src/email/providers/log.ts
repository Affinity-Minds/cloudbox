// Owner: WT-12. Development-only provider: writes the message to `console` instead of sending
// it. The API refuses to create or enable a `log` provider when `ENVIRONMENT === "production"`;
// this file has no env access, so that guard lives in the route (routes/v1/email-providers.ts).
import type { EmailMessage, EmailProvider, SendResult } from "./types";

export function createLogProvider(): EmailProvider {
  return {
    kind: "log",
    async send(message: EmailMessage): Promise<SendResult> {
      const messageId = crypto.randomUUID();
      console.log(
        "[email:log]",
        JSON.stringify({ to: message.to, subject: message.subject, messageId }),
      );
      return { messageId };
    },
  };
}
