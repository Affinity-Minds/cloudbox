// Owner: WT-1. Session access for routes and components. The server is the authority; this only
// decides where to send the browser.
import type { StaffRole } from "@cloudbox/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import { sessionQuery } from "@/api/auth";
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

/** For `beforeLoad`: the session, or a redirect to /login that comes back to `href` afterwards. */
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
