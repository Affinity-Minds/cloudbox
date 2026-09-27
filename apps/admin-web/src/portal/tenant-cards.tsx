// Owner: WT-14. Portal tenant cards (ADR 0011): the Tenant ID people give their team (CloudBox
// Connect and Setup ask for it) and the plan state, with the "no active plan" message for Owners.
import type { OnboardingTenant } from "@cloudbox/contracts";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, Copy, Plus } from "lucide-react";
import { useState } from "react";
import { onboardingOverviewQuery } from "@/api/onboarding";
import { ErrorState } from "@/components/page";
import { StatusPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

function CopyCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={async () => {
        await navigator.clipboard.writeText(code).catch(() => undefined);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check /> : <Copy />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function PlanLine({ tenant }: { tenant: OnboardingTenant }) {
  const { plan } = tenant;
  if (plan.state === "active") {
    return (
      <div className="flex items-center gap-2 text-sm">
        <StatusPill tone="success">active</StatusPill>
        <span>
          {plan.planName ?? plan.planCode} · until {plan.validUntil?.slice(0, 10)}
        </span>
      </div>
    );
  }
  if (plan.state === "pending_activation") {
    return (
      <div className="flex items-center gap-2 text-sm">
        <StatusPill tone="info">pending activation</StatusPill>
        <span>{plan.planName ?? plan.planCode} starts when your first server is activated.</span>
      </div>
    );
  }
  // Owners and Admins are the ones who can act on it; everyone sees the state.
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-amber-600/30 bg-amber-500/10 px-3 py-2 text-sm"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
      <span>
        {tenant.standing === "user"
          ? "This organisation has no active plan yet."
          : (plan.message ?? "No active plan found. Please contact the CloudBox admin.")}
      </span>
    </div>
  );
}

export function TenantCards() {
  const overview = useQuery(onboardingOverviewQuery);
  if (overview.isPending) {
    return (
      <div className="space-y-2 border-x border-b p-4">
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (overview.isError) {
    return (
      <div className="border-x border-b">
        <ErrorState error={overview.error} onRetry={() => overview.refetch()} />
      </div>
    );
  }
  return (
    <div className="border-x border-b">
      {overview.data.tenants.map((tenant) => (
        <section key={tenant.tenantId} className="space-y-3 border-b p-4 last:border-b-0">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="font-medium">{tenant.displayName}</h2>
            <span className="text-xs text-muted-foreground">
              {tenant.standing} · {tenant.enrolledDevices} server
              {tenant.enrolledDevices === 1 ? "" : "s"}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md bg-muted px-3 py-2">
            <div>
              <div className="text-xs text-muted-foreground">
                Tenant ID · give this to your team
              </div>
              <div className="font-mono text-2xl font-semibold tracking-wide">
                {tenant.tenantCode}
              </div>
            </div>
            <CopyCode code={tenant.tenantCode} />
          </div>
          <PlanLine tenant={tenant} />
          {tenant.heldDevices ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-red-600/30 bg-red-500/10 px-3 py-2 text-sm"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-600" />
              <span>
                {tenant.heldDevices === 1
                  ? "1 server's licence was revoked by CloudBox."
                  : `${tenant.heldDevices} servers' licences were revoked by CloudBox.`}{" "}
                Contact the CloudBox admin.
              </span>
            </div>
          ) : null}
        </section>
      ))}
      <div className="flex items-center justify-between gap-2 p-4 text-sm">
        <span className="text-muted-foreground">
          {overview.data.tenants.length === 0
            ? "You are not in any organisation yet."
            : "Setting up another organisation?"}
        </span>
        <Button asChild size="sm" variant="outline">
          <a href="/start">
            <Plus />
            New organisation
          </a>
        </Button>
      </div>
    </div>
  );
}
