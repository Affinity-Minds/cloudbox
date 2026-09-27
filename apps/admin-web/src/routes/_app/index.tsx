// Owner: WT-0. Overview: one screen request (/api/v1/screens/overview); build info shares the
// sidebar's cached /api/version query.
import type { OverviewScreen } from "@cloudbox/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { overviewQuery } from "@/api/screens";
import { versionQuery } from "@/api/system";
import { EmptyState, ErrorState, PageHeader, Section } from "@/components/page";
import { StatusPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatAgo, formatTimestamp } from "@/lib/time";

export const Route = createFileRoute("/_app/")({
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(overviewQuery);
  },
  component: OverviewPage,
});

type Stat = {
  label: string;
  to: "/tenants" | "/fleet" | "/subscriptions" | "/audit" | "/alerts";
  value: (o: OverviewScreen) => number;
  detail: (o: OverviewScreen) => string;
};

const STATS: Stat[] = [
  {
    label: "Tenants",
    to: "/tenants",
    value: (o) => o.tenants.total,
    detail: (o) => `${o.tenants.active} active`,
  },
  {
    label: "Devices",
    to: "/fleet",
    value: (o) => o.devices.total,
    detail: (o) => `${o.devices.enrolled} enrolled`,
  },
  {
    label: "Subscriptions",
    to: "/subscriptions",
    value: (o) => o.subscriptions.total,
    detail: (o) => `${o.subscriptions.active} active`,
  },
  {
    label: "Audit events",
    to: "/audit",
    value: (o) => o.audit.total,
    detail: (o) => `last ${formatAgo(o.audit.lastEventAt)}`,
  },
  {
    label: "Open alerts",
    to: "/alerts",
    value: (o) => o.alerts.open,
    detail: (o) => (o.alerts.critical > 0 ? `${o.alerts.critical} critical` : "none critical"),
  },
];

function OverviewPage() {
  const overview = useQuery(overviewQuery);
  const version = useQuery(versionQuery);
  const data = overview.data;
  const empty = data && data.tenants.total === 0 && data.devices.total === 0;

  return (
    <>
      <PageHeader
        title="Overview"
        description="Control-plane totals from D1. Counts are live; nothing here is estimated."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => overview.refetch()}
            disabled={overview.isFetching}
          >
            <RefreshCw className={overview.isFetching ? "animate-spin" : undefined} />
            Refresh
          </Button>
        }
      />

      <Section
        title="Totals"
        meta={
          overview.dataUpdatedAt
            ? `as of ${formatTimestamp(new Date(overview.dataUpdatedAt).toISOString())}`
            : null
        }
      >
        {overview.isError ? (
          <ErrorState error={overview.error} onRetry={() => overview.refetch()} />
        ) : (
          <dl className="grid grid-cols-2 border-t md:grid-cols-5">
            {STATS.map((stat) => (
              <div
                key={stat.label}
                className="border-r border-b px-4 py-3 last:border-r-0 md:border-b-0"
              >
                <dt className="text-xs text-muted-foreground">
                  <Link to={stat.to} className="hover:text-foreground hover:underline">
                    {stat.label}
                  </Link>
                </dt>
                <dd className="mt-1 flex items-baseline gap-2">
                  {data ? (
                    <>
                      <span className="text-2xl font-semibold tabular-nums">
                        {stat.value(data)}
                      </span>
                      <span className="text-xs text-muted-foreground">{stat.detail(data)}</span>
                    </>
                  ) : (
                    <Skeleton className="h-8 w-24" />
                  )}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {empty ? (
          <EmptyState>
            No tenants or devices yet. Tenants are created from the Tenants section and devices
            appear after an agent redeems an enrollment token.
          </EmptyState>
        ) : null}
      </Section>

      <Section title="Control plane">
        {version.isError ? (
          <ErrorState error={version.error} onRetry={() => version.refetch()} />
        ) : (
          <table className="w-full border-t text-sm">
            <tbody className="[&_td]:h-8 [&_td]:border-b [&_td]:px-4 [&_th]:h-8 [&_th]:w-48 [&_th]:border-b [&_th]:px-4 [&_th]:text-left [&_th]:font-normal [&_th]:text-muted-foreground">
              <tr>
                <th scope="row">API</th>
                <td>
                  <StatusPill tone={overview.isError ? "danger" : data ? "success" : "neutral"}>
                    {overview.isError ? "unreachable" : data ? "reachable" : "checking"}
                  </StatusPill>
                </td>
              </tr>
              <tr>
                <th scope="row">Environment</th>
                <td className="font-mono text-xs">{version.data?.environment ?? "…"}</td>
              </tr>
              <tr>
                <th scope="row">Build</th>
                <td className="font-mono text-xs">{version.data?.gitSha ?? "…"}</td>
              </tr>
              <tr>
                <th scope="row">Built at</th>
                <td className="font-mono text-xs">{version.data?.builtAt ?? "…"}</td>
              </tr>
            </tbody>
          </table>
        )}
      </Section>
    </>
  );
}
