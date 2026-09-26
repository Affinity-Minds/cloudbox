// Owner: WT-1. Session → principal resolution, done per request from D1 and cached for that request
// only. Nothing is cached across requests, so a revoked session, role or grant takes effect on the
// next request.
import type { StaffRole } from "@cloudbox/contracts";
import { eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { createDb } from "../db/client";
import { rolePermissions, staffMembers } from "../db/schema";
import type { AppEnv, AppUser } from "../env";
import { authFor, trustedOrigins } from "./index";

export type Principal = {
  user: AppUser;
  sessionId: string;
  /** Staff permission keys from `role_permissions` for the user's staff role; empty for non-staff. */
  permissions: ReadonlySet<string>;
};

const principals = new WeakMap<Request, Promise<Principal | null>>();

async function loadPrincipal(c: Context<AppEnv>): Promise<Principal | null> {
  const session = await authFor(c).api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;

  // One query: the staff role and every grant of that role (no row = not staff).
  const rows = await createDb(c.env.DB)
    .select({ role: staffMembers.role, permission: rolePermissions.permissionKey })
    .from(staffMembers)
    .leftJoin(rolePermissions, eq(rolePermissions.role, staffMembers.role))
    .where(eq(staffMembers.userId, session.user.id));

  const staffRole = (rows[0]?.role ?? null) as StaffRole | null;
  const permissions = new Set<string>();
  for (const row of rows) if (row.permission) permissions.add(row.permission);

  return {
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      staffRole,
    },
    sessionId: session.session.id,
    permissions,
  };
}

/** The signed-in principal for this request, or null. Resolved once per request. */
export function getPrincipal(c: Context<AppEnv>): Promise<Principal | null> {
  let principal = principals.get(c.req.raw);
  if (!principal) {
    principal = loadPrincipal(c);
    principals.set(c.req.raw, principal);
  }
  return principal;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Cookie-authenticated writes must come from our own pages. Browsers always send `Origin` on a
 * POST/PATCH/DELETE; a foreign one (or a cross-site fetch-metadata hint) is refused. Requests with
 * neither (server-to-server, tests) are not browsers and carry no ambient cookie risk.
 */
function isTrustedOrigin(c: Context<AppEnv>, origin: string): boolean {
  return origin === new URL(c.req.url).origin || trustedOrigins(c.env).includes(origin);
}

function isCrossSiteWrite(c: Context<AppEnv>): boolean {
  if (SAFE_METHODS.has(c.req.method)) return false;
  const origin = c.req.header("origin");
  if (origin) return !isTrustedOrigin(c, origin);
  return c.req.header("sec-fetch-site") === "cross-site";
}

/**
 * Strict form for unauthenticated auth writes (sign-in is a login-CSRF target, review L-2): the
 * request must positively prove it comes from our pages, with a trusted `Origin` or
 * `Sec-Fetch-Site: same-origin`, cookie or not.
 */
export function isSameOriginWrite(c: Context<AppEnv>): boolean {
  if (SAFE_METHODS.has(c.req.method)) return true;
  const origin = c.req.header("origin");
  if (origin) return isTrustedOrigin(c, origin);
  return c.req.header("sec-fetch-site") === "same-origin";
}

export const unauthenticated = (c: Context<AppEnv>) =>
  c.json({ error: "unauthenticated" as const }, 401);
export const forbidden = (c: Context<AppEnv>) => c.json({ error: "forbidden" as const }, 403);

/**
 * Resolves the principal, sets `c.var.user`, and hands it to `check`. Answers 401 without a
 * session, 403 for a cross-site write or when `check` returns false.
 */
export function guard(
  check: (principal: Principal, c: Context<AppEnv>) => boolean | Promise<boolean>,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (isCrossSiteWrite(c)) return forbidden(c);
    const principal = await getPrincipal(c);
    if (!principal) return unauthenticated(c);
    c.set("user", principal.user);
    if (!(await check(principal, c))) return forbidden(c);
    await next();
  };
}

/** Resolves the Better Auth session into `c.var.user`; 401 `{error:'unauthenticated'}` otherwise. */
export function requireUser(): MiddlewareHandler<AppEnv> {
  return guard(() => true);
}

/** `requireUser()` plus a `staff_members` row; 403 `{error:'forbidden'}` otherwise. */
export function requireStaff(): MiddlewareHandler<AppEnv> {
  return guard((principal) => principal.user.staffRole !== null);
}
