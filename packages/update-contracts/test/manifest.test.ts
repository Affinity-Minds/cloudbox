import { describe, expect, it } from "vitest";
import { generateReleaseSigningKey } from "../src/keys.ts";
import {
  ReleaseManifest,
  ReleaseManifestError,
  type ReleaseManifest as ReleaseManifestType,
  signManifest,
  verifyManifest,
} from "../src/manifest.ts";

const baseManifest: ReleaseManifestType = {
  component: "agent",
  version: "1.4.2",
  channel: "pilot",
  minAgentVersion: "1.0.0",
  package: {
    r2Key: "releases/agent/1.4.2/cloudbox-agent-1.4.2.msi",
    sha256: "964b46314d4688cd8103320932104534bd82e07a9a9b6ca77d20892f3fd5c84b",
    sizeBytes: 1024,
  },
  rollbackOf: null,
  notes: "Test release",
  createdBy: "stf_test",
  createdAt: "2026-09-27T00:00:00.000Z",
};

describe("ReleaseManifest schema", () => {
  it("accepts a well-formed manifest", () => {
    expect(ReleaseManifest.safeParse(baseManifest).success).toBe(true);
  });

  it("rejects a non-semver version", () => {
    expect(ReleaseManifest.safeParse({ ...baseManifest, version: "v1" }).success).toBe(false);
  });

  it("rejects an unknown component or channel", () => {
    expect(ReleaseManifest.safeParse({ ...baseManifest, component: "printer" }).success).toBe(
      false,
    );
    expect(ReleaseManifest.safeParse({ ...baseManifest, channel: "everyone" }).success).toBe(false);
  });

  it("rejects a malformed sha256", () => {
    expect(
      ReleaseManifest.safeParse({
        ...baseManifest,
        package: { ...baseManifest.package, sha256: "not-a-hash" },
      }).success,
    ).toBe(false);
  });
});

describe("sign/verify round trip", () => {
  it("verifies to the same manifest with the pinned kid", async () => {
    const key = await generateReleaseSigningKey();
    const jws = await signManifest({
      manifest: baseManifest,
      serverPrivateJwk: key.privateJwk,
      kid: key.kid,
    });
    const { manifest, kid } = await verifyManifest({ jws, serverPublicJwks: [key.publicJwk] });
    expect(manifest).toEqual(baseManifest);
    expect(kid).toBe(key.kid);
  });

  it("refuses a manifest that fails the zod schema before signing", async () => {
    const key = await generateReleaseSigningKey();
    await expect(
      signManifest({
        manifest: { ...baseManifest, version: "not-semver" },
        serverPrivateJwk: key.privateJwk,
        kid: key.kid,
      }),
    ).rejects.toMatchObject({ name: "ReleaseManifestError", code: "invalid_input" });
  });

  it("rejects a tampered signature", async () => {
    const key = await generateReleaseSigningKey();
    const jws = await signManifest({
      manifest: baseManifest,
      serverPrivateJwk: key.privateJwk,
      kid: key.kid,
    });
    const parts = jws.split(".");
    // Flip one character of the signature segment.
    const sig = parts[2] ?? "";
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    const tampered = `${parts[0]}.${parts[1]}.${flipped}`;
    await expect(
      verifyManifest({ jws: tampered, serverPublicJwks: [key.publicJwk] }),
    ).rejects.toMatchObject({ name: "ReleaseManifestError", code: "signature_invalid" });
  });

  it("rejects a tampered payload", async () => {
    const key = await generateReleaseSigningKey();
    const jws = await signManifest({
      manifest: baseManifest,
      serverPrivateJwk: key.privateJwk,
      kid: key.kid,
    });
    const parts = jws.split(".");
    const payload = parts[1] ?? "";
    const flipped = (payload[0] === "A" ? "B" : "A") + payload.slice(1);
    const tampered = `${parts[0]}.${flipped}.${parts[2]}`;
    await expect(
      verifyManifest({ jws: tampered, serverPublicJwks: [key.publicJwk] }),
    ).rejects.toBeInstanceOf(ReleaseManifestError);
  });

  it("rejects a kid that is not in the pinned set", async () => {
    const key = await generateReleaseSigningKey();
    const other = await generateReleaseSigningKey();
    const jws = await signManifest({
      manifest: baseManifest,
      serverPrivateJwk: key.privateJwk,
      kid: key.kid,
    });
    await expect(
      verifyManifest({ jws, serverPublicJwks: [other.publicJwk] }),
    ).rejects.toMatchObject({ name: "ReleaseManifestError", code: "unknown_kid" });
  });

  it("rejects an unsupported alg or typ", async () => {
    const key = await generateReleaseSigningKey();
    const { SignJWT } = await import("jose");
    const { importJWK } = await import("jose");
    const signingKey = await importJWK(key.privateJwk, "ES256");

    const wrongTyp = await new SignJWT(baseManifest as unknown as Record<string, unknown>)
      .setProtectedHeader({ alg: "ES256", kid: key.kid, typ: "some-other+jwt" })
      .sign(signingKey);
    await expect(
      verifyManifest({ jws: wrongTyp, serverPublicJwks: [key.publicJwk] }),
    ).rejects.toBeInstanceOf(ReleaseManifestError);
  });

  it("rejects a malformed token", async () => {
    await expect(verifyManifest({ jws: "not-a-jws", serverPublicJwks: [] })).rejects.toMatchObject({
      name: "ReleaseManifestError",
      code: "malformed",
    });
  });
});
