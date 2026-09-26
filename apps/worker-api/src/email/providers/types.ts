// Owner: WT-12. The provider abstraction every implementation in this directory satisfies.
// `send()` never receives a secret directly — implementations that need one (smtp) take it
// through their constructor args, resolved by the caller from the encrypted store.
import type { EmailProviderKind } from "@cloudbox/contracts";

export type EmailMessage = {
  to: string;
  from?: string;
  subject: string;
  text: string;
  html?: string;
};

export type SendResult = { messageId: string };

/** Thrown by every provider on failure. `code` is machine-readable, audited, never a secret. */
export class EmailProviderError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "EmailProviderError";
    this.code = code;
  }
}

export type EmailProvider = {
  readonly kind: EmailProviderKind;
  send(message: EmailMessage): Promise<SendResult>;
};
