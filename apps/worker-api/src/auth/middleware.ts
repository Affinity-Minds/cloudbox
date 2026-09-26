// Owner: WT-1. Stubs answer 501 until session resolution lands.
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";

/** Resolves the Better Auth session into `c.var.user`; 401 `{error:'unauthenticated'}` otherwise. */
export function requireUser(): MiddlewareHandler<AppEnv> {
  return async (c) => c.json({ error: "not_implemented", detail: "requireUser(): WT-1" }, 501);
}

/** `requireUser()` plus a `staff_members` row; 403 `{error:'forbidden'}` otherwise. */
export function requireStaff(): MiddlewareHandler<AppEnv> {
  return async (c) => c.json({ error: "not_implemented", detail: "requireStaff(): WT-1" }, 501);
}
