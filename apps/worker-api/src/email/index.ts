// Owner: WT-1. Sends through the Cloudflare Email Service `send_email` binding `EMAIL`.
import type { Bindings } from "../env";

export type OtpEmail = { to: string; code: string };

export async function sendOtpEmail(_env: Bindings, _message: OtpEmail): Promise<void> {
  throw new Error("not_implemented: sendOtpEmail is implemented by WT-1");
}
