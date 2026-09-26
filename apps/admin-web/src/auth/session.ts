// Owner: WT-1. Session access for routes and components. The server is the authority; this only
// decides where to send the browser.
import type { SessionResponse, StaffRole } from "@cloudbox/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import { customerSessionQuery, sessionQuery } from "@/api/auth";
import { ApiError } from "@/api/client";

export const ROLE_LABEL: Record<StaffRole, string> = {
  super_admin: "Super Admin",
  admin: "Admin",
  support: "Support",
  read_only: "Read only",
};

/**
 * Only same-app paths: `/x`. Never `//host`, `/\\host`, an absolute URL or control characters
 * (no open redirect, review L-9); the result must resolve to our own origin.
 */
export function safeRedirect(value: unknown, origin = globalThis.location?.origin): string {
  if (typeof value !== "string" || !value.startsWith("/")) return "/";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
  if (value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) return "/";
  if (value.startsWith("/login") || value.startsWith("/setup-")) return "/";
  const base = origin ?? "http://app.invalid";
  try {
    const url = new URL(value, base);
    if (url.origin !== new URL(base).origin) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

/** `path` (an app path) under the router's basepath, for `router.history` calls. */
export function withBase(basepath: string | undefined, path: string): string {
  const base = !basepath || basepath === "/" ? "" : basepath.replace(/\/$/, "");
  return `${base}${path === "/" && base ? "" : path}` || "/";
}

/** Customer surface `beforeLoad`: the customer session, or a redirect to the customer /login. */
export async function requireCustomerSession(queryClient: QueryClient) {
  try {
    return await queryClient.ensureQueryData(customerSessionQuery);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) throw redirect({ to: "/login" });
    throw error;
  }
}

/**
 * Ops console `beforeLoad`: the staff session (staff identity system only), or a redirect to the
 * staff login that comes back to `href` afterwards.
 */
export async function requireSession(queryClient: QueryClient, href: string) {
  try {
    return await queryClient.ensureQueryData(sessionQuery);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      throw redirect({ to: "/login", search: { redirect: safeRedirect(href) } });
    }
    throw error;
  }
}

/** Where a staff account with pending first-sign-in steps must go (ADR 0009), or null. */
export function pendingSetupPath(
  session: SessionResponse,
): "/setup-password" | "/setup-authenticator" | null {
  if (session.setup?.passwordChangeRequired) return "/setup-password";
  if (session.setup?.authenticatorRequired) return "/setup-authenticator";
  return null;
}
