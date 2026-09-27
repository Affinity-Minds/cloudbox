// Owner: WT-13. Small pieces shared by the Plans table and its create/edit sheet.
import type { Feature, PlanStatus } from "@cloudbox/contracts";
import { StatusPill, type Tone } from "@/components/status-pill";

const STATUS_TONE: Record<PlanStatus, Tone> = { active: "success", retired: "neutral" };

export function PlanStatusPill({ status }: { status: PlanStatus }) {
  return <StatusPill tone={STATUS_TONE[status]}>{status}</StatusPill>;
}

const FEATURE_LABEL: Record<Feature, string> = {
  remote_access: "Remote access",
  managed_backup: "Managed backup",
  fleet: "Fleet",
};

export function FeaturePill({ feature }: { feature: Feature }) {
  return <StatusPill tone="info">{FEATURE_LABEL[feature] ?? feature}</StatusPill>;
}

/** "1 year" for the common case, otherwise "N days" — the field is always stored as days. */
export function formatTermDays(days: number): string {
  if (days === 365) return "1 year";
  if (days === 30) return "30 days";
  if (days > 0 && days % 365 === 0) return `${days / 365} years`;
  return `${days} day${days === 1 ? "" : "s"}`;
}
