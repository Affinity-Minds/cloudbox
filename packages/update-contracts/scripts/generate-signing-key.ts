// One-off: mint the server release-manifest signing key (docs/runbooks/release-key-rotation.md).
// A sibling of packages/licensing-contracts/scripts/generate-signing-key.ts for the *other* signer
// (releases get their own key, never ENTITLEMENT_SIGNING_JWK — see src/keys.ts header).
//
//   node packages/update-contracts/scripts/generate-signing-key.ts \
//     | gh secret set RELEASE_SIGNING_JWK --env production --repo Affinity-Minds/cloudbox
//
// stdout carries ONLY the private JWK (one line, for a pipe; never paste it anywhere else).
// stderr carries the kid and the public JWK for the runbook record. The public half needs no manual
// step: the Worker inserts it into `signing_keys` (purpose='release') on first issuance.
import { generateReleaseSigningKey } from "../src/keys.ts";

const key = await generateReleaseSigningKey();
if (process.stdout.isTTY) {
  process.stderr.write(
    "Refusing to print a private key to a terminal. Pipe stdout into `gh secret set` (see header).\n",
  );
  process.exit(1);
}
process.stdout.write(JSON.stringify(key.privateJwk));
process.stderr.write(`kid: ${key.kid}\npublic JWK: ${JSON.stringify(key.publicJwk)}\n`);
