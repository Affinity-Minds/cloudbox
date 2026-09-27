// Server signing key material for OTA release manifests. Generated once by the owner
// (docs/runbooks/release-key-rotation.md); the private JWK becomes the `RELEASE_SIGNING_JWK`
// secret, the public JWK a `signing_keys` row with `purpose='release'`. Deliberately its own key,
// separate from `ENTITLEMENT_SIGNING_JWK` (docs/handoffs/wt-p3-entitlement.md): a release manifest
// and a device entitlement are different trust domains and must not share a signer.
import { calculateJwkThumbprint, exportJWK, generateKeyPair, type JWK } from "jose";
import { MANIFEST_FORMAT, ReleaseManifestError } from "./manifest.ts";

export type ReleaseSigningJwk = JWK & { kid: string; alg: "ES256"; use: "sig" };

export type ReleaseSigningKey = {
  /** RFC 7638 SHA-256 thumbprint of the public key: deterministic, collision-free, rotation-safe. */
  kid: string;
  privateJwk: ReleaseSigningJwk;
  publicJwk: ReleaseSigningJwk;
};

/** A fresh P-256 keypair as JWKs sharing one `kid`. */
export async function generateReleaseSigningKey(): Promise<ReleaseSigningKey> {
  const { privateKey, publicKey } = await generateKeyPair(MANIFEST_FORMAT.signingAlg, {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);
  const kid = await calculateJwkThumbprint(publicJwk, "sha256");
  const meta = { kid, alg: MANIFEST_FORMAT.signingAlg, use: "sig" } as const;
  return {
    kid,
    privateJwk: { ...privateJwk, ...meta },
    publicJwk: { ...publicJwk, ...meta },
  };
}

/**
 * Parses the `RELEASE_SIGNING_JWK` secret and derives its public half. Throws `invalid_input` for
 * anything that is not an EC P-256 private JWK with a `kid`.
 */
export function parseReleaseSigningSecret(secret: string | undefined): ReleaseSigningKey {
  if (!secret) throw new ReleaseManifestError("invalid_input", "RELEASE_SIGNING_JWK is not set");
  let jwk: JWK;
  try {
    jwk = JSON.parse(secret) as JWK;
  } catch (cause) {
    throw new ReleaseManifestError("invalid_input", "RELEASE_SIGNING_JWK is not JSON", { cause });
  }
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.d || !jwk.x || !jwk.y) {
    throw new ReleaseManifestError(
      "invalid_input",
      "RELEASE_SIGNING_JWK is not a P-256 private JWK",
    );
  }
  if (typeof jwk.kid !== "string" || jwk.kid.length === 0) {
    throw new ReleaseManifestError("invalid_input", "RELEASE_SIGNING_JWK has no kid");
  }
  if (jwk.alg !== undefined && jwk.alg !== MANIFEST_FORMAT.signingAlg) {
    throw new ReleaseManifestError("unsupported_algorithm", "RELEASE_SIGNING_JWK alg is not ES256");
  }
  const meta = { kid: jwk.kid, alg: MANIFEST_FORMAT.signingAlg, use: "sig" } as const;
  return {
    kid: jwk.kid,
    privateJwk: { ...jwk, ...meta },
    publicJwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ...meta },
  };
}
