// Read only by the Better Auth CLI (`pnpm auth:generate`). Both surfaces' plugins, so the generated
// tables cover the staff (twoFactor) and customer (emailOTP) mounts. No bindings.
import { betterAuth } from "better-auth";
import type { Bindings } from "../env";
import { authOptions, customerAuthOptions } from "./index";

const env = { DB: {} as D1Database, BETTER_AUTH_SECRET: "cli" } as Bindings;
const staff = authOptions(env);
export const auth = betterAuth({
  ...staff,
  plugins: [...staff.plugins, ...customerAuthOptions(env).plugins],
});
