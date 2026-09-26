// The committed reference vector must keep verifying: it is what the .NET verifier is tested against.
import { readFileSync } from "node:fs";
import type { JWK } from "jose";
import { describe, expect, it } from "vitest";
import { EntitlementError, verifyEntitlement } from "../src/entitlement.ts";

const vector = JSON.parse(readFileSync(new URL("./vectors/v1.json", import.meta.url), "utf8")) as {
  token: string;
  devicePrivateJwk: JWK;
  otherDevicePrivateJwk: JWK;
  serverPublicJwks: JWK[];
  expectedClaims: Record<string, unknown>;
};

describe("test vector v1", () => {
  it("verifies to the expected claims with the device key", async () => {
    const { claims } = await verifyEntitlement({
      token: vector.token,
      devicePrivateJwk: vector.devicePrivateJwk,
      serverPublicJwks: vector.serverPublicJwks,
    });
    expect(claims).toEqual(vector.expectedClaims);
  });

  it("does not decrypt with another device's key", async () => {
    await expect(
      verifyEntitlement({
        token: vector.token,
        devicePrivateJwk: vector.otherDevicePrivateJwk,
        serverPublicJwks: vector.serverPublicJwks,
      }),
    ).rejects.toMatchObject({ name: "EntitlementError", code: "decryption_failed" });
    expect(EntitlementError).toBeDefined();
  });
});
