// Owner: WT-1. WT-0 fixes the adapter and the plugin list so the tables generated into
// src/db/schema.ts cannot drift from the running app (agent-notes cloudflare-workers #17).
// Change the plugin list only together with a regenerated schema (`pnpm auth:generate`).
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP } from "better-auth/plugins";
import { createDb } from "../db/client";
import * as schema from "../db/schema";
import type { Bindings } from "../env";

export function authOptions(env: Pick<Bindings, "DB" | "BETTER_AUTH_SECRET">) {
  return {
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(createDb(env.DB), { provider: "sqlite", schema }),
    emailAndPassword: { enabled: false },
    plugins: [
      emailOTP({
        async sendVerificationOTP() {
          // WT-1: call sendOtpEmail(env, { to: email, code: otp }) from ../email.
          throw new Error("not_implemented: WT-1 wires OTP delivery");
        },
      }),
    ],
  } satisfies BetterAuthOptions;
}

export function createAuth(env: Bindings) {
  return betterAuth(authOptions(env));
}

export type Auth = ReturnType<typeof createAuth>;
