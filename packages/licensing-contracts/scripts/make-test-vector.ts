// Regenerates test/vectors/v1.json: a TEST-ONLY server key, device key and entitlement, for the
// Windows verifier (WT-4 / WT-10) to check its .NET implementation against this reference.
// The keys in the vector are throwaway and never used anywhere else.
//
//   node packages/licensing-contracts/scripts/make-test-vector.ts > packages/licensing-contracts/test/vectors/v1.json
import { calculateJwkThumbprint, exportJWK, generateKeyPair } from "jose";
import { type EntitlementClaims, issueEntitlement } from "../src/entitlement.ts";
import { generateServerSigningKey } from "../src/keys.ts";

const server = await generateServerSigningKey();
const device = await generateKeyPair("RSA-OAEP-256", { modulusLength: 2048, extractable: true });
const otherDevice = await generateKeyPair("RSA-OAEP-256", {
  modulusLength: 2048,
  extractable: true,
});
const devicePublicJwk = await exportJWK(device.publicKey);

const claims: EntitlementClaims = {
  iss: "cloudbox",
  kid: server.kid,
  jti: "lic_00000000-0000-4000-8000-000000000001",
  iat: 1_790_467_200,
  license_id: "lic_00000000-0000-4000-8000-000000000001",
  tenant_id: "ten_00000000-0000-4000-8000-000000000001",
  device_id: "dev_00000000-0000-4000-8000-000000000001",
  device_key_thumbprint: await calculateJwkThumbprint(devicePublicJwk, "sha256"),
  max_managed_users: 6,
  valid_from: "2026-09-27T00:00:00.000Z",
  valid_until: "2027-09-27T00:00:00.000Z",
  renewal_warning_days: 30,
  offline_grace_days: 7,
  generation: 1,
  features: ["remote_access", "managed_backup", "fleet"],
};

const token = await issueEntitlement({
  claims,
  serverPrivateJwk: server.privateJwk,
  kid: server.kid,
  devicePublicJwk,
});

process.stdout.write(
  `${JSON.stringify(
    {
      note: "TEST VECTOR ONLY. Throwaway keys; never trust this server key outside tests.",
      format: "JWS ES256 {typ:cbx-entitlement+jwt} nested in JWE RSA-OAEP-256/A256GCM {cty:JWT}",
      token,
      devicePrivateJwk: await exportJWK(device.privateKey),
      otherDevicePrivateJwk: await exportJWK(otherDevice.privateKey),
      serverPublicJwks: [server.publicJwk],
      expectedClaims: claims,
    },
    null,
    2,
  )}\n`,
);
