// Owner: WT-15. The staff screen (ops console, Govern). Uses WT-1's existing
// `GET/POST/DELETE /api/v1/staff`; `POST` also resets an existing member's password (Reset).
import type { CreateStaffRequest, StaffMember } from "@cloudbox/contracts";
import { queryOptions } from "@tanstack/react-query";
import { api } from "./client";

export const staffQuery = queryOptions({
  queryKey: ["staff"],
  queryFn: () => api<{ items: StaffMember[] }>("/api/v1/staff"),
});

/** Create (email not yet staff) or change a role / reset a password (existing email). */
export const upsertStaff = (body: CreateStaffRequest) =>
  api<StaffMember>("/api/v1/staff", { method: "POST", body: JSON.stringify(body) });

export const revokeStaff = (userId: string, reason?: string) =>
  api<void>(`/api/v1/staff/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    body: reason ? JSON.stringify({ reason }) : undefined,
  });
