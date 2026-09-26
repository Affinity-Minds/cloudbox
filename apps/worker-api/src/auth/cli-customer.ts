// Read only by the Better Auth CLI: the customer identity system (see cli.ts).
import { betterAuth } from "better-auth";
import type { Bindings } from "../env";
import { customerAuthOptions } from "./index";

export const auth = betterAuth(
  customerAuthOptions({ DB: {} as D1Database, CUSTOMER_AUTH_SECRET: "cli" } as Bindings),
);
