// Owner: WT-5. Subscriptions, plans and entitlement actions. The entitlement token never reaches
// the browser: issue/renew return the record and the signed (non-secret) claims only.
import type {
  CreateSubscriptionRequest,
  IssueEntitlementRequest,
  IssueEntitlementResponse,
  RevokeEntitlementRequest,
  RevokeEntitlementResponse,
  Subscription,
  SubscriptionDetailScreen,
  SubscriptionsScreen,
  UpdateSubscriptionRequest,
} from "@cloudbox/contracts";
import { queryOptions } from "@tanstack/react-query";
import { api } from "./client";

export const subscriptionsQuery = queryOptions({
  queryKey: ["screens", "subscriptions"],
  queryFn: () => api<SubscriptionsScreen>("/api/v1/screens/subscriptions"),
});

export const subscriptionDetailQuery = (id: string) =>
  queryOptions({
    queryKey: ["screens", "subscriptions", id],
    queryFn: () =>
      api<SubscriptionDetailScreen>(`/api/v1/screens/subscriptions/${encodeURIComponent(id)}`),
  });

const post = <T>(path: string, body: unknown, method = "POST") =>
  api<T>(path, { method, body: JSON.stringify(body) });

export const createSubscription = (
  tenantId: string,
  body: Omit<CreateSubscriptionRequest, "status"> & {
    status?: CreateSubscriptionRequest["status"];
  },
) =>
  post<{ subscription: Subscription }>(
    `/api/v1/tenants/${encodeURIComponent(tenantId)}/subscriptions`,
    body,
  );

export const updateSubscription = (id: string, body: UpdateSubscriptionRequest) =>
  post<{ subscription: Subscription }>(
    `/api/v1/subscriptions/${encodeURIComponent(id)}`,
    body,
    "PATCH",
  );

export type EntitlementAction = "issue" | "renew";

export const issueEntitlement = (
  deviceId: string,
  action: EntitlementAction,
  body: IssueEntitlementRequest,
) =>
  post<IssueEntitlementResponse>(
    `/api/v1/devices/${encodeURIComponent(deviceId)}/entitlements/${action}`,
    body,
  );

export const revokeEntitlement = (deviceId: string, body: RevokeEntitlementRequest) =>
  post<RevokeEntitlementResponse>(
    `/api/v1/devices/${encodeURIComponent(deviceId)}/entitlements/revoke`,
    body,
  );
