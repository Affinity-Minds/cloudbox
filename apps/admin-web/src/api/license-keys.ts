// Owner: WT-14. Server licence keys (staff console): batches, list, revoke.
import type {
  GenerateLicenseKeysRequest,
  GenerateLicenseKeysResponse,
  LicenseKeysQuery,
  LicenseKeysResponse,
} from "@cloudbox/contracts";
import { queryOptions } from "@tanstack/react-query";
import { api } from "./client";

export const licenseKeysQuery = (filter: LicenseKeysQuery) =>
  queryOptions({
    queryKey: ["license-keys", filter],
    queryFn: () => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(filter)) if (value) params.set(key, value);
      const qs = params.toString();
      return api<LicenseKeysResponse>(`/api/v1/license-keys${qs ? `?${qs}` : ""}`);
    },
  });

/** The plaintext keys come back once, here; the page keeps them only in memory. */
export const generateLicenseKeys = (body: GenerateLicenseKeysRequest) =>
  api<GenerateLicenseKeysResponse>("/api/v1/license-keys/batches", {
    method: "POST",
    body: JSON.stringify(body),
  });

export const revokeLicenseKey = (id: string, reason: string) =>
  api<null>(`/api/v1/license-keys/${encodeURIComponent(id)}/revoke`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });

/** CSV of a generated batch, built client-side from the one response (no second request). */
export function batchCsv(batch: GenerateLicenseKeysResponse): string {
  const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows = batch.keys.map((k) =>
    [k.code, k.last4, batch.planCode, batch.batchLabel, batch.expiresAt ?? ""].map(cell).join(","),
  );
  return `${["key,last4,plan,batch,expires_at", ...rows].join("\n")}\n`;
}
