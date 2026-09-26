// Owner: WT-12. SMTP over `cloudflare:sockets` via `worker-mailer` 1.2.x (STARTTLS/TLS + auth);
// no custom MIME building. `worker-mailer`'s `send()` resolves `void` and mints its own
// `Message-ID` header, so this provider assigns its own opaque id for the audit trail.
//
// `mailer` is injectable (defaults to the real `WorkerMailer.send`) so tests can pass a fake and
// never open a socket — the Workers test pool runs real workerd, where module-level `vi.mock` of
// an npm package is not reliable, so dependency injection is the portable seam.
import { WorkerMailer } from "worker-mailer";
import {
  type EmailMessage,
  type EmailProvider,
  EmailProviderError,
  type SendResult,
} from "./types";

export type SmtpProviderConfig = {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  from: string;
};

export type WorkerMailerSend = typeof WorkerMailer.send;

export function createSmtpProvider(
  config: SmtpProviderConfig,
  mailerSend: WorkerMailerSend = WorkerMailer.send,
): EmailProvider {
  return {
    kind: "smtp",
    async send(message: EmailMessage): Promise<SendResult> {
      try {
        await mailerSend(
          {
            host: config.host,
            port: config.port,
            secure: config.secure,
            startTls: !config.secure,
            credentials: { username: config.username, password: config.password },
            authType: ["plain", "login", "cram-md5"],
          },
          {
            from: message.from ?? config.from,
            to: message.to,
            subject: message.subject,
            text: message.text,
            html: message.html,
          },
        );
        return { messageId: crypto.randomUUID() };
      } catch (error) {
        throw new EmailProviderError(
          "E_SMTP_SEND_FAILED",
          error instanceof Error ? error.message : "smtp send failed",
        );
      }
    },
  };
}
