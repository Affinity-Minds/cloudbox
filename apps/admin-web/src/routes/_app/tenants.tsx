// Owner: WT-2. Tenants table: search, status filter pills, plan filter, sortable, row -> detail.
import type { TenantListItem } from "@cloudbox/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import { Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { tenantsScreenQuery } from "@/api/tenants";
import { EmptyState, ErrorState, PageHeader } from "@/components/page";
import { StatusPill, type Tone } from "@/components/status-pill";
import { TenantFormSheet } from "@/components/tenants/tenant-form-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatTimestamp } from "@/lib/time";

export const Route = createFileRoute("/_app/tenants")({
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(tenantsScreenQuery({}));
  },
  component: TenantsPage,
});

const STATUS_TONE: Record<string, Tone> = {
  trial: "info",
  provisioning: "neutral",
  active: "success",
  past_due: "warning",
  suspended: "warning",
  cancelled: "danger",
  archived: "neutral",
};

const features = tableFeatures({});
const column = createColumnHelper<typeof features, TenantListItem>();

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function TenantsPage() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [plan, setPlan] = useState<string | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{ key: "displayName" | "createdAt"; desc: boolean }>({
    key: "createdAt",
    desc: true,
  });
  const [createOpen, setCreateOpen] = useState(false);
  const debouncedQ = useDebounced(q, 300);

  const filter = { q: debouncedQ || undefined, status, plan, page };
  const query = useQuery(tenantsScreenQuery(filter));

  const sortedItems = useMemo(() => {
    const items = query.data?.items ?? [];
    const sorted = [...items].sort((a, b) => {
      const cmp =
        sort.key === "displayName"
          ? a.displayName.localeCompare(b.displayName)
          : a.createdAt.localeCompare(b.createdAt);
      return sort.desc ? -cmp : cmp;
    });
    return sorted;
  }, [query.data?.items, sort]);

  const toggleSort = useCallback(
    (key: "displayName" | "createdAt") =>
      setSort((prev) => (prev.key === key ? { key, desc: !prev.desc } : { key, desc: false })),
    [],
  );

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor("publicCode", {
          header: "Code",
          cell: (info) => <span className="font-mono text-xs">{info.getValue()}</span>,
        }),
        column.accessor("displayName", {
          header: () => (
            <button
              type="button"
              className="hover:underline"
              onClick={() => toggleSort("displayName")}
            >
              Name{sort.key === "displayName" ? (sort.desc ? " ↓" : " ↑") : ""}
            </button>
          ),
        }),
        column.accessor("status", {
          header: "Status",
          cell: (info) => (
            <StatusPill tone={STATUS_TONE[info.getValue()] ?? "neutral"}>
              {info.getValue()}
            </StatusPill>
          ),
        }),
        column.accessor("planCode", {
          header: "Plan",
          cell: (info) => info.getValue() ?? <span className="text-muted-foreground">—</span>,
        }),
        column.accessor("deviceCount", {
          header: "Devices",
          cell: (info) => <span className="tabular-nums">{info.getValue()}</span>,
        }),
        column.accessor("memberCount", {
          header: "Members",
          cell: (info) => <span className="tabular-nums">{info.getValue()}</span>,
        }),
        column.accessor("nextSubscriptionExpiry", {
          header: "Next expiry",
          cell: (info) => formatTimestamp(info.getValue()),
        }),
        column.accessor("health", {
          header: "Health",
          cell: () => <StatusPill tone="neutral">unknown</StatusPill>,
        }),
        column.accessor("createdAt", {
          header: () => (
            <button
              type="button"
              className="hover:underline"
              onClick={() => toggleSort("createdAt")}
            >
              Created{sort.key === "createdAt" ? (sort.desc ? " ↓" : " ↑") : ""}
            </button>
          ),
          cell: (info) => formatTimestamp(info.getValue()),
        }),
      ]),
    [sort, toggleSort],
  );

  const table = useTable({ features, columns, data: sortedItems, getRowId: (row) => row.id });

  return (
    <>
      <PageHeader
        title="Tenants"
        description="Every customer organisation CloudBox manages."
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
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus />
              New tenant
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <Input
          value={q}
          onChange={(e) => {
            setPage(1);
            setQ(e.target.value);
          }}
          placeholder="Search by name or code…"
          className="h-8 max-w-56"
        />
        <div className="flex items-center gap-1">
          <Button
            variant={status === undefined ? "secondary" : "outline"}
            size="xs"
            onClick={() => {
              setPage(1);
              setStatus(undefined);
            }}
          >
            All
          </Button>
          {(query.data?.facets.status ?? []).map((facet) => (
            <Button
              key={facet.value}
              variant={status === facet.value ? "secondary" : "outline"}
              size="xs"
              onClick={() => {
                setPage(1);
                setStatus((current) => (current === facet.value ? undefined : facet.value));
              }}
            >
              {facet.value} <span className="ml-1 tabular-nums opacity-70">{facet.count}</span>
            </Button>
          ))}
        </div>
        <SelectNative
          className="ml-auto max-w-40"
          value={plan ?? ""}
          onChange={(e) => {
            setPage(1);
            setPlan(e.target.value || undefined);
          }}
        >
          <option value="">All plans</option>
          {(query.data?.facets.plan ?? []).map((facet) => (
            <option key={facet.value} value={facet.value}>
              {facet.value} ({facet.count})
            </option>
          ))}
        </SelectNative>
      </div>

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
                  <TableRow
                    key={row.id}
                    className="cursor-pointer"
                    tabIndex={0}
                    onClick={() =>
                      navigate({ to: "/tenants/$tenantId", params: { tenantId: row.original.id } })
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        navigate({
                          to: "/tenants/$tenantId",
                          params: { tenantId: row.original.id },
                        });
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

      {query.isSuccess && sortedItems.length === 0 ? (
        <EmptyState>
          {q || status || plan
            ? "No tenants match these filters."
            : "No tenants yet. Click New tenant to create the first one — it will appear here with an assigned code, status and plan."}
        </EmptyState>
      ) : null}

      {query.isSuccess && query.data.total > query.data.pageSize ? (
        <div className="flex h-10 items-center justify-between border-t px-4 text-xs text-muted-foreground">
          <span>
            Page {query.data.page} · {query.data.total} tenant{query.data.total === 1 ? "" : "s"}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page * query.data.pageSize >= query.data.total}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}

      <TenantFormSheet
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSaved={(tenant) =>
          navigate({ to: "/tenants/$tenantId", params: { tenantId: tenant.id } })
        }
      />

      <Outlet />
    </>
  );
}
