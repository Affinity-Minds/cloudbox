import { queryOptions } from "@tanstack/react-query";
import { api } from "./client";

export type VersionInfo = {
  service: string;
  gitSha: string;
  builtAt: string;
  environment: string;
};

export const versionQuery = queryOptions({
  queryKey: ["version"],
  queryFn: () => api<VersionInfo>("/api/version"),
  staleTime: 5 * 60_000,
});
