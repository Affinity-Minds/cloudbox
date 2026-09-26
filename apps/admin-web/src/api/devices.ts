// Owner: WT-3. Fleet screens, device revoke, and per-tenant enrollment tokens.
import type {
  CreateEnrollmentTokenRequest,
  CreateEnrollmentTokenResponse,
  EnrollmentToken,
  FleetDetailScreen,
  FleetScreen,
} from "@cloudbox/contracts";
import { queryOptions } from "@tanstack/react-query";
import { api } from "./client";

export type FleetFilters = { tenant?: string; online?: boolean; q?: string };

function fleetSearchParams(filters: FleetFilters): string {
  const params = new URLSearchParams();
  if (filters.tenant) params.set("tenant", filters.tenant);
  if (filters.online !== undefined) params.set("online", String(filters.online));
  if (filters.q) params.set("q", filters.q);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const fleetQuery = (filters: FleetFilters) =>
  queryOptions({
    queryKey: ["screens", "fleet", filters],
    queryFn: () => api<FleetScreen>(`/api/v1/screens/fleet${fleetSearchParams(filters)}`),
  });

export const fleetDetailQuery = (deviceId: string) =>
  queryOptions({
    queryKey: ["screens", "fleet", "device", deviceId],
    queryFn: () => api<FleetDetailScreen>(`/api/v1/screens/fleet/${encodeURIComponent(deviceId)}`),
  });

export const revokeDevice = (deviceId: string) =>
  api<void>(`/api/v1/devices/${encodeURIComponent(deviceId)}/revoke`, { method: "POST" });

export const enrollmentTokensQuery = (tenantId: string) =>
  queryOptions({
    queryKey: ["enrollment-tokens", tenantId],
    queryFn: () =>
      api<EnrollmentToken[]>(`/api/v1/tenants/${encodeURIComponent(tenantId)}/enrollment-tokens`),
    enabled: tenantId.length > 0,
  });

export const createEnrollmentToken = (tenantId: string, body: CreateEnrollmentTokenRequest) =>
  api<CreateEnrollmentTokenResponse>(
    `/api/v1/tenants/${encodeURIComponent(tenantId)}/enrollment-tokens`,
    { method: "POST", body: JSON.stringify(body) },
  );

export const revokeEnrollmentToken = (tenantId: string, tokenId: string) =>
  api<void>(
    `/api/v1/tenants/${encodeURIComponent(tenantId)}/enrollment-tokens/${encodeURIComponent(tokenId)}`,
    { method: "DELETE" },
  );
