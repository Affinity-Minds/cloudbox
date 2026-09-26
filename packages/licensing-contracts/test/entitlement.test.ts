import {
  CompactEncrypt,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importJWK,
  type JWK,
  SignJWT,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type EntitlementClaims,
  EntitlementError,
  issueEntitlement,
  verifyEntitlement,
} from "../src/entitlement.ts";
import { generateServerSigningKey, parseSigningSecret, type ServerSigningKey } from "../src/keys.ts";

type DeviceKey = { publicJwk: JWK; privateJwk: JWK; thumbprint: string };

async function deviceKey(): Promise<DeviceKey> {
  const { publicKey, privateKey } = await generateKeyPair("RSA-OAEP-256", {
    modulusLength: 2048,
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  return {
    publicJwk,
    privateJwk: await exportJWK(privateKey),
    thumbprint: await calculateJwkThumbprint(publicJwk, "sha256"),
  };
}

function claimsFor(device: DeviceKey, kid: string, generation = 1): EntitlementClaims {
  return {
    iss: "cloudbox",
    kid,
    jti: "lic_0001",
    iat: 1_790_000_000,
    license_id: "lic_0001",
    tenant_id: "ten_0001",
    device_id: "dev_0001",
    device_key_thumbprint: device.thumbprint,
    max_managed_users: 6,
    valid_from: "2026-09-27T00:00:00.000Z",
    valid_until: "2027-09-27T00:00:00.000Z",
    renewal_warning_days: 30,
    offline_grace_days: 7,
    generation,
    features: ["remote_access", "managed_backup", "fleet"],
  };
}

async function expectCode(promise: Promise<unknown>, code: EntitlementError["code"]) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(EntitlementError);
  expect((error as EntitlementError).code).toBe(code);
}

/** Flip one base64url character inside segment `index` of a compact serialisation. */
function tamper(token: string, index: number): string {
  const parts = token.split(".");
  const segment = parts[index] ?? "";
  const at = Math.floor(segment.length / 2);
  const swapped = segment[at] === "A" ? "B" : "A";
  parts[index] = segment.slice(0, at) + swapped + segment.slice(at + 1);
  return parts.join(".");
}

let server: ServerSigningKey;
let deviceA: DeviceKey;
let deviceB: DeviceKey;

beforeAll(async () => {
  server = await generateServerSigningKey();
  deviceA = await deviceKey();
  deviceB = await deviceKey();
});

const issueTo = (device: DeviceKey, claims = claimsFor(device, server.kid)) =>
  issueEntitlement({
    claims,
    serverPrivateJwk: server.privateJwk,
    kid: server.kid,
    devicePublicJwk: device.publicJwk,
  });

describe("generateServerSigningKey", () => {
  it("returns a P-256 pair whose kid is the RFC 7638 thumbprint and whose secret round-trips", async () => {
    expect(server.publicJwk).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", use: "sig" });
    expect(server.publicJwk.d).toBeUndefined();
    expect(server.kid).toBe(await calculateJwkThumbprint(server.publicJwk, "sha256"));
    const parsed = parseSigningSecret(JSON.stringify(server.privateJwk));
    expect(parsed.kid).toBe(server.kid);
    expect(parsed.publicJwk).toEqual(server.publicJwk);
  });

  it("rejects a secret that is not a P-256 private JWK with a kid", async () => {
    expect(() => parseSigningSecret(undefined)).toThrow(EntitlementError);
    expect(() => parseSigningSecret("{")).toThrow(EntitlementError);
    expect(() => parseSigningSecret(JSON.stringify(server.publicJwk))).toThrow(EntitlementError);
    const { kid: _kid, ...noKid } = server.privateJwk;
    expect(() => parseSigningSecret(JSON.stringify(noKid))).toThrow(EntitlementError);
  });
});

describe("issueEntitlement → verifyEntitlement", () => {
  it("round-trips: sign, encrypt, decrypt, verify, claims equal", async () => {
    const claims = claimsFor(deviceA, server.kid);
    const token = await issueTo(deviceA, claims);

    expect(token.split(".")).toHaveLength(5);
    expect(token).not.toContain("dev_0001");
    const header = JSON.parse(atob(token.split(".")[0] ?? ""));
    expect(header).toEqual({ alg: "RSA-OAEP-256", enc: "A256GCM", cty: "JWT", kid: server.kid });

    const verified = await verifyEntitlement({
      token,
      devicePrivateJwk: deviceA.privateJwk,
      serverPublicJwks: [server.publicJwk],
    });
    expect(verified.kid).toBe(server.kid);
    expect(verified.claims).toEqual(claims);
  });

  it("fails when any one character of the ciphertext, tag, IV, key or header is changed", async () => {
    const token = await issueTo(deviceA);
    for (const index of [0, 1, 2, 3, 4]) {
      const promise = verifyEntitlement({
        token: tamper(token, index),
        devicePrivateJwk: deviceA.privateJwk,
        serverPublicJwks: [server.publicJwk],
      });
      await expect(promise).rejects.toBeInstanceOf(EntitlementError);
    }
    await expectCode(
      verifyEntitlement({
        token: tamper(token, 3),
        devicePrivateJwk: deviceA.privateJwk,
        serverPublicJwks: [server.publicJwk],
      }),
      "decryption_failed",
    );
  });

  it("encrypted to key A cannot be decrypted with key B (copy protection primitive)", async () => {
    const token = await issueTo(deviceA);
    await expectCode(
      verifyEntitlement({
        token,
        devicePrivateJwk: deviceB.privateJwk,
        serverPublicJwks: [server.publicJwk],
      }),
      "decryption_failed",
    );
  });

  it("rejects claims bound to a different device key even when the envelope decrypts", async () => {
    // Device A's claims, re-encrypted to B: decryption works, the thumbprint does not match B.
    const token = await issueTo(deviceB, claimsFor(deviceA, server.kid));
    await expectCode(
      verifyEntitlement({
        token,
        devicePrivateJwk: deviceB.privateJwk,
        serverPublicJwks: [server.publicJwk],
      }),
      "device_mismatch",
    );
  });

  it("rejects a signature by a key that is not the pinned one for that kid", async () => {
    const forger = await generateServerSigningKey();
    const forged = await issueEntitlement({
      claims: claimsFor(deviceA, server.kid),
      serverPrivateJwk: { ...forger.privateJwk, kid: server.kid },
      kid: server.kid,
      devicePublicJwk: deviceA.publicJwk,
    });
    await expectCode(
      verifyEntitlement({
        token: forged,
        devicePrivateJwk: deviceA.privateJwk,
        serverPublicJwks: [server.publicJwk],
      }),
      "signature_invalid",
    );
  });

  it("rejects a stale kid that is no longer pinned", async () => {
    const retired = await generateServerSigningKey();
    const token = await issueEntitlement({
      claims: claimsFor(deviceA, retired.kid),
      serverPrivateJwk: retired.privateJwk,
      kid: retired.kid,
      devicePublicJwk: deviceA.publicJwk,
    });
    // Still trusted while the retired key stays pinned next to the new one…
    await expect(
      verifyEntitlement({
        token,
        devicePrivateJwk: deviceA.privateJwk,
        serverPublicJwks: [server.publicJwk, retired.publicJwk],
      }),
    ).resolves.toMatchObject({ kid: retired.kid });
    // …rejected once it is removed from the pinned set.
    await expectCode(
      verifyEntitlement({
        token,
        devicePrivateJwk: deviceA.privateJwk,
        serverPublicJwks: [server.publicJwk],
      }),
      "unknown_kid",
    );
  });

  describe("wrong algorithms are rejected", () => {
    const encrypt = async (jws: string, alg: string, enc: string) => {
      const key = await importJWK(deviceA.publicJwk, alg);
      return new CompactEncrypt(new TextEncoder().encode(jws))
        .setProtectedHeader({ alg, enc, cty: "JWT", kid: server.kid })
        .encrypt(key);
    };

    it("inner JWS signed HS256 with a guessable secret", async () => {
      const jws = await new SignJWT(claimsFor(deviceA, server.kid) as never)
        .setProtectedHeader({ alg: "HS256", kid: server.kid, typ: "cbx-entitlement+jwt" })
        .sign(new TextEncoder().encode("x".repeat(32)));
      await expectCode(
        verifyEntitlement({
          token: await encrypt(jws, "RSA-OAEP-256", "A256GCM"),
          devicePrivateJwk: deviceA.privateJwk,
          serverPublicJwks: [server.publicJwk],
        }),
        "unsupported_algorithm",
      );
    });

    it("inner JWS signed ES384", async () => {
      const { privateKey } = await generateKeyPair("ES384");
      const jws = await new SignJWT(claimsFor(deviceA, server.kid) as never)
        .setProtectedHeader({ alg: "ES384", kid: server.kid, typ: "cbx-entitlement+jwt" })
        .sign(privateKey);
      await expectCode(
        verifyEntitlement({
          token: await encrypt(jws, "RSA-OAEP-256", "A256GCM"),
          devicePrivateJwk: deviceA.privateJwk,
          serverPublicJwks: [server.publicJwk],
        }),
        "unsupported_algorithm",
      );
    });

    it("outer JWE using RSA-OAEP (SHA-1) or A128GCM", async () => {
      const jws = "a.b.c";
      for (const [alg, enc] of [
        ["RSA-OAEP", "A256GCM"],
        ["RSA-OAEP-256", "A128GCM"],
      ] as const) {
        await expectCode(
          verifyEntitlement({
            token: await encrypt(jws, alg, enc),
            devicePrivateJwk: deviceA.privateJwk,
            serverPublicJwks: [server.publicJwk],
          }),
          "unsupported_algorithm",
        );
      }
    });

    it("a correctly signed JWS with the wrong typ", async () => {
      const signingKey = await importJWK(server.privateJwk, "ES256");
      const jws = await new SignJWT(claimsFor(deviceA, server.kid) as never)
        .setProtectedHeader({ alg: "ES256", kid: server.kid, typ: "JWT" })
        .sign(signingKey);
      await expectCode(
        verifyEntitlement({
          token: await encrypt(jws, "RSA-OAEP-256", "A256GCM"),
          devicePrivateJwk: deviceA.privateJwk,
          serverPublicJwks: [server.publicJwk],
        }),
        "claims_invalid",
      );
    });
  });

  it("refuses to issue when claims.kid, iss or jti disagree with the envelope", async () => {
    const claims = claimsFor(deviceA, server.kid);
    await expectCode(issueTo(deviceA, { ...claims, kid: "other" }), "invalid_input");
    await expectCode(issueTo(deviceA, { ...claims, jti: "lic_other" }), "invalid_input");
    await expectCode(issueTo(deviceA, { ...claims, iss: "evil" as "cloudbox" }), "invalid_input");
  });

  it("refuses a malformed token without touching crypto", async () => {
    await expectCode(
      verifyEntitlement({
        token: "not.a.jwe",
        devicePrivateJwk: deviceA.privateJwk,
        serverPublicJwks: [server.publicJwk],
      }),
      "malformed",
    );
  });
});
