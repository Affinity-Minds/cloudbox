// Owner: WT-17. `/api/v1/screens/alerts`, `/api/v1/alerts/:id/{acknowledge,resolve}`,
// `/api/v1/settings/alerts`.
import type { Alert, AlertsScreen, AlertsSettings } from "@cloudbox/contracts";
import { queryOptions } from "@tanstack/react-query";
import { api } from "./client";

export type AlertsFilters = { status?: string; severity?: string; tenant?: string };

function alertsSearchParams(filters: AlertsFilters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.severity) params.set("severity", filters.severity);
  if (filters.tenant) params.set("tenant", filters.tenant);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const alertsQuery = (filters: AlertsFilters) =>
  queryOptions({
    queryKey: ["screens", "alerts", filters],
    queryFn: () => api<AlertsScreen>(`/api/v1/screens/alerts${alertsSearchParams(filters)}`),
  });

export const acknowledgeAlert = (id: string) =>
  api<Alert>(`/api/v1/alerts/${encodeURIComponent(id)}/acknowledge`, { method: "POST" });

export const resolveAlert = (id: string) =>
  api<Alert>(`/api/v1/alerts/${encodeURIComponent(id)}/resolve`, { method: "POST" });

export const alertsSettingsQuery = queryOptions({
  queryKey: ["settings", "alerts"],
  queryFn: () => api<AlertsSettings>("/api/v1/settings/alerts"),
});

export const updateAlertsSettings = (staffRecipients: string[]) =>
  api<AlertsSettings>("/api/v1/settings/alerts", {
    method: "PATCH",
    body: JSON.stringify({ staffRecipients }),
  });
