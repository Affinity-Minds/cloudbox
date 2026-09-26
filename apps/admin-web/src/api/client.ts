// Owner: WT-0. Every API call goes through api(); modules add api/<module>.ts next to this file.
import type { ErrorBody } from "@cloudbox/contracts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly detail?: unknown,
  ) {
    super(`${status} ${error}`);
    this.name = "ApiError";
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers, credentials: "include" });
  } catch (cause) {
    throw new ApiError(0, "network_error", cause instanceof Error ? cause.message : undefined);
  }

  const body: unknown = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const error = (body ?? {}) as Partial<ErrorBody>;
    throw new ApiError(
      response.status,
      typeof error.error === "string" ? error.error : `http_${response.status}`,
      error.detail,
    );
  }
  return body as T;
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError)
    return error.status ? `${error.status} ${error.error}` : error.error;
  return error instanceof Error ? error.message : "unknown_error";
}
