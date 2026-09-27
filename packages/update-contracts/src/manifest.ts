// CloudBox OTA release manifest and its signed envelope (master spec §18, §45; Slices 10.1–10.2).
//
//   manifest ──SignJWT ES256 {alg, kid, typ:"cbx-release+jwt"}──▶ compact JWS
//
// The manifest is not confidential (unlike the entitlement, packages/licensing-contracts), so it is
// signed only, never encrypted: any device or operator can read it, but only a pinned CloudBox
// signing key could have produced it. Everything here is `jose`; nothing below is hand-rolled
// cryptography. The verifier is the reference behaviour the Windows updater (WT-4 / a later slice)
// reproduces with Microsoft.IdentityModel.Tokens.
import {
  type CryptoKey,
  decodeProtectedHeader,
  importJWK,
  type JWK,
  type JWTPayload,
  jwtVerify,
  SignJWT,
} from "jose";
import { z } from "zod";

export const MANIFEST_FORMAT = {
  issuer: "cloudbox",
  typ: "cbx-release+jwt",
  signingAlg: "ES256",
} as const;

export const ReleaseComponent = z.enum(["agent", "status", "setup", "connect"]);
export type ReleaseComponent = z.infer<typeof ReleaseComponent>;

export const ReleaseChannel = z.enum(["development", "pilot", "stable", "pinned"]);
export type ReleaseChannel = z.infer<typeof ReleaseChannel>;

/** SemVer 2.0.0 core + optional pre-release/build metadata, e.g. `1.4.2`, `1.4.2-rc.1`. */
export const SemVer = z
  .string()
  .regex(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    "must be a semantic version, e.g. 1.4.2",
  );
export type SemVer = z.infer<typeof SemVer>;

export const ReleasePackage = z.object({
  r2Key: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/, "sha256 must be 64 lowercase hex characters"),
  sizeBytes: z.number().int().positive(),
});
export type ReleasePackage = z.infer<typeof ReleasePackage>;

/**
 * Signed claims (spec §18.3: product, version, hash, minimum compatible Agent version, rollback
 * metadata). `component` doubles as "expected product": the verifier's caller compares it against
 * what it asked to update. Snake_case is not used here (unlike the entitlement) because nothing
 * outside this repo's own TypeScript/.NET verifier reads the manifest claims verbatim.
 */
export const ReleaseManifest = z.object({
  component: ReleaseComponent,
  version: SemVer,
  channel: ReleaseChannel,
  /** Oldest Agent version that can apply this release; null when no floor is required. */
  minAgentVersion: SemVer.nullable(),
  package: ReleasePackage,
  /** The version this release rolls back to, if it is a rollback release; null otherwise. */
  rollbackOf: SemVer.nullable(),
  notes: z.string().max(4000).nullable(),
  createdBy: z.string().min(1),
  createdAt: z.string(),
});
export type ReleaseManifest = z.infer<typeof ReleaseManifest>;

export type ReleaseManifestErrorCode =
  | "invalid_input"
  | "malformed"
  | "unsupported_algorithm"
  | "unknown_kid"
  | "signature_invalid"
  | "claims_invalid";

/** Every rejection on the sign/verify path. Callers branch on `code`, never on `message`. */
export class ReleaseManifestError extends Error {
  override readonly name = "ReleaseManifestError";
  readonly code: ReleaseManifestErrorCode;
  // No parameter properties: this file also runs under Node's type stripping (scripts/).
  constructor(code: ReleaseManifestErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

type KeyJwk = JWK & { kid?: string };

function assertEcSigningKey(jwk: KeyJwk, needPrivate: boolean) {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || (needPrivate && !jwk.d)) {
    throw new ReleaseManifestError(
      "invalid_input",
      `release signing key must be an EC P-256 ${needPrivate ? "private" : "public"} JWK`,
    );
  }
  if (jwk.alg !== undefined && jwk.alg !== MANIFEST_FORMAT.signingAlg) {
    throw new ReleaseManifestError(
      "unsupported_algorithm",
      `signing key alg ${jwk.alg} is not ES256`,
    );
  }
}

export type SignManifestInput = {
  manifest: ReleaseManifest;
  /** Parsed `RELEASE_SIGNING_JWK` (EC P-256 private JWK). */
  serverPrivateJwk: JWK;
  /** Signing key id, carried in the JWS header. */
  kid: string;
};

/** Validates and signs the manifest (ES256). Returns a compact JWS. */
export async function signManifest({
  manifest,
  serverPrivateJwk,
  kid,
}: SignManifestInput): Promise<string> {
  if (!kid) throw new ReleaseManifestError("invalid_input", "kid is required");
  const parsed = ReleaseManifest.safeParse(manifest);
  if (!parsed.success) {
    throw new ReleaseManifestError("invalid_input", `manifest is invalid: ${parsed.error.message}`);
  }
  assertEcSigningKey(serverPrivateJwk, true);

  let signingKey: CryptoKey | Uint8Array;
  try {
    signingKey = await importJWK(serverPrivateJwk, MANIFEST_FORMAT.signingAlg);
  } catch (cause) {
    throw new ReleaseManifestError("invalid_input", "could not import the signing key", { cause });
  }

  return new SignJWT(parsed.data as unknown as JWTPayload)
    .setProtectedHeader({
      alg: MANIFEST_FORMAT.signingAlg,
      kid,
      typ: MANIFEST_FORMAT.typ,
    })
    .sign(signingKey);
}

export type VerifyManifestInput = {
  jws: string;
  /**
   * Pinned server signing keys (public JWKs, each with `kid`). Only these kids are trusted; a kid
   * that is not listed (never seen, or removed after rotation) is rejected as `unknown_kid`.
   */
  serverPublicJwks: readonly JWK[];
};

export type VerifiedManifest = {
  manifest: ReleaseManifest;
  kid: string;
};

/**
 * Reference verifier. Checks the JWS is ES256 with our `typ`, that its `kid` is one of the pinned
 * keys, verifies the signature, then validates the payload shape. Anything unexpected is a
 * `ReleaseManifestError`; there is no lenient path.
 */
export async function verifyManifest({
  jws,
  serverPublicJwks,
}: VerifyManifestInput): Promise<VerifiedManifest> {
  if (typeof jws !== "string" || jws.split(".").length !== 3) {
    throw new ReleaseManifestError("malformed", "manifest envelope is not a compact JWS");
  }

  let jwsHeader: ReturnType<typeof decodeProtectedHeader>;
  try {
    jwsHeader = decodeProtectedHeader(jws);
  } catch (cause) {
    throw new ReleaseManifestError("malformed", "JWS protected header is not decodable", { cause });
  }

  if (jwsHeader.alg !== MANIFEST_FORMAT.signingAlg) {
    throw new ReleaseManifestError(
      "unsupported_algorithm",
      `JWS alg ${String(jwsHeader.alg)} is not ES256`,
    );
  }
  const kid = jwsHeader.kid;
  if (typeof kid !== "string" || kid.length === 0) {
    throw new ReleaseManifestError("unknown_kid", "JWS has no kid");
  }
  const pinned = serverPublicJwks.find((jwk) => jwk.kid === kid);
  if (!pinned) throw new ReleaseManifestError("unknown_kid", `signing key ${kid} is not trusted`);
  assertEcSigningKey(pinned, false);

  let serverKey: CryptoKey | Uint8Array;
  try {
    serverKey = await importJWK(
      { kty: "EC", crv: pinned.crv, x: pinned.x, y: pinned.y },
      MANIFEST_FORMAT.signingAlg,
    );
  } catch (cause) {
    throw new ReleaseManifestError("invalid_input", `could not import signing key ${kid}`, {
      cause,
    });
  }

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(jws, serverKey, {
      algorithms: [MANIFEST_FORMAT.signingAlg],
      typ: MANIFEST_FORMAT.typ,
    }));
  } catch (cause) {
    const code = (cause as { code?: string }).code;
    throw new ReleaseManifestError(
      code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" || code === "ERR_JWS_INVALID"
        ? "signature_invalid"
        : "claims_invalid",
      "manifest signature rejected",
      { cause },
    );
  }

  const parsed = ReleaseManifest.safeParse(payload);
  if (!parsed.success) {
    throw new ReleaseManifestError(
      "claims_invalid",
      `manifest payload does not match the schema: ${parsed.error.message}`,
    );
  }

  return { manifest: parsed.data, kid };
}
