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

/** Only same-app paths: `/x`, never `//host` or an absolute URL (no open redirect). */
export function safeRedirect(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
  if (value.startsWith("/login")) return "/";
  return value;
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
