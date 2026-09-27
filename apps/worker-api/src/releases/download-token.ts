// Owner: WT-18. Short-lived, HMAC-signed download URLs for a release package, proxied through this
// Worker. Genuine R2 presigned URLs need the S3-compatible API with access-key credentials, which
// are not provisioned for this slice (only the `ARTIFACTS` binding — see handoff "Requests to
// another worktree"); this gets the same practical property — a URL that stops working on its own
// after a short window — without a new binding or secret: the HMAC key is derived from the private
// scalar of the already-provisioned `RELEASE_SIGNING_JWK`. The download route also re-checks the
// caller's device Bearer token, so this is defence in depth, not the only gate.
import { parseReleaseSigningSecret } from "@cloudbox/update-contracts";
import type { Bindings } from "../env";

const TTL_SECONDS = 15 * 60;

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  // `Uint8Array.from(binary, mapFn)` types looser (`Uint8Array<ArrayBufferLike>`) than the
  // constructor form below, which `SubtleCrypto.importKey`'s `BufferSource` parameter needs.
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function timingSafeEqual(a: Uint8Array<ArrayBuffer>, b: Uint8Array<ArrayBuffer>): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

async function hmacKey(env: Bindings): Promise<CryptoKey> {
  const secret = parseReleaseSigningSecret(env.RELEASE_SIGNING_JWK);
  const material = base64UrlDecode(secret.privateJwk.d as string);
  return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export type DownloadToken = { token: string; exp: number };

export async function signDownloadToken(
  env: Bindings,
  input: { releaseId: string; deviceId: string },
): Promise<DownloadToken> {
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const key = await hmacKey(env);
  const message = `${input.releaseId}:${input.deviceId}:${exp}`;
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return { token: toHex(signature), exp };
}

export async function verifyDownloadToken(
  env: Bindings,
  input: { releaseId: string; deviceId: string; exp: number; token: string },
): Promise<boolean> {
  if (!Number.isFinite(input.exp) || input.exp < Math.floor(Date.now() / 1000)) return false;
  if (!/^[0-9a-f]{64}$/.test(input.token)) return false;
  const key = await hmacKey(env);
  const message = `${input.releaseId}:${input.deviceId}:${input.exp}`;
  const expected = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return timingSafeEqual(new Uint8Array(expected), fromHex(input.token));
}
