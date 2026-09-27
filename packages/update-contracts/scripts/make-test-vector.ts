// Regenerates test/vectors/v1.json: a TEST-ONLY server key and signed manifest, for the Windows
// updater's verifier (later slice) to check its .NET implementation against this reference.
// The key in the vector is throwaway and never used anywhere else.
//
//   node packages/update-contracts/scripts/make-test-vector.ts > packages/update-contracts/test/vectors/v1.json
import { generateReleaseSigningKey } from "../src/keys.ts";
import { type ReleaseManifest, signManifest } from "../src/manifest.ts";

const server = await generateReleaseSigningKey();
const otherServer = await generateReleaseSigningKey();

const manifest: ReleaseManifest = {
  component: "agent",
  version: "1.4.2",
  channel: "stable",
  minAgentVersion: "1.2.0",
  package: {
    r2Key: "releases/agent/1.4.2/cloudbox-agent-1.4.2.msi",
    sha256: "964b46314d4688cd8103320932104534bd82e07a9a9b6ca77d20892f3fd5c84b",
    sizeBytes: 41_943_040,
  },
  rollbackOf: null,
  notes: "Test vector release.",
  createdBy: "stf_00000000-0000-4000-8000-000000000001",
  createdAt: "2026-09-27T00:00:00.000Z",
};

const jws = await signManifest({ manifest, serverPrivateJwk: server.privateJwk, kid: server.kid });

process.stdout.write(
  `${JSON.stringify(
    {
      note: "TEST VECTOR ONLY. Throwaway keys; never trust this server key outside tests.",
      format: "JWS ES256 {typ:cbx-release+jwt}",
      jws,
      serverPublicJwks: [server.publicJwk],
      otherServerPublicJwks: [otherServer.publicJwk],
      expectedManifest: manifest,
    },
    null,
    2,
  )}\n`,
);
