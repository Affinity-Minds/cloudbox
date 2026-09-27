// Owner: WT-2. Tenants, memberships, and the caller's own tenant list/active-tenant.
import type {
  CreateMembershipRequest,
  CreateTenantRequest,
  Membership,
  MyTenant,
  Tenant,
  TenantDetailScreen,
  TenantsScreen,
  UpdateMembershipRequest,
  UpdateTenantRequest,
} from "@cloudbox/contracts";
import { queryOptions } from "@tanstack/react-query";
import { api } from "./client";

export type TenantsFilter = {
  status?: string;
  plan?: string;
  q?: string;
  page?: number;
};

function tenantsSearch(filter: TenantsFilter): string {
  const params = new URLSearchParams();
  if (filter.status) params.set("status", filter.status);
  if (filter.plan) params.set("plan", filter.plan);
  if (filter.q) params.set("q", filter.q);
  if (filter.page && filter.page > 1) params.set("page", String(filter.page));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const tenantsScreenQuery = (filter: TenantsFilter) =>
  queryOptions({
    queryKey: ["screens", "tenants", filter],
    queryFn: () => api<TenantsScreen>(`/api/v1/screens/tenants${tenantsSearch(filter)}`),
  });

export const tenantDetailQuery = (tenantId: string) =>
  queryOptions({
    queryKey: ["screens", "tenants", tenantId],
    queryFn: () => api<TenantDetailScreen>(`/api/v1/screens/tenants/${tenantId}`),
    enabled: Boolean(tenantId),
  });

export const createTenant = (input: CreateTenantRequest) =>
  api<Tenant>("/api/v1/tenants", { method: "POST", body: JSON.stringify(input) });

export const updateTenant = (tenantId: string, input: UpdateTenantRequest) =>
  api<Tenant>(`/api/v1/tenants/${tenantId}`, { method: "PATCH", body: JSON.stringify(input) });

export const archiveTenant = (tenantId: string) =>
  api<Tenant>(`/api/v1/tenants/${tenantId}/archive`, { method: "POST" });

export const inviteMember = (tenantId: string, input: CreateMembershipRequest) =>
  api<Membership>(`/api/v1/tenants/${tenantId}/memberships`, {
    method: "POST",
    body: JSON.stringify(input),
  });

export const updateMemberStanding = (
  tenantId: string,
  membershipId: string,
  input: UpdateMembershipRequest,
) =>
  api<Membership>(`/api/v1/tenants/${tenantId}/memberships/${membershipId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });

export const removeMember = (tenantId: string, membershipId: string, reason?: string) =>
  api<Membership>(`/api/v1/tenants/${tenantId}/memberships/${membershipId}`, {
    method: "DELETE",
    body: reason ? JSON.stringify({ reason }) : undefined,
  });

export const myTenantsQuery = queryOptions({
  queryKey: ["me", "tenants"],
  queryFn: () => api<MyTenant[]>("/api/v1/me/tenants"),
});

export const setActiveTenant = (tenantId: string) =>
  api<{ tenantId: string; standing: string }>("/api/v1/me/active-tenant", {
    method: "POST",
    body: JSON.stringify({ tenantId }),
  });
