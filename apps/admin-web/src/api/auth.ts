// Owner: WT-1. Sign-in (Better Auth email OTP at /api/auth/*), session and logout (/api/v1/auth/*).
import type { SessionResponse } from "@cloudbox/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ApiError, api } from "./client";

/** Must match HONEYPOT_HEADER in apps/worker-api/src/auth/index.ts. */
const HONEYPOT_HEADER = "x-cloudbox-hp";

export const sessionQuery = queryOptions({
  queryKey: ["auth", "session"],
  queryFn: () => api<SessionResponse>("/api/v1/auth/session"),
  staleTime: 60_000,
  retry: false,
});

/** Better Auth answers errors as `{code, message}`; map them onto ApiError with the code. */
async function authPost(path: string, body: unknown, honeypot: string): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (honeypot) headers[HONEYPOT_HEADER] = honeypot;
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new ApiError(0, "network_error", cause instanceof Error ? cause.message : undefined);
  }
  if (response.ok) return;
  const error = (await response.json().catch(() => ({}))) as { code?: string; error?: string };
  const retryAfter = Number(response.headers.get("x-retry-after"));
  throw new ApiError(
    response.status,
    (error.code ?? error.error ?? `http_${response.status}`).toLowerCase(),
    Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfter } : undefined,
  );
}

export const sendOtp = (email: string, honeypot: string) =>
  authPost("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" }, honeypot);

export const verifyOtp = (email: string, otp: string, honeypot: string) =>
  authPost("/api/auth/sign-in/email-otp", { email, otp }, honeypot);

export const logout = () => api<null>("/api/v1/auth/logout", { method: "POST" });

/** Human text for a failed send/verify. Never says whether the address has an account. */
export function describeAuthError(error: unknown): string {
  if (!(error instanceof ApiError)) return "Something went wrong. Try again.";
  if (error.status === 429) {
    const wait = (error.detail as { retryAfter?: number } | undefined)?.retryAfter;
    return wait
      ? `Too many attempts. Try again in ${wait} s.`
      : "Too many attempts. Try again shortly.";
  }
  if (error.status === 0) return "Could not reach CloudBox. Check your connection.";
  if (error.error === "otp_expired") return "That code has expired. Request a new one.";
  if (error.error === "too_many_attempts") return "Too many wrong codes. Request a new one.";
  if (error.error === "invalid_otp") return "That code is not right. Check it and try again.";
  if (error.status >= 500) return "CloudBox had a problem. Try again.";
  return "That did not work. Check the details and try again.";
}
