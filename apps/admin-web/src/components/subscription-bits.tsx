// Owner: WT-5. Small pieces shared by the Subscriptions list and detail screens.
import type { SubscriptionExpiry, SubscriptionStatus } from "@cloudbox/contracts";
import type * as React from "react";
import { StatusPill, type Tone } from "@/components/status-pill";
import { cn } from "@/lib/utils";

const STATUS_TONE: Record<SubscriptionStatus, Tone> = {
  trial: "info",
  active: "success",
  past_due: "warning",
  suspended: "danger",
  cancelled: "neutral",
};

export function SubscriptionStatusPill({ status }: { status: SubscriptionStatus }) {
  return <StatusPill tone={STATUS_TONE[status]}>{status.replace("_", " ")}</StatusPill>;
}

const EXPIRY: Record<SubscriptionExpiry, { tone: Tone; label: string }> = {
  active: { tone: "success", label: "active" },
  expiring: { tone: "warning", label: "expiring" },
  expired: { tone: "danger", label: "expired" },
  scheduled: { tone: "info", label: "scheduled" },
  inactive: { tone: "neutral", label: "inactive" },
};

/** Expiry pill: expired / expiring (inside the renewal-warning window) / active. */
export function ExpiryPill({
  expiry,
  daysRemaining,
}: {
  expiry: SubscriptionExpiry;
  daysRemaining: number;
}) {
  const { tone, label } = EXPIRY[expiry];
  const suffix =
    expiry === "expired"
      ? ` · ${Math.abs(daysRemaining)} d ago`
      : expiry === "expiring" || expiry === "active"
        ? ` · ${daysRemaining} d`
        : "";
  return (
    <StatusPill tone={tone}>
      {label}
      {suffix}
    </StatusPill>
  );
}

/** Native select styled like shadcn Input (no Select primitive is installed). */
export function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30",
        className,
      )}
      {...props}
    />
  );
}

/** `yyyy-mm-dd` (an `<input type="date">` value) for an ISO timestamp, in UTC. */
export const toDateInput = (iso: string) => iso.slice(0, 10);

/** Midnight UTC of a `yyyy-mm-dd` date input, as ISO. */
export const fromDateInput = (value: string) => new Date(`${value}T00:00:00.000Z`).toISOString();

export function KeyValue({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <table className="w-full text-sm">
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label} className="border-b last:border-b-0">
            <th
              scope="row"
              className="h-8 w-44 px-4 text-left align-middle font-normal text-muted-foreground"
            >
              {label}
            </th>
            <td className="px-2 py-1 align-middle">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
