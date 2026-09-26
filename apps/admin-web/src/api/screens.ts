import type { AuditScreen, OverviewScreen } from "@cloudbox/contracts";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { api } from "./client";

export const overviewQuery = queryOptions({
  queryKey: ["screens", "overview"],
  queryFn: () => api<OverviewScreen>("/api/v1/screens/overview"),
});

const AUDIT_PAGE_SIZE = 50;

export const auditQuery = infiniteQueryOptions({
  queryKey: ["screens", "audit"],
  initialPageParam: null as string | null,
  queryFn: ({ pageParam }) => {
    const params = new URLSearchParams({ limit: String(AUDIT_PAGE_SIZE) });
    if (pageParam) params.set("cursor", pageParam);
    return api<AuditScreen>(`/api/v1/screens/audit?${params}`);
  },
  getNextPageParam: (last) => last.nextCursor,
});
