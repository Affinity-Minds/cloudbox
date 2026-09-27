// Owner: WT-13. Small pieces shared by the Plans table and its create/edit sheet.
import { Currency, type Feature, type PlanStatus } from "@cloudbox/contracts";
import { StatusPill, type Tone } from "@/components/status-pill";

export const CURRENCIES = Currency.options;

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

/**
 * "1 year" for the common case, otherwise "N days" — the field is always stored as days
 * ("Validity" in the UI; the underlying data and API field is still `termDays`).
 */
export function formatTermDays(days: number): string {
  if (days === 365) return "1 year";
  if (days === 30) return "30 days";
  if (days > 0 && days % 365 === 0) return `${days / 365} years`;
  return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * Money formatting (migration 0011, owner addition): `amountMinor` is always minor units (paise,
 * cents, …); `Intl.NumberFormat`'s own currency style places the symbol and decimal correctly per
 * currency, so nothing here is hand-maintained per currency.
 */
export function formatMoney(amountMinor: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).format(amountMinor / 100);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency}`;
  }
}

/** Major-unit string (e.g. "50.00") for a money `<input>`, from minor units. */
export function minorToMajorInput(amountMinor: number): string {
  return (amountMinor / 100).toFixed(2);
}
