// Owner: WT-1. Session → principal resolution, done per request from D1 and cached for that request
// only. Nothing is cached across requests, so a revoked session, role or grant takes effect on the
// next request.
import type { StaffRole, StaffSetup } from "@cloudbox/contracts";
import { eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { createDb } from "../db/client";
import { rolePermissions, staffMembers } from "../db/schema";
import type { AppEnv, AppUser } from "../env";
import { authFor, customerAuthFor, SESSION_COOKIE, type Surface, trustedOrigins } from "./index";

export type Principal = {
  /** Which identity system the session belongs to (two systems, nothing shared; ADR 0002). */
  surface: Surface;
  user: AppUser;
  sessionId: string;
  /** Staff permission keys from `role_permissions`; always empty for a customer. */
  permissions: ReadonlySet<string>;
  /** Staff first-sign-in gates (ADR 0009); null for customers. */
  setup: StaffSetup | null;
};

/** Staff whose initial password or authenticator is still pending (ADR 0009). */
export const setupPending = (p: Principal) =>
  p.setup !== null && (p.setup.passwordChangeRequired || p.setup.authenticatorRequired);

/** True when the request carries that identity system's session cookie (either spelling). */
export function hasSessionCookie(c: Context<AppEnv>, surface: Surface): boolean {
  const name = `${SESSION_COOKIE[surface]}=`;
  return (c.req.header("cookie") ?? "").split(";").some((part) => {
    const cookie = part.trim();
    return cookie.startsWith(name) || cookie.startsWith(`__Secure-${name}`);
  });
}

async function loadStaffPrincipal(c: Context<AppEnv>): Promise<Principal | null> {
  if (!hasSessionCookie(c, "staff")) return null;
  const session = await authFor(c).api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;

  // One query: the staff role and every grant of that role (no row = no longer staff).
  const rows = await createDb(c.env.DB)
    .select({
      role: staffMembers.role,
      mustChangePassword: staffMembers.mustChangePassword,
      permission: rolePermissions.permissionKey,
    })
    .from(staffMembers)
    .leftJoin(rolePermissions, eq(rolePermissions.role, staffMembers.role))
    .where(eq(staffMembers.userId, session.user.id));

  const staffRole = (rows[0]?.role ?? null) as StaffRole | null;
  const permissions = new Set<string>();
  for (const row of rows) if (row.permission) permissions.add(row.permission);

  return {
    surface: "staff",
    user: {
      surface: "staff",
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      staffRole,
    },
    sessionId: session.session.id,
    permissions,
    setup: rows[0]
      ? {
          passwordChangeRequired: rows[0].mustChangePassword,
          authenticatorRequired: !session.user.twoFactorEnabled,
        }
      : null,
  };
}

async function loadCustomerPrincipal(c: Context<AppEnv>): Promise<Principal | null> {
  if (!hasSessionCookie(c, "customer")) return null;
  const session = await customerAuthFor(c).api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  return {
    surface: "customer",
    user: {
      surface: "customer",
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      staffRole: null,
    },
    sessionId: session.session.id,
    permissions: new Set(),
    setup: null,
  };
}

const staffPrincipals = new WeakMap<Request, Promise<Principal | null>>();
const customerPrincipals = new WeakMap<Request, Promise<Principal | null>>();

function cached(
  map: WeakMap<Request, Promise<Principal | null>>,
  c: Context<AppEnv>,
  load: (c: Context<AppEnv>) => Promise<Principal | null>,
) {
  let principal = map.get(c.req.raw);
  if (!principal) {
    principal = load(c);
    map.set(c.req.raw, principal);
  }
  return principal;
}

/** The staff principal (staff cookie → staff tables only), or null. Once per request. */
export function getStaffPrincipal(c: Context<AppEnv>): Promise<Principal | null> {
  return cached(staffPrincipals, c, loadStaffPrincipal);
}

/** The customer principal (customer cookie → customer tables only), or null. Once per request. */
export function getCustomerPrincipal(c: Context<AppEnv>): Promise<Principal | null> {
  return cached(customerPrincipals, c, loadCustomerPrincipal);
}

/**
 * For routes both audiences use (session, logout, and WT-2/WT-3 routes open to staff *or* tenant
 * members): the staff principal if there is one, else the customer principal. Each is resolved
 * from its own cookie and tables; nothing is mixed.
 */
export async function getPrincipal(c: Context<AppEnv>): Promise<Principal | null> {
  return (await getStaffPrincipal(c)) ?? (await getCustomerPrincipal(c));
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

type Check = (principal: Principal, c: Context<AppEnv>) => boolean | Promise<boolean>;
type GuardOptions = { allowSetupPending?: boolean };
export type Audience = "staff" | "customer" | "either";

/**
 * Resolves the principal of the given audience, sets `c.var.user`, and hands it to `check`.
 * 401 without a session of that audience; 403 for a cross-site write, a staff account with setup
 * pending (`setup_required`), or when `check` is false. "either" tries the staff principal, then
 * the customer principal; a staff route never reads a customer session and vice versa.
 */
export function guardFor(
  audience: Audience,
  check: Check,
  options: GuardOptions = {},
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (isCrossSiteWrite(c)) return forbidden(c);
    const candidates = [
      audience !== "customer" ? await getStaffPrincipal(c) : null,
      audience !== "staff" ? await getCustomerPrincipal(c) : null,
    ].filter((p): p is Principal => p !== null);
    if (candidates.length === 0) return unauthenticated(c);
    let refusal: Response | null = null;
    for (const principal of candidates) {
      // A staff account that has not replaced its initial password and enrolled an authenticator
      // reaches nothing but its session, logout and the staff setup endpoints (ADR 0009).
      if (!options.allowSetupPending && setupPending(principal)) {
        refusal ??= c.json({ error: "setup_required" as const, detail: principal.setup }, 403);
        continue;
      }
      c.set("user", principal.user);
      if (await check(principal, c)) {
        await next();
        return;
      }
    }
    return refusal ?? forbidden(c);
  };
}

/** Routes open to staff or tenant members (WT-2/WT-3): `check` sees whichever principal. */
export function guard(check: Check, options: GuardOptions = {}): MiddlewareHandler<AppEnv> {
  return guardFor("either", check, options);
}

/** Customer routes (portal, /me): a customer session, never a staff one. */
export function requireUser(options: GuardOptions = {}): MiddlewareHandler<AppEnv> {
  return guardFor("customer", () => true, options);
}

/** Session, logout: any signed-in principal of either system. */
export function requireSession(options: GuardOptions = {}): MiddlewareHandler<AppEnv> {
  return guardFor("either", () => true, options);
}

/** Staff routes: a staff session with a `staff_members` row and setup done; 401/403 otherwise. */
export function requireStaff(): MiddlewareHandler<AppEnv> {
  return guardFor("staff", (principal) => principal.user.staffRole !== null);
}
