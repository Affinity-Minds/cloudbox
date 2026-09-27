// Owner: WT-2. Tenant detail: tabs Overview / Members / Devices / Subscription / Audit.
// Tab lives in the query string (agent-notes ux-patterns "Routes, not tab state").
import type {
  AuditEntry,
  Device,
  Membership,
  SubscriptionWithPricing,
  Tenant,
} from "@cloudbox/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ChevronLeft, UserPlus } from "lucide-react";
import type * as React from "react";
import { useState } from "react";
import { toast } from "sonner";
import { describeError } from "@/api/client";
import { inviteMember, removeMember, tenantDetailQuery, updateMemberStanding } from "@/api/tenants";
import { EmptyState, ErrorState, PageHeader, Section } from "@/components/page";
import { formatMoney } from "@/components/plan-bits";
import { StatusPill, type Tone } from "@/components/status-pill";
import { ArchiveTenantDialog } from "@/components/tenants/archive-tenant-dialog";
import { InviteMemberDialog } from "@/components/tenants/invite-member-dialog";
import { TenantFormSheet } from "@/components/tenants/tenant-form-sheet";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SelectNative } from "@/components/ui/select-native";
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

const TABS = ["overview", "members", "devices", "subscription", "audit"] as const;
type Tab = (typeof TABS)[number];

export const Route = createFileRoute("/_app/tenants/$tenantId")({
  validateSearch: (search: Record<string, unknown>): { tab?: Tab } => ({
    tab: TABS.includes(search.tab as Tab) ? (search.tab as Tab) : undefined,
  }),
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(tenantDetailQuery(params.tenantId));
  },
  component: TenantDetailPage,
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

const DEVICE_TONE: Record<string, Tone> = {
  enrolled: "success",
  revoked: "danger",
  transferred: "neutral",
};

const SUBSCRIPTION_TONE: Record<string, Tone> = {
  trial: "info",
  active: "success",
  past_due: "warning",
  suspended: "warning",
  cancelled: "danger",
};

function TenantDetailPage() {
  const { tenantId } = Route.useParams();
  const { tab = "overview" } = Route.useSearch();
  const navigate = useNavigate();
  const query = useQuery(tenantDetailQuery(tenantId));
  const [editOpen, setEditOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);

  const setTab = (next: Tab) =>
    navigate({ to: "/tenants/$tenantId", params: { tenantId }, search: { tab: next } });

  if (query.isPending) {
    return (
      <>
        <PageHeader title="Tenant" />
        <div className="space-y-2 p-4">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-1/4" />
        </div>
      </>
    );
  }

  if (query.isError || !query.data) {
    return (
      <>
        <PageHeader title="Tenant" />
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      </>
    );
  }

  const { tenant, memberships, devices, subscriptions, auditEvents } = query.data;

  return (
    <>
      <PageHeader
        title={tenant.displayName}
        description={`${tenant.publicCode} · ${tenant.status}`}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => navigate({ to: "/tenants" })}>
              <ChevronLeft />
              Back
            </Button>
            <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
              Edit
            </Button>
            {tenant.status !== "archived" ? (
              <Button variant="destructive" size="sm" onClick={() => setArchiveOpen(true)}>
                Archive
              </Button>
            ) : null}
          </>
        }
      />

      <div className="flex gap-1 border-b px-4 pt-2">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded-t-md px-3 py-1.5 text-sm capitalize ${
              tab === t
                ? "border-b-2 border-primary font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t}
            {t === "members" ? ` (${memberships.length})` : null}
            {t === "devices" ? ` (${devices.length})` : null}
            {t === "audit" ? ` (${auditEvents.length})` : null}
          </button>
        ))}
      </div>

      {tab === "overview" ? <OverviewTab tenant={tenant} /> : null}
      {tab === "members" ? <MembersTab tenantId={tenantId} memberships={memberships} /> : null}
      {tab === "devices" ? <DevicesTab devices={devices} /> : null}
      {tab === "subscription" ? <SubscriptionTab subscriptions={subscriptions} /> : null}
      {tab === "audit" ? <AuditTab events={auditEvents} /> : null}

      <TenantFormSheet open={editOpen} onOpenChange={setEditOpen} tenant={tenant} />
      <ArchiveTenantDialog tenant={tenant} open={archiveOpen} onOpenChange={setArchiveOpen} />
    </>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <tr className="border-b">
      <th scope="row" className="h-8 w-48 px-4 text-left font-normal text-muted-foreground">
        {label}
      </th>
      <td className="px-4 text-sm">{value ?? <span className="text-muted-foreground">—</span>}</td>
    </tr>
  );
}

function OverviewTab({ tenant }: { tenant: Tenant }) {
  return (
    <Section title="Overview">
      <table className="w-full border-t text-sm">
        <tbody>
          <Row label="Display name" value={tenant.displayName} />
          <Row label="Legal name" value={tenant.legalName} />
          <Row
            label="Status"
            value={
              <StatusPill tone={STATUS_TONE[tenant.status] ?? "neutral"}>
                {tenant.status}
              </StatusPill>
            }
          />
          <Row label="Plan" value={tenant.planCode} />
          <Row label="Primary contact" value={tenant.primaryContactEmail} />
          <Row label="Support contact" value={tenant.supportContactEmail} />
          <Row label="Billing contact" value={tenant.billingContactEmail} />
          <Row label="Timezone" value={tenant.timezone} />
          <Row label="Renewal warning" value={`${tenant.renewalWarningDays} days`} />
          <Row label="Notes" value={tenant.notes} />
          <Row label="Created" value={formatTimestamp(tenant.createdAt)} />
          <Row label="Updated" value={formatTimestamp(tenant.updatedAt)} />
          {tenant.archivedAt ? (
            <Row label="Archived" value={formatTimestamp(tenant.archivedAt)} />
          ) : null}
        </tbody>
      </table>
    </Section>
  );
}

function MembersTab({ tenantId, memberships }: { tenantId: string; memberships: Membership[] }) {
  const queryClient = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [revoking, setRevoking] = useState<Membership | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["screens", "tenants", tenantId] });

  const standingMutation = useMutation({
    mutationFn: ({ id, standing }: { id: string; standing: "owner" | "admin" | "user" }) =>
      updateMemberStanding(tenantId, id, { standing }),
    onSuccess: () => {
      invalidate();
      toast.success("Standing updated");
    },
    onError: (error) =>
      toast.error("Could not change standing", { description: describeError(error) }),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => removeMember(tenantId, id),
    onSuccess: () => {
      invalidate();
      toast.success("Membership revoked");
      setRevoking(null);
    },
    onError: (error) => toast.error("Could not revoke", { description: describeError(error) }),
  });

  const reinstateMutation = useMutation({
    mutationFn: (member: Membership) =>
      inviteMember(tenantId, { email: member.email, standing: member.standing }),
    onSuccess: () => {
      invalidate();
      toast.success("Membership reinstated");
    },
    onError: (error) => toast.error("Could not reinstate", { description: describeError(error) }),
  });

  return (
    <>
      <Section
        title="Members"
        meta={
          <Button size="xs" onClick={() => setInviteOpen(true)}>
            <UserPlus />
            Invite
          </Button>
        }
      >
        {memberships.length === 0 ? (
          <EmptyState>
            No members yet. Invite someone by email — they sign in with a one-time code and can
            manage this tenant right away, no invite link to accept.
          </EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Person</TableHead>
                <TableHead>Standing</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Invited</TableHead>
                <TableHead className="pr-4 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {memberships.map((member) => (
                <TableRow key={member.id}>
                  <TableCell className="pl-4">
                    <div className="font-medium">{member.name || member.email}</div>
                    <div className="text-xs text-muted-foreground">{member.email}</div>
                  </TableCell>
                  <TableCell>
                    <SelectNative
                      className="w-28"
                      value={member.standing}
                      disabled={member.status === "revoked" || standingMutation.isPending}
                      onChange={(e) =>
                        standingMutation.mutate({
                          id: member.id,
                          standing: e.target.value as "owner" | "admin" | "user",
                        })
                      }
                    >
                      <option value="owner">owner</option>
                      <option value="admin">admin</option>
                      <option value="user">user</option>
                    </SelectNative>
                  </TableCell>
                  <TableCell>
                    <StatusPill tone={member.status === "active" ? "success" : "neutral"}>
                      {member.status}
                    </StatusPill>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatAgo(member.createdAt)}
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    {member.status === "active" ? (
                      <Button variant="outline" size="xs" onClick={() => setRevoking(member)}>
                        Revoke
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={reinstateMutation.isPending}
                        onClick={() => reinstateMutation.mutate(member)}
                      >
                        Reinstate
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <InviteMemberDialog tenantId={tenantId} open={inviteOpen} onOpenChange={setInviteOpen} />

      <Dialog open={revoking !== null} onOpenChange={(open) => !open && setRevoking(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Revoke {revoking?.name || revoking?.email}?</DialogTitle>
            <DialogDescription>
              They lose access to this tenant immediately. The membership row stays, marked revoked,
              so it can be reinstated later.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="destructive"
              disabled={revokeMutation.isPending}
              onClick={() => revoking && revokeMutation.mutate(revoking.id)}
            >
              {revokeMutation.isPending ? "Revoking…" : "Revoke"}
            </Button>
            <Button variant="outline" onClick={() => setRevoking(null)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function DevicesTab({ devices }: { devices: Device[] }) {
  return (
    <Section title="Devices">
      {devices.length === 0 ? (
        <EmptyState>
          No devices enrolled yet. Enrollment and the Fleet view are owned by another slice (device
          tokens, heartbeats); once a device enrolls here, it will show its status, hostname and
          last-seen time.
        </EmptyState>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Hostname</TableHead>
              <TableHead>Agent</TableHead>
              <TableHead>Enrolled</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {devices.map((device) => (
              <TableRow key={device.id}>
                <TableCell className="pl-4">{device.name}</TableCell>
                <TableCell>
                  <StatusPill tone={DEVICE_TONE[device.status] ?? "neutral"}>
                    {device.status}
                  </StatusPill>
                </TableCell>
                <TableCell className="font-mono text-xs">{device.hostname}</TableCell>
                <TableCell>{device.agentVersion ?? "—"}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {formatAgo(device.enrolledAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

function SubscriptionTab({ subscriptions }: { subscriptions: SubscriptionWithPricing[] }) {
  return (
    <Section title="Subscription">
      {subscriptions.length === 0 ? (
        <EmptyState>
          No subscription yet. Plans and billing are owned by another slice; once one exists here,
          it will show plan, validity and entitlement generation.
        </EmptyState>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Plan</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Valid from</TableHead>
              <TableHead>Valid until</TableHead>
              <TableHead>Managed users</TableHead>
              <TableHead>Price / term</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {subscriptions.map((sub) => (
              <TableRow key={sub.id}>
                <TableCell className="pl-4 font-mono text-xs">{sub.planCode}</TableCell>
                <TableCell>
                  <StatusPill tone={SUBSCRIPTION_TONE[sub.status] ?? "neutral"}>
                    {sub.status}
                  </StatusPill>
                </TableCell>
                <TableCell>{formatTimestamp(sub.validFrom)}</TableCell>
                <TableCell>{formatTimestamp(sub.validUntil)}</TableCell>
                <TableCell className="tabular-nums">
                  {sub.effectiveMaxManagedUsers}
                  {sub.addonUsers > 0 ? (
                    <span className="text-muted-foreground">
                      {" "}
                      ({sub.maxManagedUsers} + {sub.addonUsers})
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="tabular-nums">
                  {formatMoney(sub.totalPriceAmount, sub.currency)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

const ACTOR_TONE: Record<string, Tone> = {
  user: "info",
  device: "success",
  system: "neutral",
  "bootstrap-admin": "warning",
};

function AuditTab({ events }: { events: AuditEntry[] }) {
  const [selected, setSelected] = useState<AuditEntry | null>(null);

  return (
    <Section title="Audit" meta={<span>Last {events.length} events for this tenant</span>}>
      {events.length === 0 ? (
        <EmptyState>No audited changes for this tenant yet.</EmptyState>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Time</TableHead>
              <TableHead>Event</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Entity</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.map((event) => (
              <TableRow
                key={event.id}
                className="cursor-pointer"
                onClick={() => setSelected(event)}
              >
                <TableCell className="pl-4 font-mono text-xs" title={formatAgo(event.createdAt)}>
                  {formatTimestamp(event.createdAt)}
                </TableCell>
                <TableCell className="font-mono text-xs">{event.eventType}</TableCell>
                <TableCell>
                  <StatusPill tone={ACTOR_TONE[event.actorType] ?? "neutral"}>
                    {event.actorType}
                  </StatusPill>
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {event.entityType}/{event.entityId}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Sheet open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          {selected ? (
            <>
              <SheetHeader>
                <SheetTitle className="font-mono text-sm">{selected.eventType}</SheetTitle>
                <SheetDescription>{formatTimestamp(selected.createdAt)}</SheetDescription>
              </SheetHeader>
              <div className="space-y-4 px-4 pb-6">
                <div className="space-y-1">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Before
                  </div>
                  <pre className="max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs">
                    {selected.before === null ? "null" : JSON.stringify(selected.before, null, 2)}
                  </pre>
                </div>
                <div className="space-y-1">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    After
                  </div>
                  <pre className="max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs">
                    {selected.after === null ? "null" : JSON.stringify(selected.after, null, 2)}
                  </pre>
                </div>
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </Section>
  );
}
