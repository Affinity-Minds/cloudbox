// Owner: WT-19. Backups screens, tenant policy editor, restore-test log.
import type {
  BackupDeviceHistoryScreen,
  BackupsScreen,
  CreateRestoreTestRequest,
  EffectiveBackupPolicy,
  RestoreTest,
  UpdateBackupPolicyRequest,
} from "@cloudbox/contracts";
import { queryOptions } from "@tanstack/react-query";
import { api } from "./client";

export type BackupsFilters = { tenant?: string; state?: string };

function backupsSearchParams(filters: BackupsFilters): string {
  const params = new URLSearchParams();
  if (filters.tenant) params.set("tenant", filters.tenant);
  if (filters.state) params.set("state", filters.state);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const backupsScreenQuery = (filters: BackupsFilters) =>
  queryOptions({
    queryKey: ["screens", "backups", filters],
    queryFn: () => api<BackupsScreen>(`/api/v1/screens/backups${backupsSearchParams(filters)}`),
  });

export const backupDeviceHistoryQuery = (deviceId: string) =>
  queryOptions({
    queryKey: ["screens", "backups", "device", deviceId],
    queryFn: () =>
      api<BackupDeviceHistoryScreen>(`/api/v1/screens/backups/${encodeURIComponent(deviceId)}`),
  });

export const updateBackupPolicy = (tenantId: string, body: UpdateBackupPolicyRequest) =>
  api<{ policy: EffectiveBackupPolicy }>(
    `/api/v1/tenants/${encodeURIComponent(tenantId)}/backup-policy`,
    { method: "PATCH", body: JSON.stringify(body) },
  );

export const createRestoreTest = (body: CreateRestoreTestRequest) =>
  api<{ restoreTest: RestoreTest }>("/api/v1/backups/restore-tests", {
    method: "POST",
    body: JSON.stringify(body),
  });
