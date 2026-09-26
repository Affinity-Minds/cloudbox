// Read only by the Better Auth CLI. Two identity systems, two configs (owner decision, ADR 0002):
//   pnpm dlx auth@1.7.6 generate --config src/auth/cli.ts --output .wrangler/staff-schema.ts -y
//   pnpm dlx auth@1.7.6 generate --config src/auth/cli-customer.ts --output .wrangler/customer-schema.ts -y
// then copy both table sets into src/db/schema.ts. No bindings.
import { betterAuth } from "better-auth";
import type { Bindings } from "../env";
import { authOptions } from "./index";

export const auth = betterAuth(
  authOptions({ DB: {} as D1Database, STAFF_AUTH_SECRET: "cli" } as Bindings),
);
