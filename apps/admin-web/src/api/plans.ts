// Owner: WT-13. Plan designer + the active-plans picker (plan-select.tsx) share this module.
import type { CreatePlanRequest, Plan, PlansScreen, UpdatePlanRequest } from "@cloudbox/contracts";
import { queryOptions } from "@tanstack/react-query";
import { api, type ReasonRequestBody } from "./client";

/** Plan designer table: every plan (active + retired), with subscription counts. */
export const plansScreenQuery = queryOptions({
  queryKey: ["screens", "plans"],
  queryFn: () => api<PlansScreen>("/api/v1/screens/plans"),
});

/** The plan picker (tenant sheet, new-subscription dialog): active plans only, cached. */
export const activePlansQuery = queryOptions({
  queryKey: ["plans", "active"],
  queryFn: () => api<{ items: Plan[] }>("/api/v1/plans").then((body) => body.items),
  staleTime: 60_000,
});

export const createPlan = (input: CreatePlanRequest) =>
  api<{ plan: Plan }>("/api/v1/plans", { method: "POST", body: JSON.stringify(input) }).then(
    (body) => body.plan,
  );

export const updatePlan = (code: string, input: UpdatePlanRequest) =>
  api<{ plan: Plan }>(`/api/v1/plans/${encodeURIComponent(code)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  }).then((body) => body.plan);

export const retirePlan = (code: string, body: ReasonRequestBody) =>
  api<{ plan: Plan; subscriptionCount: number }>(
    `/api/v1/plans/${encodeURIComponent(code)}/retire`,
    { method: "POST", body: JSON.stringify(body) },
  );

export const reactivatePlan = (code: string) =>
  api<{ plan: Plan; subscriptionCount: number }>(
    `/api/v1/plans/${encodeURIComponent(code)}/reactivate`,
    { method: "POST" },
  );
