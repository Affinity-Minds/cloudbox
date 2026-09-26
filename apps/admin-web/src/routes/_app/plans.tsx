// Owner: WT-13. Plan designer: operational table, New plan / Edit in a sheet, retire/reactivate
// with a confirmation naming the subscription count. Honest empty state.
import type { PlanListItem } from "@cloudbox/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import { Plus, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { plansScreenQuery } from "@/api/plans";
import { EmptyState, ErrorState, PageHeader } from "@/components/page";
import { FeaturePill, formatTermDays, PlanStatusPill } from "@/components/plan-bits";
import { PlanFormSheet } from "@/components/plan-form-sheet";
import { RetirePlanDialog } from "@/components/retire-plan-dialog";
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

export const Route = createFileRoute("/_app/plans")({
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(plansScreenQuery);
  },
  component: PlansPage,
});

const features = tableFeatures({});
const column = createColumnHelper<typeof features, PlanListItem>();

const muted = (text: string) => <span className="text-muted-foreground">{text}</span>;

const columns = column.columns([
  column.accessor("code", {
    header: "Code",
    cell: (info) => <span className="font-mono text-xs">{info.getValue()}</span>,
  }),
  column.accessor("name", { header: "Name" }),
  column.accessor("maxDevices", {
    header: "Devices",
    cell: (info) => <span className="tabular-nums">{info.getValue()}</span>,
  }),
  column.accessor("maxManagedUsers", {
    header: "Users",
    cell: (info) => <span className="tabular-nums">{info.getValue()}</span>,
  }),
  column.display({
    id: "features",
    header: "Features",
    cell: ({ row }) =>
      row.original.features.length === 0 ? (
        muted("none")
      ) : (
        <span className="flex flex-wrap gap-1">
          {row.original.features.map((feature) => (
            <FeaturePill key={feature} feature={feature} />
          ))}
        </span>
      ),
  }),
  column.accessor("offlineGraceDays", {
    header: "Grace",
    cell: (info) => <span className="tabular-nums">{info.getValue()} d</span>,
  }),
  column.accessor("renewalWarningDays", {
    header: "Warns",
    cell: (info) => <span className="tabular-nums">{info.getValue()} d</span>,
  }),
  column.accessor("termDays", {
    header: "Term",
    cell: (info) => formatTermDays(info.getValue()),
  }),
  column.accessor("status", {
    header: "Status",
    cell: (info) => <PlanStatusPill status={info.getValue()} />,
  }),
  column.accessor("subscriptionCount", {
    header: "Subscriptions",
    cell: (info) => <span className="tabular-nums">{info.getValue()}</span>,
  }),
]);

function PlansPage() {
  const query = useQuery(plansScreenQuery);
  const data = useMemo(() => query.data?.items ?? [], [query.data]);
  const table = useTable({ features, columns, data, getRowId: (row) => row.code });

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<PlanListItem | null>(null);
  const [retiring, setRetiring] = useState<PlanListItem | null>(null);

  return (
    <>
      <PageHeader
        title="Plans"
        description="What every tenant and subscription can choose from. Retiring keeps existing subscriptions working; it only stops new ones from picking it."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => query.refetch()}
              disabled={query.isFetching}
            >
              <RefreshCw className={query.isFetching ? "animate-spin" : undefined} />
              Refresh
            </Button>
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus />
              New plan
            </Button>
          </>
        }
      />

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
                <TableHead className="h-8 w-24 px-3 text-xs" />
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {query.isPending
              ? Array.from({ length: 4 }, (_, i) => (
                  <TableRow key={`skeleton-${i.toString()}`}>
                    {[...columns, null].map((_c, j) => (
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
                    onClick={() => setEditing(row.original)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setEditing(row.original);
                      }
                    }}
                  >
                    {row.getAllCells().map((cell) => (
                      <TableCell key={cell.id} className="h-8 px-3 py-1 first:pl-4">
                        <table.FlexRender cell={cell} />
                      </TableCell>
                    ))}
                    <TableCell className="h-8 px-3 py-1 text-right">
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={(event) => {
                          event.stopPropagation();
                          setRetiring(row.original);
                        }}
                      >
                        {row.original.status === "active" ? "Retire" : "Reactivate"}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      )}

      {query.isSuccess && data.length === 0 ? (
        <EmptyState>
          No plans yet. Click <span className="font-medium text-foreground">New plan</span> to
          create the first one — tenants and subscriptions cannot choose a plan until at least one
          exists.
        </EmptyState>
      ) : null}

      <PlanFormSheet open={creating} onOpenChange={setCreating} />
      {editing ? (
        <PlanFormSheet
          open={editing !== null}
          onOpenChange={(next) => {
            if (!next) setEditing(null);
          }}
          plan={editing}
        />
      ) : null}
      {retiring ? (
        <RetirePlanDialog
          plan={retiring}
          open={retiring !== null}
          onOpenChange={(next) => {
            if (!next) setRetiring(null);
          }}
        />
      ) : null}
    </>
  );
}
