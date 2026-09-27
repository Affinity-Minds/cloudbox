// Owner: WT-15. Portal Home: the Tenant ID prominently (people give this to their team, CloudBox
// Connect and Setup ask for it), the plan-state banner (as built by WT-14's TenantCards), and quick
// counts. A member of several tenants switches with the shell's own switcher; when nobody has an
// active tenant yet (fresh sign-up with no membership), fall back to WT-2's tenant list/pick UI.
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, Copy, Server, Users } from "lucide-react";
import { useState } from "react";
import { portalHomeQuery } from "@/api/portal";
import { myTenantsQuery } from "@/api/tenants";
import { ErrorState, PageHeader } from "@/components/page";
import { StatusPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TenantSwitchList } from "./portal-page";
import { RequireActiveTenant, useActiveTenantId } from "./require-active-tenant";

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

function QuickCount({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Server;
  label: string;
  value: number;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border p-4">
      <Icon className="size-5 text-muted-foreground" />
      <div>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        <div className="text-xs text-muted-foreground">{label}</div>
      </div>
    </div>
  );
}

function TenantHome({ tenantId }: { tenantId: string }) {
  const home = useQuery(portalHomeQuery(tenantId));

  if (home.isPending) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-28 w-full" />
        <div className="grid grid-cols-2 gap-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      </div>
    );
  }
  if (home.isError) return <ErrorState error={home.error} onRetry={() => home.refetch()} />;

  const { tenant, plan, counts } = home.data;
  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-lg border p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs text-muted-foreground">Tenant ID · give this to your team</div>
            <div className="font-mono text-3xl font-semibold tracking-wide">
              {tenant.publicCode}
            </div>
          </div>
          <CopyCode code={tenant.publicCode} />
        </div>
        {plan.state === "active" ? (
          <div className="flex items-center gap-2 text-sm">
            <StatusPill tone="success">active</StatusPill>
            <span>
              {plan.planName ?? plan.planCode}
              {plan.validUntil ? ` · until ${plan.validUntil.slice(0, 10)}` : null}
            </span>
          </div>
        ) : plan.state === "pending_activation" ? (
          <div className="flex items-center gap-2 text-sm">
            <StatusPill tone="info">pending activation</StatusPill>
            <span>
              {plan.planName ?? plan.planCode} starts when your first server is activated.
            </span>
          </div>
        ) : (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-amber-600/30 bg-amber-500/10 px-3 py-2 text-sm"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <span>
              {home.data.standing === "user"
                ? "This organisation has no active plan yet. Ask an Owner or Admin."
                : (plan.message ?? "No active plan found. Please contact the CloudBox admin.")}
            </span>
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <QuickCount icon={Server} label="CloudBoxes" value={counts.devices} />
        <QuickCount icon={Users} label="Members" value={counts.members} />
      </div>
    </div>
  );
}

export function HomePage() {
  const { tenantId } = useActiveTenantId();
  const tenants = useQuery(myTenantsQuery);
  // The full switch list earns its place only when there's a real choice to make: no active
  // tenant yet (first sign-in) or more than one membership. The shell's header switcher already
  // covers the common "just move between them" case once an active tenant exists.
  const showSwitchList = !tenantId || (tenants.data?.length ?? 0) > 1;

  return (
    <>
      <PageHeader title="Home" />
      <div className="pt-4">
        <RequireActiveTenant>{(id) => <TenantHome tenantId={id} />}</RequireActiveTenant>
      </div>
      {showSwitchList ? (
        <div className="pt-8">
          <PageHeader title="Your organisations" description="Pick which one you're working in." />
          <TenantSwitchList />
        </div>
      ) : null}
    </>
  );
}
