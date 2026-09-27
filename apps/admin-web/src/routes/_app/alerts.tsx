// Owner: WT-17. Alerts: one screen request (/api/v1/screens/alerts). Operational table answering
// "what is broken now" (spec §44): severity pill, category, tenant, device, opened, last seen,
// status, acknowledge/resolve actions.
import {
  ALERT_CATEGORY_LABEL,
  type Alert,
  type AlertSeverity,
  type AlertStatus,
} from "@cloudbox/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import { Check, CircleCheck, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { acknowledgeAlert, alertsQuery, resolveAlert } from "@/api/alerts";
import { describeError } from "@/api/client";
import { EmptyState, ErrorState, PageHeader } from "@/components/page";
import { StatusPill, type Tone } from "@/components/status-pill";
import { NativeSelect } from "@/components/subscription-bits";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatAgo, formatTimestamp } from "@/lib/time";

export const Route = createFileRoute("/_app/alerts")({
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(alertsQuery({}));
  },
  component: AlertsPage,
});

const SEVERITY_TONE: Record<AlertSeverity, Tone> = {
  critical: "danger",
  warning: "warning",
  info: "info",
};

const STATUS_TONE: Record<AlertStatus, Tone> = {
  open: "danger",
  acknowledged: "info",
  resolved: "neutral",
};

function SeverityPill({ severity }: { severity: AlertSeverity }) {
  return <StatusPill tone={SEVERITY_TONE[severity]}>{severity}</StatusPill>;
}

function StatusBadge({ status }: { status: AlertStatus }) {
  return <StatusPill tone={STATUS_TONE[status]}>{status}</StatusPill>;
}

const features = tableFeatures({});
const column = createColumnHelper<typeof features, Alert>();

function AlertsPage() {
  const [status, setStatus] = useState("");
  const [severity, setSeverity] = useState("");
  const [tenant, setTenant] = useState("");
  const queryClient = useQueryClient();

  const query = useQuery(
    alertsQuery({
      status: status || undefined,
      severity: severity || undefined,
      tenant: tenant || undefined,
    }),
  );

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["screens", "alerts"] });

  const acknowledge = useMutation({
    mutationFn: acknowledgeAlert,
    onSuccess: invalidate,
    onError: (error) => toast.error(`Could not acknowledge: ${describeError(error)}`),
  });
  const resolve = useMutation({
    mutationFn: resolveAlert,
    onSuccess: invalidate,
    onError: (error) => toast.error(`Could not resolve: ${describeError(error)}`),
  });

  const columns = column.columns([
    column.display({
      id: "severity",
      header: "Severity",
      cell: ({ row }) => <SeverityPill severity={row.original.severity} />,
    }),
    column.display({
      id: "category",
      header: "Category",
      cell: ({ row }) => (
        <span className="font-medium">{ALERT_CATEGORY_LABEL[row.original.category]}</span>
      ),
    }),
    column.display({
      id: "tenant",
      header: "Tenant",
      cell: ({ row }) =>
        row.original.tenantId ? (
          <span className="flex min-w-0 items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">
              {row.original.tenantCode}
            </span>
            <span className="truncate">{row.original.tenantName}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    }),
    column.display({
      id: "device",
      header: "Device",
      cell: ({ row }) =>
        row.original.deviceId ? (
          <span className="truncate font-mono text-xs">
            {row.original.deviceName ?? row.original.deviceId}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    }),
    column.accessor("openedAt", {
      header: "Opened",
      cell: (info) => (
        <span className="whitespace-nowrap text-xs" title={formatTimestamp(info.getValue())}>
          {formatAgo(info.getValue())}
        </span>
      ),
    }),
    column.accessor("lastSeenAt", {
      header: "Last seen",
      cell: (info) => (
        <span className="whitespace-nowrap text-xs">{formatAgo(info.getValue())}</span>
      ),
    }),
    column.display({
      id: "status",
      header: "Status",
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    }),
    column.display({
      id: "actions",
      header: "",
      cell: ({ row }) => {
        const alert = row.original;
        if (alert.status === "resolved") return null;
        return (
          <div className="flex justify-end gap-1">
            {alert.status === "open" ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => acknowledge.mutate(alert.id)}
                disabled={acknowledge.isPending}
                title="Acknowledge"
              >
                <Check />
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              onClick={() => resolve.mutate(alert.id)}
              disabled={resolve.isPending}
              title="Resolve"
            >
              <CircleCheck />
            </Button>
          </div>
        );
      },
    }),
  ]);

  const items = query.data?.items ?? [];
  const table = useTable({ features, columns, data: items, getRowId: (row) => row.id });
  const tenantOptions = [
    ...new Map(items.filter((a) => a.tenantId).map((a) => [a.tenantId as string, a])).values(),
  ];

  return (
    <>
      <PageHeader
        title="Alerts"
        description="Stateful alert records, deduplicated per condition. What is broken now."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw className={query.isFetching ? "animate-spin" : undefined} />
            Refresh
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <NativeSelect
          className="w-40"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="">All statuses</option>
          <option value="open">Open</option>
          <option value="acknowledged">Acknowledged</option>
          <option value="resolved">Resolved</option>
        </NativeSelect>
        <NativeSelect
          className="w-40"
          value={severity}
          onChange={(event) => setSeverity(event.target.value)}
        >
          <option value="">All severities</option>
          <option value="critical">Critical</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
        </NativeSelect>
        {tenantOptions.length > 1 ? (
          <NativeSelect
            className="w-52"
            value={tenant}
            onChange={(event) => setTenant(event.target.value)}
          >
            <option value="">All tenants</option>
            {tenantOptions.map((a) => (
              <option key={a.tenantId} value={a.tenantId ?? ""}>
                {a.tenantCode} · {a.tenantName}
              </option>
            ))}
          </NativeSelect>
        ) : null}
      </div>

      {query.isSuccess ? (
        <div className="flex h-9 items-center gap-4 border-b px-4 text-xs text-muted-foreground">
          <span>{query.data.facets.open} open</span>
          <span>{query.data.facets.acknowledged} acknowledged</span>
          {query.data.facets.critical ? (
            <span className="text-red-600 dark:text-red-400">
              {query.data.facets.critical} critical
            </span>
          ) : null}
          {query.data.facets.warning ? (
            <span className="text-amber-600 dark:text-amber-400">
              {query.data.facets.warning} warning
            </span>
          ) : null}
        </div>
      ) : null}

      {query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : (
        <Table className="text-sm">
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id}>
                {group.headers.map((header) => (
                  <TableHead key={header.id} className="h-8 px-3 text-xs first:pl-4">
                    <table.FlexRender header={header} />
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {query.isPending
              ? Array.from({ length: 6 }, (_, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton rows
                  <TableRow key={i}>
                    {columns.map((_c, j) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton cells
                      <TableCell key={j} className="h-8 px-3 first:pl-4">
                        <Skeleton className="h-4 w-full" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getAllCells().map((cell) => (
                      <TableCell key={cell.id} className="h-9 px-3 py-1 first:pl-4">
                        <table.FlexRender cell={cell} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      )}

      {query.isSuccess && items.length === 0 ? (
        <EmptyState>
          Nothing open. Alerts appear here once the evaluator (every 5 minutes) finds a device
          offline, a license expiring, or a health signal out of range — see the{" "}
          <Link to="/settings" className="underline">
            Settings
          </Link>{" "}
          page to add staff email recipients.
        </EmptyState>
      ) : null}
    </>
  );
}
