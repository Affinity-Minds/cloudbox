// Server signing key material. Generated once by the owner (docs/runbooks/licensing-key-rotation.md);
// the private JWK becomes the `ENTITLEMENT_SIGNING_JWK` secret, the public JWK a `signing_keys` row.
import { calculateJwkThumbprint, exportJWK, generateKeyPair, type JWK } from "jose";
import { ENTITLEMENT_FORMAT, EntitlementError } from "./entitlement.ts";

export type SigningJwk = JWK & { kid: string; alg: "ES256"; use: "sig" };

export type ServerSigningKey = {
  /** RFC 7638 SHA-256 thumbprint of the public key: deterministic, collision-free, rotation-safe. */
  kid: string;
  privateJwk: SigningJwk;
  publicJwk: SigningJwk;
};

/** A fresh P-256 keypair as JWKs sharing one `kid`. */
export async function generateServerSigningKey(): Promise<ServerSigningKey> {
  const { privateKey, publicKey } = await generateKeyPair(ENTITLEMENT_FORMAT.signingAlg, {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);
  const kid = await calculateJwkThumbprint(publicJwk, "sha256");
  const meta = { kid, alg: ENTITLEMENT_FORMAT.signingAlg, use: "sig" } as const;
  return {
    kid,
    privateJwk: { ...privateJwk, ...meta },
    publicJwk: { ...publicJwk, ...meta },
  };
}

/**
 * Parses the `ENTITLEMENT_SIGNING_JWK` secret and derives its public half. Throws `invalid_input`
 * for anything that is not an EC P-256 private JWK with a `kid`.
 */
export function parseSigningSecret(secret: string | undefined): ServerSigningKey {
  if (!secret) throw new EntitlementError("invalid_input", "ENTITLEMENT_SIGNING_JWK is not set");
  let jwk: JWK;
  try {
    jwk = JSON.parse(secret) as JWK;
  } catch (cause) {
    throw new EntitlementError("invalid_input", "ENTITLEMENT_SIGNING_JWK is not JSON", { cause });
  }
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.d || !jwk.x || !jwk.y) {
    throw new EntitlementError("invalid_input", "ENTITLEMENT_SIGNING_JWK is not a P-256 private JWK");
  }
  if (typeof jwk.kid !== "string" || jwk.kid.length === 0) {
    throw new EntitlementError("invalid_input", "ENTITLEMENT_SIGNING_JWK has no kid");
  }
  if (jwk.alg !== undefined && jwk.alg !== ENTITLEMENT_FORMAT.signingAlg) {
    throw new EntitlementError("unsupported_algorithm", "ENTITLEMENT_SIGNING_JWK alg is not ES256");
  }
  const meta = { kid: jwk.kid, alg: ENTITLEMENT_FORMAT.signingAlg, use: "sig" } as const;
  return {
    kid: jwk.kid,
    privateJwk: { ...jwk, ...meta },
    publicJwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ...meta },
  };
}
