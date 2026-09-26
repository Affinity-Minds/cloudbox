// Owner: WT-5. The server signing key: private half from the `ENTITLEMENT_SIGNING_JWK` secret
// (agent-notes cloudflare-workers #20: declared by name, never read from the database), public half
// recorded in `signing_keys` on first use so devices and auditors can pin it by `kid`.
import { parseSigningSecret, type ServerSigningKey } from "@cloudbox/licensing-contracts";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { signingKeys } from "../db/schema";
import type { Bindings } from "../env";

export type SigningKeyProblem =
  | "signing_key_unavailable"
  | "signing_key_retired"
  | "signing_key_mismatch";

export class SigningKeyError extends Error {
  override readonly name = "SigningKeyError";
  constructor(
    readonly code: SigningKeyProblem,
    message: string,
  ) {
    super(message);
  }
}

/** True when the secret parses; says nothing about `signing_keys`. For UI hints only. */
export function signingKeyConfigured(env: Bindings): boolean {
  try {
    parseSigningSecret(env.ENTITLEMENT_SIGNING_JWK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Idempotent: inserts the public half if its `kid` is new (safe under concurrent isolates: the
 * primary key decides, not a flag), then refuses a kid that was retired or whose stored public key
 * differs from the secret. One D1 round trip.
 */
export async function ensureSigningKey(env: Bindings, db: Db): Promise<ServerSigningKey> {
  let key: ServerSigningKey;
  try {
    key = parseSigningSecret(env.ENTITLEMENT_SIGNING_JWK);
  } catch (error) {
    throw new SigningKeyError(
      "signing_key_unavailable",
      error instanceof Error ? error.message : "ENTITLEMENT_SIGNING_JWK unusable",
    );
  }

  const [, rows] = await db.batch([
    db
      .insert(signingKeys)
      .values({
        kid: key.kid,
        alg: "ES256",
        publicJwk: JSON.stringify(key.publicJwk),
        status: "active",
      })
      .onConflictDoNothing({ target: signingKeys.kid }),
    db
      .select({ status: signingKeys.status, publicJwk: signingKeys.publicJwk })
      .from(signingKeys)
      .where(eq(signingKeys.kid, key.kid)),
  ]);

  const row = rows[0];
  if (!row) throw new SigningKeyError("signing_key_unavailable", "signing key row missing");
  if (row.status !== "active") {
    throw new SigningKeyError("signing_key_retired", `signing key ${key.kid} is retired`);
  }
  const stored = JSON.parse(row.publicJwk) as { x?: string; y?: string };
  if (stored.x !== key.publicJwk.x || stored.y !== key.publicJwk.y) {
    throw new SigningKeyError("signing_key_mismatch", `kid ${key.kid} is bound to another key`);
  }
  return key;
}
