// Owner: WT-3. Device detail drawer: /api/v1/screens/fleet/:deviceId (Overview + License + Health
// + Audit tabs, one request). Licensing actions (Issue/Renew/Revoke) are WT-5's — this tab links to
// the Subscriptions drawer rather than duplicating them (WT-5's handoff).
import type {
  AgentHealth,
  AuditEntry,
  FleetDeviceDetail,
  FleetEntitlementRow,
  LicenseState,
  TenantPlan,
} from "@cloudbox/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { ShieldOff } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { describeError } from "@/api/client";
import { fleetDetailQuery, revokeDevice } from "@/api/devices";
import { KeyProtectionPill, LicenseStatePill, OnlinePill } from "@/components/device-bits";
import { EmptyState, ErrorState } from "@/components/page";
import { KeyValue } from "@/components/subscription-bits";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

export const Route = createFileRoute("/_app/fleet/$deviceId")({
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(fleetDetailQuery(params.deviceId));
  },
  component: DeviceDetail,
});

const TABS = ["overview", "license", "health", "audit"] as const;
type Tab = (typeof TABS)[number];

/** Matches the fleet list's own "online" definition (docs/handoffs/foundation.md — heartbeat
 * freshness), computed client-side here since the detail row doesn't carry a precomputed flag. */
const ONLINE_WINDOW_MS = 2 * 60_000;
function isOnline(lastSeenAt: string | null): boolean {
  return lastSeenAt !== null && Date.now() - new Date(lastSeenAt).getTime() <= ONLINE_WINDOW_MS;
}

function DeviceDetail() {
  const { deviceId } = Route.useParams();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { tab?: string };
  const tab = (TABS as readonly string[]).includes(search.tab ?? "")
    ? (search.tab as Tab)
    : "overview";
  const query = useQuery(fleetDetailQuery(deviceId));
  const [revoking, setRevoking] = useState(false);
  const data = query.data;

  const setTab = (next: Tab) =>
    navigate({ to: "/fleet/$deviceId", params: { deviceId }, search: { tab: next } });

  return (
    <Sheet open onOpenChange={(open) => !open && navigate({ to: "/fleet" })}>
      <SheetContent className="gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-2xl">
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center gap-2">
            {data ? data.device.name : "Device"}
          </SheetTitle>
          <SheetDescription className="font-mono text-xs">{deviceId}</SheetDescription>
          {data ? (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <OnlinePill online={isOnline(data.device.lastSeenAt)} status={data.device.status} />
              <KeyProtectionPill keyProtection={data.device.keyProtection} />
              <LicenseStatePill state={data.device.licenseState} />
              <Button
                size="xs"
                variant="outline"
                className="ml-auto text-destructive hover:text-destructive"
                disabled={data.device.status === "revoked"}
                onClick={() => setRevoking(true)}
              >
                <ShieldOff />
                Revoke
              </Button>
            </div>
          ) : null}
        </SheetHeader>

        <div className="flex h-9 items-center gap-1 border-b px-4">
          {TABS.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={
                "h-7 rounded-md px-2.5 text-xs capitalize " +
                (tab === value
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted/50")
              }
            >
              {value}
            </button>
          ))}
        </div>

        {query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : null}

        {query.isPending ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        ) : null}

        {data && tab === "overview" ? <OverviewTab device={data.device} /> : null}
        {data && tab === "license" ? (
          <LicenseTab
            entitlements={data.entitlements}
            licenseState={data.device.licenseState}
            plan={data.plan}
          />
        ) : null}
        {data && tab === "health" ? <HealthTab lastHealth={data.device.lastHealth} /> : null}
        {data && tab === "audit" ? <AuditTab audit={data.audit} /> : null}
      </SheetContent>

      {data ? (
        <RevokeDialog
          open={revoking}
          onOpenChange={setRevoking}
          deviceId={deviceId}
          deviceName={data.device.name}
        />
      ) : null}
    </Sheet>
  );
}

function OverviewTab({ device }: { device: FleetDeviceDetail }) {
  return (
    <KeyValue
      rows={[
        ["Tenant", `${device.tenantCode} · ${device.tenantName}`],
        ["Hostname", device.hostname],
        ["Windows build", device.windowsBuild ?? "unknown"],
        ["Agent version", device.agentVersion ?? "unknown"],
        [
          "Key protection",
          device.keyProtection === "tpm" ? "TPM (hardware)" : "Software (degraded)",
        ],
        [
          "Device key thumbprint",
          <span key="thumb" className="font-mono text-xs break-all">
            {device.deviceKeyThumbprint}
          </span>,
        ],
        ["Enrolled", `${formatTimestamp(device.enrolledAt)} · ${formatAgo(device.enrolledAt)}`],
        [
          "Last seen",
          device.lastSeenAt
            ? `${formatTimestamp(device.lastSeenAt)} · ${formatAgo(device.lastSeenAt)}`
            : "never",
        ],
        ["Status", device.status],
        ["Revoked", device.revokedAt ? formatTimestamp(device.revokedAt) : "—"],
      ]}
    />
  );
}

function LicenseTab({
  entitlements,
  licenseState,
  plan,
}: {
  entitlements: FleetEntitlementRow[];
  licenseState: LicenseState;
  plan?: TenantPlan;
}) {
  const subscriptionId = entitlements[0]?.subscriptionId;
  return (
    <div className="space-y-3 p-4">
      {/* WT-14: the tenant's plan state, read-only (auto-issuance follows it on heartbeat). */}
      {plan ? (
        <p className="text-xs text-muted-foreground" data-testid="tenant-plan-state">
          Tenant plan:{" "}
          <span className="font-mono text-foreground">{plan.state.replaceAll("_", " ")}</span>
          {plan.planCode ? ` · ${plan.planCode}` : ""}
          {plan.validUntil ? ` · until ${plan.validUntil.slice(0, 10)}` : ""}
          {plan.message ? ` — ${plan.message}` : ""}
        </p>
      ) : null}
      <div className="flex items-center justify-between">
        <LicenseStatePill state={licenseState} />
        {subscriptionId ? (
          <Button size="xs" variant="outline" asChild>
            <Link to="/subscriptions/$id" params={{ id: subscriptionId }}>
              Open subscription for Issue / Renew / Revoke
            </Link>
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">
            No subscription on this device's tenant yet — see Subscriptions.
          </span>
        )}
      </div>
      {entitlements.length === 0 ? (
        <EmptyState>
          No entitlement has been issued for this device yet. Issue one from the tenant's
          Subscription page.
        </EmptyState>
      ) : (
        <Table className="text-sm">
          <TableHeader>
            <TableRow>
              <TableHead className="h-8 px-3 text-xs">Generation</TableHead>
              <TableHead className="h-8 px-3 text-xs">Issued</TableHead>
              <TableHead className="h-8 px-3 text-xs">Valid until</TableHead>
              <TableHead className="h-8 px-3 text-xs">Revoked</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entitlements.map((entitlement) => (
              <TableRow key={entitlement.id}>
                <TableCell className="h-8 px-3 py-1 font-mono text-xs tabular-nums">
                  g{entitlement.generation}
                </TableCell>
                <TableCell className="h-8 px-3 py-1 font-mono text-xs">
                  {formatTimestamp(entitlement.issuedAt)}
                </TableCell>
                <TableCell className="h-8 px-3 py-1 font-mono text-xs">
                  {formatTimestamp(entitlement.validUntil)}
                </TableCell>
                <TableCell className="h-8 px-3 py-1 font-mono text-xs">
                  {entitlement.revokedAt ? (
                    <span className="text-red-600 dark:text-red-400">
                      {formatTimestamp(entitlement.revokedAt)}
                    </span>
                  ) : (
                    "—"
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

/** Every field the agent could not determine yet arrives as `null` (or the string `"unknown"` for a
 * state) — rendered here as "unknown", never as 0 or "Offline" (docs/handoffs "AgentHealth nullable
 * fields"). */
function unknownIfNull(value: unknown): string {
  if (value === null || value === undefined) return "unknown";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

function HealthTab({ lastHealth }: { lastHealth: unknown }) {
  if (!lastHealth) {
    return (
      <EmptyState>No health document yet. It arrives with the device's first heartbeat.</EmptyState>
    );
  }
  const health = lastHealth as AgentHealth;
  return (
    <div className="space-y-3 p-4">
      <KeyValue
        rows={[
          ["Agent version", unknownIfNull(health.agent?.version)],
          ["Agent healthy", unknownIfNull(health.agent?.healthy)],
          ["License", unknownIfNull(health.license?.state)],
          ["Network", unknownIfNull(health.network?.state)],
          ["RDP", unknownIfNull(health.rdp?.state)],
          ["RDP listener", unknownIfNull(health.rdp?.listener)],
          ["Managed users", unknownIfNull(health.users?.configured)],
          ["Active sessions", unknownIfNull(health.users?.active_sessions)],
          ["Backup", unknownIfNull(health.backup?.state)],
          ["Free storage (bytes)", unknownIfNull(health.storage?.free_bytes)],
          ["Updates", unknownIfNull(health.updates?.state)],
          ["Reboot required", unknownIfNull(health.updates?.reboot_required)],
          ["Tamper", unknownIfNull(health.security?.tamper)],
        ]}
      />
      <div>
        <div className="mb-1 px-1 text-xs font-medium text-muted-foreground uppercase">
          Raw document
        </div>
        <pre className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs">
          {JSON.stringify(lastHealth, null, 2)}
        </pre>
      </div>
    </div>
  );
}

function AuditTab({ audit }: { audit: AuditEntry[] }) {
  if (audit.length === 0) {
    return <EmptyState>No audited changes for this device yet.</EmptyState>;
  }
  return (
    <Table className="text-sm">
      <TableHeader>
        <TableRow>
          <TableHead className="h-8 px-3 text-xs">Time</TableHead>
          <TableHead className="h-8 px-3 text-xs">Event</TableHead>
          <TableHead className="h-8 px-3 text-xs">Actor</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {audit.map((entry) => (
          <TableRow key={entry.id}>
            <TableCell
              className="h-8 px-3 py-1 font-mono text-xs"
              title={formatTimestamp(entry.createdAt)}
            >
              {formatAgo(entry.createdAt)}
            </TableCell>
            <TableCell className="h-8 px-3 py-1 font-mono text-xs">{entry.eventType}</TableCell>
            <TableCell className="h-8 px-3 py-1 font-mono text-xs text-muted-foreground">
              {entry.actorType}:{entry.actorId}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function RevokeDialog({
  open,
  onOpenChange,
  deviceId,
  deviceName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deviceId: string;
  deviceName: string;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => revokeDevice(deviceId),
    onSuccess: async () => {
      toast.success(`${deviceName} revoked`);
      onOpenChange(false);
      await queryClient.invalidateQueries({ queryKey: ["screens", "fleet"] });
    },
    onError: (error) => toast.error(`Could not revoke: ${describeError(error)}`),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Revoke {deviceName}?</DialogTitle>
          <DialogDescription>
            This revokes the device and every credential it holds. It stops answering the agent API
            immediately and needs a fresh enrollment token to come back.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? "Revoking…" : "Revoke device"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
