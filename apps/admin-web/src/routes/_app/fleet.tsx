// Owner: WT-3. Fleet: one screen request (/api/v1/screens/fleet). Detail opens as a drawer (child
// route). Tenant picker is embedded in the screen response until WT-2 ships a real tenants list.
import type { FleetListItem } from "@cloudbox/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import { RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { fleetQuery } from "@/api/devices";
import { KeyProtectionPill, LicenseStatePill, OnlinePill } from "@/components/device-bits";
import { EmptyState, ErrorState, PageHeader } from "@/components/page";
import { NativeSelect } from "@/components/subscription-bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useFleetPresence } from "@/hooks/use-fleet-presence";
import { formatAgo, formatTimestamp } from "@/lib/time";
import { cn } from "@/lib/utils";

/** A Fleet row with the FleetPresence WebSocket feed (WT-16) layered on top when it has heard
 * about this device: fresher `online`/`lastSeenAt`, plus `activeSessions`, which the REST screen
 * loader does not carry at all (it is ephemeral, DO-only state — spec §5.3). */
type LiveFleetRow = FleetListItem & { activeSessions: number | null };

export const Route = createFileRoute("/_app/fleet")({
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(fleetQuery({}));
  },
  component: FleetPage,
});

type OnlineFilter = "all" | "online" | "offline";

const features = tableFeatures({});
const column = createColumnHelper<typeof features, LiveFleetRow>();

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
  column.display({
    id: "device",
    header: "Device",
    cell: ({ row }) => (
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{row.original.name}</span>
        <span className="truncate font-mono text-xs text-muted-foreground">
          {row.original.hostname}
        </span>
      </span>
    ),
  }),
  column.display({
    id: "status",
    header: "Status",
    cell: ({ row }) => (
      <span className="flex items-center gap-1.5">
        <OnlinePill online={row.original.online} status={row.original.status} />
        <KeyProtectionPill keyProtection={row.original.keyProtection} />
      </span>
    ),
  }),
  column.accessor("lastSeenAt", {
    header: "Last seen",
    cell: (info) => (
      <span className="whitespace-nowrap text-xs" title={formatTimestamp(info.getValue())}>
        {formatAgo(info.getValue())}
      </span>
    ),
  }),
  column.accessor("agentVersion", {
    header: "Agent",
    cell: (info) => (
      <span className="font-mono text-xs">
        {info.getValue() ?? <span className="text-muted-foreground">—</span>}
      </span>
    ),
  }),
  column.accessor("windowsBuild", {
    header: "Windows build",
    cell: (info) => (
      <span className="font-mono text-xs">
        {info.getValue() ?? <span className="text-muted-foreground">—</span>}
      </span>
    ),
  }),
  column.display({
    id: "license",
    header: "License",
    cell: ({ row }) => <LicenseStatePill state={row.original.licenseState} />,
  }),
  column.display({
    id: "sessions",
    header: "Sessions",
    // WT-16: only the live WebSocket feed knows this; unknown (no live data yet) renders "—",
    // never 0 — the same "don't guess a number you don't have" convention as the Health tab.
    cell: ({ row }) => (
      <span className="font-mono text-xs">
        {row.original.activeSessions ?? <span className="text-muted-foreground">—</span>}
      </span>
    ),
  }),
  column.accessor("enrolledAt", {
    header: "Enrolled",
    cell: (info) => (
      <span className="whitespace-nowrap font-mono text-xs">
        {formatTimestamp(info.getValue())}
      </span>
    ),
  }),
]);

/** Small header badge for the FleetPresence WebSocket feed's own connection state (WT-16) — not
 * the REST loader's `query.isFetching`, which the Refresh button already covers. "Live" is the
 * steady state; "Connecting"/"Reconnecting" and "Offline" are honest about what they are, never
 * silently retried forever without telling anyone (the REST loader keeps serving in the
 * meantime — this badge is additive, never load-bearing). */
function LiveIndicator({ status }: { status: "connecting" | "open" | "closed" }) {
  const label = status === "open" ? "Live" : status === "connecting" ? "Connecting…" : "Offline";
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span
        className={cn(
          "size-1.5 rounded-full",
          status === "open" && "bg-emerald-500",
          status === "connecting" && "animate-pulse bg-amber-500",
          status === "closed" && "bg-muted-foreground/50",
        )}
      />
      {label}
    </span>
  );
}

function FleetPage() {
  const [tenant, setTenant] = useState("");
  const [onlineFilter, setOnlineFilter] = useState<OnlineFilter>("all");
  const [degradedOnly, setDegradedOnly] = useState(false);
  const [q, setQ] = useState("");
  const navigate = useNavigate();
  const { presence, status: liveStatus } = useFleetPresence();

  const query = useQuery(
    fleetQuery({
      tenant: tenant || undefined,
      online: onlineFilter === "all" ? undefined : onlineFilter === "online",
      q: q || undefined,
    }),
  );

  const items = useMemo(() => {
    const all = query.data?.items ?? [];
    const withLiveState: LiveFleetRow[] = all.map((item) => {
      const live = presence[item.id];
      return live
        ? {
            ...item,
            online: live.online,
            lastSeenAt: live.lastSeenAt,
            activeSessions: live.activeSessions,
          }
        : { ...item, activeSessions: null };
    });
    // The online filter is applied client-side too, in case a device's live state moved since
    // the REST loader ran (fresh push vs. a filter chosen a moment earlier).
    const onlineFiltered =
      onlineFilter === "all"
        ? withLiveState
        : withLiveState.filter((d) => d.online === (onlineFilter === "online"));
    return degradedOnly
      ? onlineFiltered.filter((d) => d.keyProtection === "software")
      : onlineFiltered;
  }, [query.data, degradedOnly, onlineFilter, presence]);

  const table = useTable({ features, columns, data: items, getRowId: (row) => row.id });
  const tenants = query.data?.tenants ?? [];
  const open = (id: string) => navigate({ to: "/fleet/$deviceId", params: { deviceId: id } });

  return (
    <>
      <PageHeader
        title="Fleet"
        description="Enrolled devices with online state, agent version and last heartbeat."
        actions={
          <>
            <LiveIndicator status={liveStatus} />
            <Button
              variant="outline"
              size="sm"
              onClick={() => query.refetch()}
              disabled={query.isFetching}
            >
              <RefreshCw className={query.isFetching ? "animate-spin" : undefined} />
              Refresh
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        {tenants.length > 1 ? (
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
        ) : null}
        <div className="flex overflow-hidden rounded-lg border">
          {(["all", "online", "offline"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setOnlineFilter(value)}
              className={
                "h-8 px-3 text-xs capitalize " +
                (onlineFilter === value
                  ? "bg-primary text-primary-foreground"
                  : "bg-background hover:bg-muted")
              }
            >
              {value}
            </button>
          ))}
        </div>
        <Button
          type="button"
          variant={degradedOnly ? "default" : "outline"}
          size="sm"
          onClick={() => setDegradedOnly((v) => !v)}
        >
          Degraded key only
        </Button>
        <div className="relative ml-auto w-56">
          <Search className="pointer-events-none absolute top-1.5 left-2 size-4 text-muted-foreground" />
          <Input
            placeholder="Search name or hostname"
            className="pl-7"
            value={q}
            onChange={(event) => setQ(event.target.value)}
          />
        </div>
      </div>

      {query.isSuccess ? (
        <div className="flex h-9 items-center gap-4 border-b px-4 text-xs text-muted-foreground">
          <span>{query.data.facets.total} devices</span>
          <span className="text-emerald-600 dark:text-emerald-400">
            {query.data.facets.online} online
          </span>
          <span>{query.data.facets.offline} offline</span>
          {query.data.facets.degradedKey ? (
            <span className="text-amber-600 dark:text-amber-400">
              {query.data.facets.degradedKey} degraded key
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
                    onClick={() => open(row.original.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        open(row.original.id);
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
          No devices enrolled. Create an enrollment token under Enrollment and run CloudBox Server
          Setup on the machine.
        </EmptyState>
      ) : null}

      <Outlet />
    </>
  );
}
