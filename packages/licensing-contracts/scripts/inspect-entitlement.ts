// Demo/debug: decrypt and verify an entitlement the way the Windows agent does, print the claims.
//
//   node packages/licensing-contracts/scripts/inspect-entitlement.ts \
//     <device-private-jwk.json> <server-public-jwk-or-jwks.json> < entitlement.jwe
//
// The token is read from stdin so it never appears in shell history. Exit 1 with the error code on
// any rejection.
import { readFileSync } from "node:fs";
import type { JWK } from "jose";
import { EntitlementError, verifyEntitlement } from "../src/entitlement.ts";

const [devicePath, serverPath] = process.argv.slice(2);
if (!devicePath || !serverPath) {
  process.stderr.write(
    "usage: inspect-entitlement.ts <device-private.jwk> <server-public.jwk(s)>\n",
  );
  process.exit(2);
}

const devicePrivateJwk = JSON.parse(readFileSync(devicePath, "utf8")) as JWK;
const server = JSON.parse(readFileSync(serverPath, "utf8")) as JWK | { keys: JWK[] } | JWK[];
const serverPublicJwks = Array.isArray(server) ? server : "keys" in server ? server.keys : [server];
const token = readFileSync(0, "utf8").trim();

try {
  const { claims, kid } = await verifyEntitlement({ token, devicePrivateJwk, serverPublicJwks });
  process.stdout.write(`${JSON.stringify({ kid, claims }, null, 2)}\n`);
} catch (error) {
  if (error instanceof EntitlementError) {
    process.stderr.write(`rejected: ${error.code}: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
