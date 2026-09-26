// Owner: WT-0. Audit log: /api/v1/screens/audit, newest first, keyset pages of 50.
import type { AuditEntry } from "@cloudbox/contracts";
import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import { RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { auditQuery } from "@/api/screens";
import { EmptyState, ErrorState, PageHeader } from "@/components/page";
import { StatusPill, type Tone } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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

export const Route = createFileRoute("/_app/audit")({
  loader: ({ context }) => {
    void context.queryClient.prefetchInfiniteQuery(auditQuery);
  },
  component: AuditPage,
});

const ACTOR_TONE: Record<string, Tone> = {
  user: "info",
  device: "success",
  system: "neutral",
  "bootstrap-admin": "warning",
};

const features = tableFeatures({});
const column = createColumnHelper<typeof features, AuditEntry>();

const columns = column.columns([
  column.accessor("createdAt", {
    header: "Time",
    cell: (info) => (
      <span className="font-mono text-xs tabular-nums" title={formatAgo(info.getValue())}>
        {formatTimestamp(info.getValue())}
      </span>
    ),
  }),
  column.accessor("eventType", {
    header: "Event",
    cell: (info) => <span className="font-mono text-xs">{info.getValue()}</span>,
  }),
  column.accessor("action", { header: "Action" }),
  column.display({
    id: "entity",
    header: "Entity",
    cell: ({ row }) => (
      <span className="font-mono text-xs">
        <span className="text-muted-foreground">{row.original.entityType}/</span>
        {row.original.entityId}
      </span>
    ),
  }),
  column.display({
    id: "actor",
    header: "Actor",
    cell: ({ row }) => (
      <span className="flex items-center gap-1.5">
        <StatusPill tone={ACTOR_TONE[row.original.actorType] ?? "neutral"}>
          {row.original.actorType}
        </StatusPill>
        <span className="truncate font-mono text-xs">{row.original.actorId}</span>
      </span>
    ),
  }),
  column.accessor("source", {
    header: "Source",
    cell: (info) => info.getValue() ?? <span className="text-muted-foreground">—</span>,
  }),
  column.accessor("correlationId", {
    header: "Correlation",
    cell: (info) => (
      <span className="block max-w-40 truncate font-mono text-xs text-muted-foreground">
        {info.getValue() ?? "—"}
      </span>
    ),
  }),
]);

function Json({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <pre className="max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs">
        {value === null || value === undefined ? "null" : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function AuditPage() {
  const query = useInfiniteQuery(auditQuery);
  const data = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);
  const [selected, setSelected] = useState<AuditEntry | null>(null);
  const table = useTable({ features, columns, data, getRowId: (row) => row.id });

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Append-only record of every consequential change. Newest first."
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
              ? Array.from({ length: 8 }, (_, i) => (
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
                  <TableRow
                    key={row.id}
                    className="cursor-pointer"
                    tabIndex={0}
                    onClick={() => setSelected(row.original)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelected(row.original);
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

      {query.isSuccess && data.length === 0 ? (
        <EmptyState>No audit events recorded yet.</EmptyState>
      ) : null}

      {query.isSuccess ? (
        <div className="flex h-10 items-center justify-between border-t px-4 text-xs text-muted-foreground">
          <span>
            {data.length} {data.length === 1 ? "event" : "events"} loaded
            {query.hasNextPage ? "" : " · end of log"}
          </span>
          {query.hasNextPage ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
            >
              {query.isFetchingNextPage ? "Loading…" : "Load older"}
            </Button>
          ) : null}
        </div>
      ) : null}

      <Sheet open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          {selected ? (
            <>
              <SheetHeader>
                <SheetTitle className="font-mono text-sm">{selected.eventType}</SheetTitle>
                <SheetDescription>
                  {formatTimestamp(selected.createdAt)} · {formatAgo(selected.createdAt)}
                </SheetDescription>
              </SheetHeader>
              <div className="space-y-4 px-4 pb-6">
                <table className="w-full text-sm">
                  <tbody>
                    {(
                      [
                        ["Audit id", selected.id],
                        ["Entity", `${selected.entityType}/${selected.entityId}`],
                        ["Action", selected.action],
                        ["Actor", `${selected.actorType}:${selected.actorId}`],
                        ["Actor tenant", selected.actorTenantId],
                        ["Source", selected.source],
                        ["Correlation id", selected.correlationId],
                      ] as const
                    ).map(([label, value]) => (
                      <tr key={label} className="border-b">
                        <th
                          scope="row"
                          className="h-8 w-36 text-left font-normal text-muted-foreground"
                        >
                          {label}
                        </th>
                        <td className="font-mono text-xs break-all">{value ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <Json label="Before" value={selected.before} />
                <Json label="After" value={selected.after} />
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
