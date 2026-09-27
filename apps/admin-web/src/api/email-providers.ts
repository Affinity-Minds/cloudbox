// Owner: WT-12. `/api/v1/settings/email-providers`. The SMTP password is write-only: `hasSecret`
// on the response tells the UI whether one is set, never its value.
import type {
  CreateEmailProviderRequest,
  EmailProvider,
  TestEmailProviderResponse,
  UpdateEmailProviderRequest,
} from "@cloudbox/contracts";
import { queryOptions } from "@tanstack/react-query";
import { api, type ReasonRequestBody } from "./client";

const BASE = "/api/v1/settings/email-providers";

export const emailProvidersQuery = queryOptions({
  queryKey: ["settings", "email-providers"],
  queryFn: () => api<{ items: EmailProvider[] }>(BASE),
});

export const createEmailProvider = (body: CreateEmailProviderRequest) =>
  api<EmailProvider>(BASE, { method: "POST", body: JSON.stringify(body) });

export const updateEmailProvider = (id: string, body: UpdateEmailProviderRequest) =>
  api<EmailProvider>(`${BASE}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });

export const deleteEmailProvider = (id: string, body: ReasonRequestBody) =>
  api<void>(`${BASE}/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: JSON.stringify(body),
  });

export const testEmailProvider = (id: string) =>
  api<TestEmailProviderResponse>(`${BASE}/${encodeURIComponent(id)}/test`, { method: "POST" });
