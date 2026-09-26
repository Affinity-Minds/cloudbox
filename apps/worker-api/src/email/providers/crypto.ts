// Owner: WT-12. AES-256-GCM envelope for `email_providers.secret_ciphertext`, resolved store-first
// from a single Wrangler secret (agent-notes cloudflare-workers "Provider credentials need not be
// Wrangler secrets"). A random 12-byte IV per value; the API never echoes plaintext back (see
// routes/v1/email-providers.ts masking).
export class ProviderSecretsKeyMissingError extends Error {
  constructor() {
    super("PROVIDER_SECRETS_KEY is not set");
  }
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function importKey(base64Key: string): Promise<CryptoKey> {
  const raw = decodeBase64(base64Key);
  if (raw.byteLength !== 32) {
    throw new Error("PROVIDER_SECRETS_KEY must decode to exactly 32 bytes");
  }
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export type EncryptedSecret = { ciphertext: string; iv: string };

/** Encrypts `plaintext`. Throws `ProviderSecretsKeyMissingError` when `base64Key` is undefined. */
export async function encryptSecret(
  plaintext: string,
  base64Key: string | undefined,
): Promise<EncryptedSecret> {
  if (!base64Key) throw new ProviderSecretsKeyMissingError();
  const key = await importKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const buffer = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return { ciphertext: encodeBase64(new Uint8Array(buffer)), iv: encodeBase64(iv) };
}

/** Decrypts a value previously produced by `encryptSecret`. */
export async function decryptSecret(
  encrypted: EncryptedSecret,
  base64Key: string | undefined,
): Promise<string> {
  if (!base64Key) throw new ProviderSecretsKeyMissingError();
  const key = await importKey(base64Key);
  const iv = decodeBase64(encrypted.iv);
  const ciphertext = decodeBase64(encrypted.ciphertext);
  const buffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(buffer);
}
