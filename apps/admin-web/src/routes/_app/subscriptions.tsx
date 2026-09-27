// Owner: WT-5. Subscriptions: one screen request (/api/v1/screens/subscriptions). Expiry and days
// remaining are computed by the server at read time; the detail opens as a drawer (child route).
import type { SubscriptionListItem, SubscriptionsScreen } from "@cloudbox/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import { Plus, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { describeError } from "@/api/client";
import { createSubscription, subscriptionsQuery } from "@/api/subscriptions";
import { EmptyState, ErrorState, PageHeader } from "@/components/page";
import { formatMoney } from "@/components/plan-bits";
import { PlanSelect } from "@/components/plan-select";
import {
  ExpiryPill,
  fromDateInput,
  NativeSelect,
  SubscriptionStatusPill,
  toDateInput,
} from "@/components/subscription-bits";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
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
import { formatTimestamp } from "@/lib/time";

export const Route = createFileRoute("/_app/subscriptions")({
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(subscriptionsQuery);
  },
  component: SubscriptionsPage,
});

const features = tableFeatures({});
const column = createColumnHelper<typeof features, SubscriptionListItem>();

const muted = (text: string) => <span className="text-muted-foreground">{text}</span>;

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
  column.accessor("planName", {
    header: "Plan",
    cell: (info) => (
      <span title={info.row.original.planCode} className="whitespace-nowrap">
        {info.getValue()}
      </span>
    ),
  }),
  column.accessor("status", {
    header: "Status",
    cell: (info) => <SubscriptionStatusPill status={info.getValue()} />,
  }),
  column.display({
    id: "expiry",
    header: "Expiry",
    cell: ({ row }) => (
      <ExpiryPill expiry={row.original.expiry} daysRemaining={row.original.daysRemaining} />
    ),
  }),
  column.accessor("validUntil", {
    header: "Valid until",
    cell: (info) => (
      <span className="font-mono text-xs tabular-nums" title={formatTimestamp(info.getValue())}>
        {toDateInput(info.getValue())}
      </span>
    ),
  }),
  column.accessor("renewalWarningDays", {
    header: "Warns",
    cell: (info) => (
      <span className="tabular-nums" title="Renewal warning threshold">
        {info.getValue()} d
      </span>
    ),
  }),
  column.accessor("maxManagedUsers", {
    header: "Users",
    cell: (info) => <span className="tabular-nums">{info.getValue()}</span>,
  }),
  column.display({
    id: "devices",
    header: "Devices · generation",
    cell: ({ row }) => {
      const list = row.original.devices;
      if (list.length === 0) return muted("no devices");
      return (
        <span className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-xs">
          {list.map((device) => (
            <span key={device.id} className="whitespace-nowrap">
              {device.name}{" "}
              {device.currentGeneration === null ? (
                muted("unlicensed")
              ) : (
                <span className={device.currentRevoked ? "text-red-600 line-through" : undefined}>
                  g{device.currentGeneration}
                </span>
              )}
            </span>
          ))}
        </span>
      );
    },
  }),
]);

function SubscriptionsPage() {
  const query = useQuery(subscriptionsQuery);
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const data = useMemo(() => query.data?.items ?? [], [query.data]);
  const table = useTable({ features, columns, data, getRowId: (row) => row.id });

  const counts = useMemo(() => {
    const out = { active: 0, expiring: 0, expired: 0 };
    for (const item of data) {
      if (item.expiry === "active" || item.expiry === "expiring" || item.expiry === "expired") {
        out[item.expiry] += 1;
      }
    }
    return out;
  }, [data]);

  const open = (id: string) => navigate({ to: "/subscriptions/$id", params: { id } });

  return (
    <>
      <PageHeader
        title="Subscriptions"
        description="Commercial source of truth per tenant. Expiry is derived from server time on every read."
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
            <Button size="sm" onClick={() => setCreating(true)} disabled={!query.data}>
              <Plus />
              New subscription
            </Button>
          </>
        }
      />

      {query.isSuccess ? (
        <div className="flex h-9 items-center gap-4 border-b px-4 text-xs text-muted-foreground">
          <span>
            {data.length} {data.length === 1 ? "subscription" : "subscriptions"}
          </span>
          <span>{counts.active} active</span>
          <span className={counts.expiring ? "text-amber-600 dark:text-amber-400" : undefined}>
            {counts.expiring} expiring
          </span>
          <span className={counts.expired ? "text-red-600 dark:text-red-400" : undefined}>
            {counts.expired} expired
          </span>
          <span className="ml-auto font-mono">server {formatTimestamp(query.data.serverTime)}</span>
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

      {query.isSuccess && data.length === 0 ? (
        <EmptyState>
          No subscriptions yet. A tenant needs one before any device can be licensed; use{" "}
          <span className="font-medium text-foreground">New subscription</span>.
        </EmptyState>
      ) : null}

      {query.data ? (
        <NewSubscriptionDialog open={creating} onOpenChange={setCreating} screen={query.data} />
      ) : null}

      <Outlet />
    </>
  );
}

function NewSubscriptionDialog({
  open,
  onOpenChange,
  screen,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  screen: SubscriptionsScreen;
}) {
  const queryClient = useQueryClient();
  const today = new Date().toISOString();
  const inAYear = new Date(Date.now() + 365 * 86_400_000).toISOString();
  const withSubscription = new Set(
    screen.items.filter((i) => i.status !== "cancelled").map((i) => i.tenantId),
  );
  const available = screen.tenants.filter((t) => !withSubscription.has(t.id));

  const [tenantId, setTenantId] = useState("");
  const [planCode, setPlanCode] = useState(screen.plans[0]?.code ?? "");
  const [validFrom, setValidFrom] = useState(toDateInput(today));
  const [validUntil, setValidUntil] = useState(toDateInput(inAYear));
  const [maxUsers, setMaxUsers] = useState("");
  const [graceDays, setGraceDays] = useState("");
  const [warningDays, setWarningDays] = useState("");
  const [addonUsers, setAddonUsers] = useState("0");
  const plan = screen.plans.find((p) => p.code === planCode);
  const selectedTenant = tenantId || available[0]?.id || "";

  const optional = (value: string) => (value.trim() === "" ? undefined : Number(value));

  const addonUsersCount = Math.max(0, Number(addonUsers) || 0);
  const effectiveMaxUsers = plan
    ? (Number(maxUsers) || plan.maxManagedUsers) + addonUsersCount
    : undefined;
  const totalPrice = plan
    ? plan.priceAmount + addonUsersCount * plan.addonUserPriceAmount
    : undefined;

  const mutation = useMutation({
    mutationFn: () =>
      createSubscription(selectedTenant, {
        planCode,
        validFrom: fromDateInput(validFrom),
        validUntil: fromDateInput(validUntil),
        maxManagedUsers: optional(maxUsers),
        addonUsers: addonUsersCount,
        offlineGraceDays: optional(graceDays),
        renewalWarningDays: optional(warningDays),
      }),
    onSuccess: async () => {
      toast.success("Subscription created");
      onOpenChange(false);
      await queryClient.invalidateQueries({ queryKey: ["screens"] });
    },
    onError: (error) => toast.error(`Could not create: ${describeError(error)}`),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New subscription</DialogTitle>
          <DialogDescription>
            Limits default from the plan; fill a field only to override it for this tenant.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <FieldGroup className="gap-3">
            <Field>
              <FieldLabel htmlFor="sub-tenant">Tenant</FieldLabel>
              <NativeSelect
                id="sub-tenant"
                value={selectedTenant}
                onChange={(event) => setTenantId(event.target.value)}
                disabled={available.length === 0}
              >
                {available.length === 0 ? <option value="">No tenant without one</option> : null}
                {available.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.publicCode} · {t.displayName}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="sub-plan">Plan</FieldLabel>
              <PlanSelect id="sub-plan" value={planCode} onChange={setPlanCode} />
              {plan ? (
                <FieldDescription>
                  {plan.maxDevices} device · {plan.maxManagedUsers} users · grace{" "}
                  {plan.offlineGraceDays} d · warns {plan.renewalWarningDays} d before expiry
                </FieldDescription>
              ) : null}
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="sub-from">Valid from</FieldLabel>
                <Input
                  id="sub-from"
                  type="date"
                  value={validFrom}
                  onChange={(e) => setValidFrom(e.target.value)}
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="sub-until">Valid until</FieldLabel>
                <Input
                  id="sub-until"
                  type="date"
                  value={validUntil}
                  onChange={(e) => setValidUntil(e.target.value)}
                  required
                />
              </Field>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field>
                <FieldLabel htmlFor="sub-users">Max users</FieldLabel>
                <Input
                  id="sub-users"
                  type="number"
                  min={1}
                  placeholder={String(plan?.maxManagedUsers ?? "")}
                  value={maxUsers}
                  onChange={(e) => setMaxUsers(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="sub-grace">Grace days</FieldLabel>
                <Input
                  id="sub-grace"
                  type="number"
                  min={0}
                  placeholder={String(plan?.offlineGraceDays ?? "")}
                  value={graceDays}
                  onChange={(e) => setGraceDays(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="sub-warn">Warning days</FieldLabel>
                <Input
                  id="sub-warn"
                  type="number"
                  min={1}
                  placeholder={String(plan?.renewalWarningDays ?? "")}
                  value={warningDays}
                  onChange={(e) => setWarningDays(e.target.value)}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="sub-addon-users">Add-on users</FieldLabel>
              <Input
                id="sub-addon-users"
                type="number"
                min={0}
                max={plan?.maxAddonUsers ?? 0}
                disabled={!plan || plan.maxAddonUsers === 0}
                value={addonUsers}
                onChange={(e) => setAddonUsers(e.target.value)}
              />
              <FieldDescription>
                {plan && plan.maxAddonUsers > 0
                  ? `Up to ${plan.maxAddonUsers}, at ${formatMoney(plan.addonUserPriceAmount, plan.currency)} each per term.`
                  : "This plan does not offer add-on users."}
              </FieldDescription>
            </Field>
            {plan ? (
              <div className="rounded-md border bg-muted/40 p-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Effective managed users</span>
                  <span className="tabular-nums font-medium">{effectiveMaxUsers}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Total price (per term)</span>
                  <span className="tabular-nums font-medium">
                    {totalPrice !== undefined ? formatMoney(totalPrice, plan.currency) : "—"}
                  </span>
                </div>
              </div>
            ) : null}
          </FieldGroup>
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!selectedTenant || !planCode || mutation.isPending}>
              {mutation.isPending ? "Creating…" : "Create subscription"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
