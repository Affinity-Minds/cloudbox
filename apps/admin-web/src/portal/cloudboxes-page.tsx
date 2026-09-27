// Owner: WT-15. Portal CloudBoxes: the tenant's devices, online state, licence state, last seen.
// Reuses WT-3's device pills and `GET /tenants/:tenantId/portal/devices` (which itself reuses the
// fleet loader, scoped to exactly this tenant — see routes/v1/portal.ts).
import { useQuery } from "@tanstack/react-query";
import { portalDevicesQuery } from "@/api/portal";
import { KeyProtectionPill, LicenseStatePill, OnlinePill } from "@/components/device-bits";
import { EmptyState, ErrorState, PageHeader } from "@/components/page";
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
import { RequireActiveTenant } from "./require-active-tenant";

function DevicesTable({ tenantId }: { tenantId: string }) {
  const devices = useQuery(portalDevicesQuery(tenantId));

  if (devices.isPending) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }
  if (devices.isError)
    return <ErrorState error={devices.error} onRetry={() => devices.refetch()} />;
  if (devices.data.items.length === 0) {
    return (
      <EmptyState>
        No CloudBoxes activated yet. Use "Activate a server" to turn a machine into one for this
        organisation.
      </EmptyState>
    );
  }

  return (
    <Table className="text-sm">
      <TableHeader>
        <TableRow>
          <TableHead className="h-8 px-3 text-xs">Name</TableHead>
          <TableHead className="h-8 px-3 text-xs">Status</TableHead>
          <TableHead className="h-8 px-3 text-xs">Licence</TableHead>
          <TableHead className="h-8 px-3 text-xs">Last seen</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {devices.data.items.map((device) => (
          <TableRow key={device.id}>
            <TableCell className="h-9 px-3 py-1">
              <div className="font-medium">{device.name}</div>
              <div className="text-xs text-muted-foreground">{device.hostname}</div>
            </TableCell>
            <TableCell className="h-9 px-3 py-1">
              <div className="flex items-center gap-1.5">
                <OnlinePill online={device.online} status={device.status} />
                <KeyProtectionPill keyProtection={device.keyProtection} />
              </div>
            </TableCell>
            <TableCell className="h-9 px-3 py-1">
              <LicenseStatePill state={device.licenseState} />
            </TableCell>
            <TableCell
              className="h-9 px-3 py-1 font-mono text-xs"
              title={device.lastSeenAt ? formatTimestamp(device.lastSeenAt) : undefined}
            >
              {device.lastSeenAt ? formatAgo(device.lastSeenAt) : "Never"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function CloudBoxesPage() {
  return (
    <>
      <PageHeader title="CloudBoxes" description="Servers activated for this organisation." />
      <div className="pt-4">
        <RequireActiveTenant>
          {(tenantId) => <DevicesTable tenantId={tenantId} />}
        </RequireActiveTenant>
      </div>
    </>
  );
}
