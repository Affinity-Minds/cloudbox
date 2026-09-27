// Owner: WT-14. Self-service onboarding on the customer surface (ADR 0011): the /start path,
// tenant self-creation, licence-key redemption and the portal overview.
import type {
  CreateOwnTenantRequest,
  CreateOwnTenantResponse,
  OnboardingConfig,
  OnboardingOverview,
  RedeemLicenseKeyRequest,
} from "@cloudbox/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ApiError, api } from "./client";

/** Must match TURNSTILE_HEADER / HONEYPOT_HEADER in apps/worker-api/src/auth. */
const TURNSTILE_HEADER = "x-cloudbox-turnstile";
const HONEYPOT_HEADER = "x-cloudbox-hp";

export const onboardingConfigQuery = queryOptions({
  queryKey: ["onboarding", "config"],
  queryFn: () => api<OnboardingConfig>("/api/v1/onboarding/config"),
  staleTime: Number.POSITIVE_INFINITY,
});

export const onboardingOverviewQuery = queryOptions({
  queryKey: ["onboarding", "overview"],
  queryFn: () => api<OnboardingOverview>("/api/v1/onboarding/overview"),
});

/** Start-path calls answer Better Auth's `{code, message}` or our `{error}`; map both. */
async function startPost<T>(path: string, body: unknown, turnstile: string | null, hp: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (turnstile) headers[TURNSTILE_HEADER] = turnstile;
  if (hp) headers[HONEYPOT_HEADER] = hp;
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
  const json = (await response.json().catch(() => ({}))) as {
    code?: string;
    error?: string;
    detail?: unknown;
  };
  if (!response.ok) {
    throw new ApiError(
      response.status,
      (json.code ?? json.error ?? `http_${response.status}`).toLowerCase(),
      json.detail,
    );
  }
  return json as T;
}

export const startSendCode = (email: string, turnstile: string | null, hp: string) =>
  startPost<{ success: true }>("/api/auth/start/send-code", { email }, turnstile, hp);

export const startVerify = (email: string, code: string, turnstile: string | null, hp: string) =>
  startPost("/api/auth/start/verify", { email, code }, turnstile, hp);

export const createOwnTenant = (body: CreateOwnTenantRequest) =>
  api<CreateOwnTenantResponse>("/api/v1/onboarding/tenants", {
    method: "POST",
    body: JSON.stringify(body),
  });

export const redeemLicenseKey = (body: RedeemLicenseKeyRequest) =>
  api<CreateOwnTenantResponse>("/api/v1/onboarding/redeem", {
    method: "POST",
    body: JSON.stringify(body),
  });
