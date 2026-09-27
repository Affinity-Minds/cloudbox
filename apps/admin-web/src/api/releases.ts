// Owner: WT-18. Releases, assignments and device-reported results. Upload is multipart, so it
// bypasses `api()`'s default JSON content-type with its own small fetch wrapper — same error shape,
// same `credentials: "include"`.
import type {
  CreateAssignmentRequest,
  PromoteReleaseRequest,
  Release,
  ReleaseAssignment,
  ReleaseChannel,
  ReleaseComponent,
  ReleaseDetailScreen,
  ReleasesScreen,
  WithdrawReleaseRequest,
} from "@cloudbox/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ApiError, api } from "./client";

export const releasesQuery = queryOptions({
  queryKey: ["screens", "releases"],
  queryFn: () => api<ReleasesScreen>("/api/v1/screens/releases"),
});

export const releaseDetailQuery = (id: string) =>
  queryOptions({
    queryKey: ["screens", "releases", id],
    queryFn: () => api<ReleaseDetailScreen>(`/api/v1/screens/releases/${encodeURIComponent(id)}`),
  });

export type UploadReleaseInput = {
  file: File;
  component: ReleaseComponent;
  version: string;
  channel: ReleaseChannel;
  minAgentVersion?: string;
  rollbackOf?: string;
  notes?: string;
};

/** `fetch` directly (not `api()`): a `FormData` body needs the browser's own multipart
 * `Content-Type`, which `api()` would overwrite with `application/json`. */
export async function uploadRelease(input: UploadReleaseInput): Promise<{ release: Release }> {
  const form = new FormData();
  form.set("file", input.file);
  form.set("component", input.component);
  form.set("version", input.version);
  form.set("channel", input.channel);
  if (input.minAgentVersion) form.set("minAgentVersion", input.minAgentVersion);
  if (input.rollbackOf) form.set("rollbackOf", input.rollbackOf);
  if (input.notes) form.set("notes", input.notes);

  let response: Response;
  try {
    response = await fetch("/api/v1/releases", {
      method: "POST",
      body: form,
      credentials: "include",
      headers: { accept: "application/json" },
    });
  } catch (cause) {
    throw new ApiError(0, "network_error", cause instanceof Error ? cause.message : undefined);
  }
  const body: unknown = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const error = (body ?? {}) as { error?: string; detail?: unknown };
    throw new ApiError(response.status, error.error ?? `http_${response.status}`, error.detail);
  }
  return body as { release: Release };
}

const post = <T>(path: string, body: unknown, method = "POST") =>
  api<T>(path, { method, body: JSON.stringify(body) });

export const promoteRelease = (id: string, body: PromoteReleaseRequest) =>
  post<{ release: Release }>(`/api/v1/releases/${encodeURIComponent(id)}/promote`, body);

export const withdrawRelease = (id: string, body: WithdrawReleaseRequest) =>
  post<{ release: Release }>(`/api/v1/releases/${encodeURIComponent(id)}/withdraw`, body);

export const createAssignment = (releaseId: string, body: CreateAssignmentRequest) =>
  post<{ assignment: ReleaseAssignment }>(
    `/api/v1/releases/${encodeURIComponent(releaseId)}/assignments`,
    body,
  );

export const deleteAssignment = (releaseId: string, assignmentId: string) =>
  api<void>(
    `/api/v1/releases/${encodeURIComponent(releaseId)}/assignments/${encodeURIComponent(assignmentId)}`,
    { method: "DELETE" },
  );
