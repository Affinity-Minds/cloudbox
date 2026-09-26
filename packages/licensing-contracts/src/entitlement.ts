// CloudBox entitlement envelope (ADR 0004, docs/slices/3.2-entitlement-format.md).
//
//   claims ──SignJWT ES256 {alg, kid, typ:"cbx-entitlement+jwt"}──▶ compact JWS
//          ──CompactEncrypt {alg:"RSA-OAEP-256", enc:"A256GCM", cty:"JWT", kid}──▶ compact JWE
//
// Everything here is `jose`; nothing below is hand-rolled cryptography. The verifier is the reference
// behaviour the Windows agent (WT-4 / WT-10) reproduces with Microsoft.IdentityModel.Tokens.
import {
  CompactEncrypt,
  type CryptoKey,
  calculateJwkThumbprint,
  compactDecrypt,
  decodeProtectedHeader,
  importJWK,
  type JWK,
  type JWTPayload,
  jwtVerify,
  SignJWT,
} from "jose";

export const ENTITLEMENT_FORMAT = {
  issuer: "cloudbox",
  typ: "cbx-entitlement+jwt",
  signingAlg: "ES256",
  keyManagementAlg: "RSA-OAEP-256",
  contentEncryption: "A256GCM",
  cty: "JWT",
} as const;

export type Feature = "remote_access" | "managed_backup" | "fleet";

/**
 * Signed claims (master spec §9.3 plus `iss`, `iat`, `jti`, `kid`). Snake_case on the wire because
 * the Windows agent reads them verbatim. `@cloudbox/contracts` `EntitlementClaims` is the Zod
 * mirror used to validate before signing. Deliberately no `exp`/`nbf`: validity and offline grace are
 * evaluated by the agent against its trusted clock (spec §10, §11), not by a JWT library default.
 */
export type EntitlementClaims = {
  iss: typeof ENTITLEMENT_FORMAT.issuer;
  /** Same value as the JWS header `kid`; checked equal on verify. */
  kid: string;
  /** Equals `license_id`. */
  jti: string;
  /** Seconds since the epoch. */
  iat: number;
  license_id: string;
  tenant_id: string;
  device_id: string;
  /** RFC 7638 SHA-256 JWK thumbprint (base64url) of the device public key. */
  device_key_thumbprint: string;
  max_managed_users: number;
  valid_from: string;
  valid_until: string;
  renewal_warning_days: number;
  offline_grace_days: number;
  generation: number;
  features: Feature[];
};

export type EntitlementErrorCode =
  | "invalid_input"
  | "malformed"
  | "unsupported_algorithm"
  | "unknown_kid"
  | "decryption_failed"
  | "signature_invalid"
  | "claims_invalid"
  | "device_mismatch";

/** Every rejection on the issue/verify path. Callers branch on `code`, never on `message`. */
export class EntitlementError extends Error {
  override readonly name = "EntitlementError";
  readonly code: EntitlementErrorCode;
  // No parameter properties: this file also runs under Node's type stripping (scripts/).
  constructor(code: EntitlementErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

type KeyJwk = JWK & { kid?: string };

function assertEcSigningKey(jwk: KeyJwk, needPrivate: boolean) {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || (needPrivate && !jwk.d)) {
    throw new EntitlementError(
      "invalid_input",
      `server signing key must be an EC P-256 ${needPrivate ? "private" : "public"} JWK`,
    );
  }
  if (jwk.alg !== undefined && jwk.alg !== ENTITLEMENT_FORMAT.signingAlg) {
    throw new EntitlementError("unsupported_algorithm", `signing key alg ${jwk.alg} is not ES256`);
  }
}

function assertRsaKey(jwk: KeyJwk, needPrivate: boolean) {
  if (jwk.kty !== "RSA" || (needPrivate && !jwk.d)) {
    throw new EntitlementError(
      "invalid_input",
      `device key must be an RSA ${needPrivate ? "private" : "public"} JWK`,
    );
  }
}

export type IssueEntitlementInput = {
  claims: EntitlementClaims;
  /** Parsed `ENTITLEMENT_SIGNING_JWK` (EC P-256 private JWK). */
  serverPrivateJwk: JWK;
  /** Signing key id; must equal `claims.kid`. */
  kid: string;
  /** The device's enrolled RSA public key (`devices.device_public_key_jwk`). */
  devicePublicJwk: JWK;
};

/** Signs the claims (ES256) and encrypts the resulting JWS to the device key. Returns a compact JWE. */
export async function issueEntitlement({
  claims,
  serverPrivateJwk,
  kid,
  devicePublicJwk,
}: IssueEntitlementInput): Promise<string> {
  if (!kid) throw new EntitlementError("invalid_input", "kid is required");
  if (claims.kid !== kid) throw new EntitlementError("invalid_input", "claims.kid must equal kid");
  if (claims.iss !== ENTITLEMENT_FORMAT.issuer) {
    throw new EntitlementError("invalid_input", "claims.iss must be cloudbox");
  }
  if (claims.jti !== claims.license_id) {
    throw new EntitlementError("invalid_input", "claims.jti must equal claims.license_id");
  }
  assertEcSigningKey(serverPrivateJwk, true);
  assertRsaKey(devicePublicJwk, false);

  let signingKey: CryptoKey | Uint8Array;
  let deviceKey: CryptoKey | Uint8Array;
  try {
    signingKey = await importJWK(serverPrivateJwk, ENTITLEMENT_FORMAT.signingAlg);
    // Only the public members: a stray `d` must never turn this into a private-key import.
    deviceKey = await importJWK(
      { kty: "RSA", n: devicePublicJwk.n, e: devicePublicJwk.e },
      ENTITLEMENT_FORMAT.keyManagementAlg,
    );
  } catch (cause) {
    throw new EntitlementError("invalid_input", "could not import a key", { cause });
  }

  const jws = await new SignJWT(claims as unknown as JWTPayload)
    .setProtectedHeader({
      alg: ENTITLEMENT_FORMAT.signingAlg,
      kid,
      typ: ENTITLEMENT_FORMAT.typ,
    })
    .sign(signingKey);

  return new CompactEncrypt(new TextEncoder().encode(jws))
    .setProtectedHeader({
      alg: ENTITLEMENT_FORMAT.keyManagementAlg,
      enc: ENTITLEMENT_FORMAT.contentEncryption,
      cty: ENTITLEMENT_FORMAT.cty,
      kid,
    })
    .encrypt(deviceKey);
}

export type VerifyEntitlementInput = {
  token: string;
  /** The device's RSA private key (on Windows: the TPM/CNG key). */
  devicePrivateJwk: JWK;
  /**
   * Pinned server signing keys (public JWKs, each with `kid`). Only these kids are trusted; a kid that
   * is not listed (never seen, or removed after rotation) is rejected as `unknown_kid`.
   */
  serverPublicJwks: readonly JWK[];
};

export type VerifiedEntitlement = {
  claims: EntitlementClaims;
  kid: string;
};

const REQUIRED_CLAIMS = [
  "kid",
  "jti",
  "iat",
  "license_id",
  "tenant_id",
  "device_id",
  "device_key_thumbprint",
  "max_managed_users",
  "valid_from",
  "valid_until",
  "renewal_warning_days",
  "offline_grace_days",
  "generation",
  "features",
] as const;

function header(token: string, what: string) {
  try {
    return decodeProtectedHeader(token);
  } catch (cause) {
    throw new EntitlementError("malformed", `${what} protected header is not decodable`, { cause });
  }
}

/**
 * Reference verifier. Decrypts with the device key, verifies ES256 against the pinned kid, then
 * checks the claims belong to this device. Anything unexpected is an `EntitlementError`; there is no
 * lenient path. Validity dates and grace are left to the caller's trusted clock.
 */
export async function verifyEntitlement({
  token,
  devicePrivateJwk,
  serverPublicJwks,
}: VerifyEntitlementInput): Promise<VerifiedEntitlement> {
  if (typeof token !== "string" || token.split(".").length !== 5) {
    throw new EntitlementError("malformed", "entitlement is not a compact JWE");
  }
  assertRsaKey(devicePrivateJwk, true);

  // 1. Outer JWE: exactly RSA-OAEP-256 / A256GCM / cty JWT, no compression.
  const jweHeader = header(token, "JWE");
  if (
    jweHeader.alg !== ENTITLEMENT_FORMAT.keyManagementAlg ||
    jweHeader.enc !== ENTITLEMENT_FORMAT.contentEncryption ||
    jweHeader.zip !== undefined
  ) {
    throw new EntitlementError(
      "unsupported_algorithm",
      `JWE alg/enc ${String(jweHeader.alg)}/${String(jweHeader.enc)} is not RSA-OAEP-256/A256GCM`,
    );
  }
  if (jweHeader.cty?.toUpperCase() !== ENTITLEMENT_FORMAT.cty) {
    throw new EntitlementError("malformed", "JWE cty must be JWT (nested JWS)");
  }

  let deviceKey: CryptoKey | Uint8Array;
  try {
    const { kty, n, e, d, p, q, dp, dq, qi } = devicePrivateJwk;
    deviceKey = await importJWK(
      { kty, n, e, d, p, q, dp, dq, qi },
      ENTITLEMENT_FORMAT.keyManagementAlg,
    );
  } catch (cause) {
    throw new EntitlementError("invalid_input", "could not import the device private key", {
      cause,
    });
  }

  let jws: string;
  try {
    const { plaintext } = await compactDecrypt(token, deviceKey, {
      keyManagementAlgorithms: [ENTITLEMENT_FORMAT.keyManagementAlg],
      contentEncryptionAlgorithms: [ENTITLEMENT_FORMAT.contentEncryption],
    });
    jws = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch (cause) {
    throw new EntitlementError("decryption_failed", "entitlement could not be decrypted", {
      cause,
    });
  }

  // 2. Inner JWS: exactly ES256, our typ, and a kid from the pinned set.
  const jwsHeader = header(jws, "JWS");
  if (jwsHeader.alg !== ENTITLEMENT_FORMAT.signingAlg) {
    throw new EntitlementError(
      "unsupported_algorithm",
      `JWS alg ${String(jwsHeader.alg)} is not ES256`,
    );
  }
  const kid = jwsHeader.kid;
  if (typeof kid !== "string" || kid.length === 0) {
    throw new EntitlementError("unknown_kid", "JWS has no kid");
  }
  if (jweHeader.kid !== kid) {
    throw new EntitlementError("unknown_kid", "JWE kid does not match JWS kid");
  }
  const pinned = serverPublicJwks.find((jwk) => jwk.kid === kid);
  if (!pinned) throw new EntitlementError("unknown_kid", `signing key ${kid} is not trusted`);
  assertEcSigningKey(pinned, false);

  let serverKey: CryptoKey | Uint8Array;
  try {
    serverKey = await importJWK(
      { kty: "EC", crv: pinned.crv, x: pinned.x, y: pinned.y },
      ENTITLEMENT_FORMAT.signingAlg,
    );
  } catch (cause) {
    throw new EntitlementError("invalid_input", `could not import signing key ${kid}`, { cause });
  }

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(jws, serverKey, {
      algorithms: [ENTITLEMENT_FORMAT.signingAlg],
      issuer: ENTITLEMENT_FORMAT.issuer,
      typ: ENTITLEMENT_FORMAT.typ,
      requiredClaims: [...REQUIRED_CLAIMS],
    }));
  } catch (cause) {
    const code = (cause as { code?: string }).code;
    throw new EntitlementError(
      code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" || code === "ERR_JWS_INVALID"
        ? "signature_invalid"
        : "claims_invalid",
      "entitlement signature or claims rejected",
      { cause },
    );
  }

  // 3. Claims belong to this signing key and to this device.
  const claims = payload as unknown as EntitlementClaims;
  if (claims.kid !== kid) throw new EntitlementError("claims_invalid", "claims.kid != header kid");
  if (claims.jti !== claims.license_id) {
    throw new EntitlementError("claims_invalid", "claims.jti != claims.license_id");
  }
  if (!Number.isInteger(claims.generation) || claims.generation < 1) {
    throw new EntitlementError("claims_invalid", "generation must be a positive integer");
  }
  const thumbprint = await calculateJwkThumbprint(
    { kty: "RSA", n: devicePrivateJwk.n, e: devicePrivateJwk.e },
    "sha256",
  );
  if (claims.device_key_thumbprint !== thumbprint) {
    throw new EntitlementError("device_mismatch", "entitlement was issued to a different device key");
  }

  return { claims, kid };
}
