// Owner: WT-19. Backups: one screen request (/api/v1/screens/backups). Master spec §46 "focus on
// exceptions" — real counts only, primary table `Tenant | Device | Last local backup | Last cloud
// backup | Verify | Retention | State`, a row opens the history drawer (child route).
import type { BackupsScreenRow } from "@cloudbox/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { backupsScreenQuery } from "@/api/backups";
import { BackupStatePill, OverduePill, RetentionClassPill } from "@/components/backup-bits";
import { EmptyState, ErrorState, PageHeader } from "@/components/page";
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

export const Route = createFileRoute("/_app/backups")({
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(backupsScreenQuery({}));
  },
  component: BackupsPage,
});

const features = tableFeatures({});
const column = createColumnHelper<typeof features, BackupsScreenRow>();

const columns = column.columns([
  column.display({
    id: "tenant",
    header: "Tenant",
    cell: ({ row }) => (
      <span className="flex min-w-0 items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground">{row.original.tenantCode}</span>
        <span className="truncate">{row.original.tenantName}</span>
      </span>
    ),
  }),
  column.accessor("deviceName", { header: "Device" }),
  column.accessor("lastLocalBackupAt", {
    header: "Last local backup",
    cell: (info) => (
      <span className="whitespace-nowrap text-xs" title={formatTimestamp(info.getValue())}>
        {formatAgo(info.getValue())}
      </span>
    ),
  }),
  column.accessor("lastCloudBackupAt", {
    header: "Last cloud backup",
    cell: (info) => (
      <span className="whitespace-nowrap text-xs" title={formatTimestamp(info.getValue())}>
        {formatAgo(info.getValue())}
      </span>
    ),
  }),
  column.display({
    id: "verify",
    header: "Verify",
    cell: ({ row }) => <OverduePill overdue={row.original.verifyOverdue} />,
  }),
  column.display({
    id: "retention",
    header: "Retention",
    cell: ({ row }) => <RetentionClassPill retentionClass={row.original.latestRetentionClass} />,
  }),
  column.display({
    id: "state",
    header: "State",
    cell: ({ row }) => <BackupStatePill state={row.original.state} />,
  }),
]);

function BackupsPage() {
  const [tenant, setTenant] = useState("");
  const navigate = useNavigate();
  const query = useQuery(backupsScreenQuery({ tenant: tenant || undefined }));
  const items = query.data?.items ?? [];
  const table = useTable({ features, columns, data: items, getRowId: (row) => row.deviceId });
  const tenants = query.data?.tenants ?? [];
  const open = (deviceId: string) => navigate({ to: "/backups/$deviceId", params: { deviceId } });

  return (
    <>
      <PageHeader
        title="Backups"
        description="Offsite backup jobs, cloud verification and retention, by device."
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

      {query.isSuccess ? (
        <div className="grid grid-cols-2 gap-3 border-b p-4 sm:grid-cols-4">
          <ExceptionCard label="Devices protected" value={query.data.exceptions.devicesProtected} />
          <ExceptionCard
            label="Devices overdue"
            value={query.data.exceptions.devicesOverdue}
            warn={query.data.exceptions.devicesOverdue > 0}
          />
          <ExceptionCard
            label="Failed jobs (24h)"
            value={query.data.exceptions.failedJobsLast24h}
            warn={query.data.exceptions.failedJobsLast24h > 0}
          />
          <ExceptionCard
            label="Restore verification overdue"
            value={query.data.exceptions.restoreVerificationOverdue}
            warn={query.data.exceptions.restoreVerificationOverdue > 0}
          />
        </div>
      ) : null}

      {tenants.length > 1 ? (
        <div className="flex items-center gap-2 border-b px-4 py-2">
          <NativeSelect
            className="w-52"
            value={tenant}
            onChange={(event) => setTenant(event.target.value)}
          >
            <option value="">All tenants</option>
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.publicCode} · {t.displayName}
              </option>
            ))}
          </NativeSelect>
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
                  <TableRow key={`skeleton-${i.toString()}`}>
                    {columns.map((_c, j) => (
                      <TableCell key={`cell-${j.toString()}`} className="h-8 px-3 first:pl-4">
                        <Skeleton className="h-4 w-full" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : table.getRowModel().rows.map((row) => (
                  <TableRow
                    key={row.id}
                    className="cursor-pointer"
                    tabIndex={0}
                    onClick={() => open(row.original.deviceId)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        open(row.original.deviceId);
                      }
                    }}
                  >
                    {row.getAllCells().map((cell) => (
                      <TableCell key={cell.id} className="h-8 px-3 py-1 first:pl-4">
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
          No devices with backup history yet. Backups appear here once a device's Agent creates its
          first backup job.
        </EmptyState>
      ) : null}

      <Outlet />
    </>
  );
}

function ExceptionCard({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-2xl font-semibold ${warn ? "text-amber-600 dark:text-amber-400" : ""}`}>
        {value}
      </div>
    </div>
  );
}
