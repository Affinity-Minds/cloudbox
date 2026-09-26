// Owner: WT-3. Small crypto/hash helpers shared by enrollment tokens, device credentials and
// error classification. No custom cryptography: SHA-256 and random bytes come from WebCrypto.

/**
 * Crockford base32: 32 symbols (0-9 and A-Z minus I, L, O, U) so a byte's low 5 bits map onto the
 * alphabet with zero modulo bias — human-typed codes without visually ambiguous characters.
 */
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function randomCrockfordBase32(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const byte of bytes) out += CROCKFORD_ALPHABET[byte & 0x1f];
  return out;
}

/** Opaque bearer credential (device tokens): hex-encoded random bytes, never a signed format. */
export function randomOpaqueToken(byteLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * D1 wraps driver errors; the `UNIQUE constraint failed: …` text is not on `error.message`, it is
 * further down the `cause` chain (agent-notes cloudflare-workers #7). Walk the chain to classify.
 */
export function describeError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  while (current instanceof Error) {
    parts.push(current.message);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(" | ");
}

export function isUniqueConstraintError(err: unknown, indexOrColumn?: string): boolean {
  const description = describeError(err);
  if (!/UNIQUE constraint failed/i.test(description)) return false;
  return indexOrColumn ? description.includes(indexOrColumn) : true;
}
