// Owner: WT-18. Small pieces shared by the Updates list and detail: coloured pills for `channel`,
// `status` and every device-reported terminal state (master spec §45 — shown as pills, never
// inferred from "downloaded" alone).
import type { ReleaseChannel, ReleaseResultState, ReleaseStatus } from "@cloudbox/contracts";
import { StatusPill, type Tone } from "@/components/status-pill";

const STATUS_TONE: Record<ReleaseStatus, Tone> = {
  draft: "neutral",
  pilot: "info",
  stable: "success",
  withdrawn: "danger",
};

export function ReleaseStatusPill({ status }: { status: ReleaseStatus }) {
  return <StatusPill tone={STATUS_TONE[status]}>{status}</StatusPill>;
}

const CHANNEL_TONE: Record<ReleaseChannel, Tone> = {
  development: "neutral",
  pilot: "info",
  stable: "success",
  pinned: "warning",
};

export function ChannelPill({ channel }: { channel: ReleaseChannel }) {
  return <StatusPill tone={CHANNEL_TONE[channel]}>{channel}</StatusPill>;
}

/** Required terminal states, master spec §45 — every one of these renders distinctly. */
export const RESULT_STATES: ReleaseResultState[] = [
  "assigned",
  "downloaded",
  "verified",
  "installed_healthy",
  "installed_unhealthy",
  "rolled_back",
  "failed_download",
  "failed_validation",
  "deferred_active_users",
  "deferred_maintenance",
];

const RESULT_TONE: Record<ReleaseResultState, Tone> = {
  assigned: "neutral",
  downloaded: "info",
  verified: "info",
  installed_healthy: "success",
  installed_unhealthy: "danger",
  rolled_back: "danger",
  failed_download: "danger",
  failed_validation: "danger",
  deferred_active_users: "warning",
  deferred_maintenance: "warning",
};

export function ResultStatePill({ state }: { state: ReleaseResultState }) {
  return <StatusPill tone={RESULT_TONE[state]}>{state.replace(/_/g, " ")}</StatusPill>;
}

/** Compact per-release summary row: only the states with at least one result, so a fresh release
 * shows nothing rather than ten zero pills. */
export function ResultCountsRow({ counts }: { counts: Record<string, number> }) {
  const present = RESULT_STATES.filter((state) => (counts[state] ?? 0) > 0);
  if (present.length === 0)
    return <span className="text-xs text-muted-foreground">no results yet</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {present.map((state) => (
        <StatusPill key={state} tone={RESULT_TONE[state]}>
          {state.replace(/_/g, " ")} {counts[state]}
        </StatusPill>
      ))}
    </span>
  );
}
