// The committed reference vector must keep verifying: it is what the .NET updater verifier
// (later slice) is tested against.
import { readFileSync } from "node:fs";
import type { JWK } from "jose";
import { describe, expect, it } from "vitest";
import { ReleaseManifestError, verifyManifest } from "../src/manifest.ts";

const vector = JSON.parse(readFileSync(new URL("./vectors/v1.json", import.meta.url), "utf8")) as {
  jws: string;
  serverPublicJwks: JWK[];
  otherServerPublicJwks: JWK[];
  expectedManifest: Record<string, unknown>;
};

describe("test vector v1", () => {
  it("verifies to the expected manifest with the pinned kid", async () => {
    const { manifest } = await verifyManifest({
      jws: vector.jws,
      serverPublicJwks: vector.serverPublicJwks,
    });
    expect(manifest).toEqual(vector.expectedManifest);
  });

  it("rejects the same token pinned to a different signing key", async () => {
    await expect(
      verifyManifest({ jws: vector.jws, serverPublicJwks: vector.otherServerPublicJwks }),
    ).rejects.toMatchObject({ name: "ReleaseManifestError", code: "unknown_kid" });
    expect(ReleaseManifestError).toBeDefined();
  });
});
