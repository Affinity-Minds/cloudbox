// Owner: WT-15. The customer portal's own screens (`/api/v1/tenants/:tenantId/portal/*`).
import type {
  FleetScreen,
  PortalHome,
  PortalMembersScreen,
  PortalSubscriptionScreen,
} from "@cloudbox/contracts";
import { queryOptions } from "@tanstack/react-query";
import { api } from "./client";

export const portalHomeQuery = (tenantId: string) =>
  queryOptions({
    queryKey: ["portal", tenantId, "home"],
    queryFn: () => api<PortalHome>(`/api/v1/tenants/${encodeURIComponent(tenantId)}/portal`),
    enabled: tenantId.length > 0,
  });

export const portalMembersQuery = (tenantId: string) =>
  queryOptions({
    queryKey: ["portal", tenantId, "members"],
    queryFn: () =>
      api<PortalMembersScreen>(`/api/v1/tenants/${encodeURIComponent(tenantId)}/portal/members`),
    enabled: tenantId.length > 0,
  });

export const portalDevicesQuery = (tenantId: string) =>
  queryOptions({
    queryKey: ["portal", tenantId, "devices"],
    queryFn: () =>
      api<FleetScreen>(`/api/v1/tenants/${encodeURIComponent(tenantId)}/portal/devices`),
    enabled: tenantId.length > 0,
  });

export const portalSubscriptionQuery = (tenantId: string) =>
  queryOptions({
    queryKey: ["portal", tenantId, "subscription"],
    queryFn: () =>
      api<PortalSubscriptionScreen>(
        `/api/v1/tenants/${encodeURIComponent(tenantId)}/portal/subscription`,
      ),
    enabled: tenantId.length > 0,
  });
