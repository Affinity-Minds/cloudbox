// Owner: WT-19. Small pieces shared by the Backups list and device history drawer.
import type { BackupJobState, RetentionClass } from "@cloudbox/contracts";
import { StatusPill, type Tone } from "@/components/status-pill";

const STATE_TONE: Record<BackupJobState, Tone> = {
  created: "neutral",
  verified_local: "info",
  upload_started: "info",
  upload_completed: "info",
  cloud_verified: "success",
  retention_applied: "success",
  failed: "danger",
};

export function BackupStatePill({ state }: { state: BackupJobState | null }) {
  if (!state) return <StatusPill tone="neutral">No backups yet</StatusPill>;
  return <StatusPill tone={STATE_TONE[state]}>{state.replaceAll("_", " ")}</StatusPill>;
}

const RETENTION_LABEL: Record<RetentionClass, string> = {
  recent: "Recent",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  yearly: "Yearly",
};

export function RetentionClassPill({ retentionClass }: { retentionClass: RetentionClass | null }) {
  if (!retentionClass) return <StatusPill tone="neutral">—</StatusPill>;
  return <StatusPill tone="info">{RETENTION_LABEL[retentionClass]}</StatusPill>;
}

export function OverduePill({ overdue }: { overdue: boolean }) {
  return overdue ? (
    <StatusPill tone="warning">Overdue</StatusPill>
  ) : (
    <StatusPill tone="success">On schedule</StatusPill>
  );
}

/** Binary, one decimal place: `formatBytes(1536)` → `"1.5 KB"`. `null` → "—" (never "0 B"). */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${exponent === 0 ? value : value.toFixed(1)} ${units[exponent]}`;
}
