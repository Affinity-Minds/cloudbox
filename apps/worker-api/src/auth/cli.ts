// Read only by the Better Auth CLI (`pnpm auth:generate`). Same options as runtime, no bindings.
import { betterAuth } from "better-auth";
import { authOptions } from "./index";

export const auth = betterAuth(authOptions({ DB: {} as D1Database, BETTER_AUTH_SECRET: "cli" }));
