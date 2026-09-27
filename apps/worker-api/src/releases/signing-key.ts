// Owner: WT-18. The server release-manifest signing key: private half from the `RELEASE_SIGNING_JWK`
// secret (agent-notes cloudflare-workers #20: declared by name, never read from the database),
// public half recorded in `signing_keys` (purpose='release') so devices and auditors can pin it by
// `kid`. Deliberately its own key, never `ENTITLEMENT_SIGNING_JWK` (docs/handoffs/wt-p3-entitlement.md
// — a release manifest and a device entitlement are different trust domains).
import { parseReleaseSigningSecret, type ReleaseSigningKey } from "@cloudbox/update-contracts";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { signingKeys } from "../db/schema";
import type { Bindings } from "../env";

export type ReleaseSigningKeyProblem =
  | "signing_key_unavailable"
  | "signing_key_retired"
  | "signing_key_mismatch";

export class ReleaseSigningKeyError extends Error {
  override readonly name = "ReleaseSigningKeyError";
  constructor(
    readonly code: ReleaseSigningKeyProblem,
    message: string,
  ) {
    super(message);
  }
}

/** True when the secret parses; says nothing about `signing_keys`. For UI hints only. */
export function releaseSigningKeyConfigured(env: Bindings): boolean {
  try {
    parseReleaseSigningSecret(env.RELEASE_SIGNING_JWK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Idempotent: inserts the public half (purpose='release') if its `kid` is new (safe under
 * concurrent isolates: the primary key decides, not a flag), then refuses a kid that was retired,
 * belongs to the other signer, or whose stored public key differs from the secret. One D1 round trip.
 */
export async function ensureReleaseSigningKey(env: Bindings, db: Db): Promise<ReleaseSigningKey> {
  let key: ReleaseSigningKey;
  try {
    key = parseReleaseSigningSecret(env.RELEASE_SIGNING_JWK);
  } catch (error) {
    throw new ReleaseSigningKeyError(
      "signing_key_unavailable",
      error instanceof Error ? error.message : "RELEASE_SIGNING_JWK unusable",
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
        purpose: "release",
      })
      .onConflictDoNothing({ target: signingKeys.kid }),
    db
      .select({
        status: signingKeys.status,
        publicJwk: signingKeys.publicJwk,
        purpose: signingKeys.purpose,
      })
      .from(signingKeys)
      .where(eq(signingKeys.kid, key.kid)),
  ]);

  const row = rows[0];
  if (!row) throw new ReleaseSigningKeyError("signing_key_unavailable", "signing key row missing");
  if (row.purpose !== "release") {
    throw new ReleaseSigningKeyError(
      "signing_key_mismatch",
      `kid ${key.kid} belongs to another signer`,
    );
  }
  if (row.status !== "active") {
    throw new ReleaseSigningKeyError("signing_key_retired", `signing key ${key.kid} is retired`);
  }
  const stored = JSON.parse(row.publicJwk) as { x?: string; y?: string };
  if (stored.x !== key.publicJwk.x || stored.y !== key.publicJwk.y) {
    throw new ReleaseSigningKeyError(
      "signing_key_mismatch",
      `kid ${key.kid} is bound to another key`,
    );
  }
  return key;
}

/** Every active release signing public key, for the manifest verifier's pinned set. */
export async function activeReleaseSigningJwks(db: Db) {
  const rows = await db
    .select({ kid: signingKeys.kid, publicJwk: signingKeys.publicJwk })
    .from(signingKeys)
    .where(and(eq(signingKeys.purpose, "release"), eq(signingKeys.status, "active")));
  return rows.map((row) => JSON.parse(row.publicJwk) as Record<string, unknown>);
}
