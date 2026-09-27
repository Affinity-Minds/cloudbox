// Owner: WT-5. Subscription detail drawer: /api/v1/screens/subscriptions/:id (one request).
// Licensing actions (Issue / Renew / Revoke) run behind confirmation dialogs; revoke needs a typed
// reason. The entitlement token itself never reaches this page.
import type {
  EntitlementHistoryItem,
  SubscriptionDetailScreen,
  SubscriptionDevice,
  SubscriptionStatus,
} from "@cloudbox/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, KeyRound, Pencil, RotateCw, ShieldOff } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { describeError } from "@/api/client";
import {
  type EntitlementAction,
  issueEntitlement,
  revokeEntitlement,
  subscriptionDetailQuery,
  updateSubscription,
} from "@/api/subscriptions";
import { EmptyState, ErrorState, Section } from "@/components/page";
import { formatMoney } from "@/components/plan-bits";
import { StatusPill } from "@/components/status-pill";
import {
  ExpiryPill,
  fromDateInput,
  KeyValue,
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
import { Textarea } from "@/components/ui/textarea";
import { formatAgo, formatTimestamp } from "@/lib/time";

export const Route = createFileRoute("/_app/subscriptions/$id")({
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(subscriptionDetailQuery(params.id));
  },
  component: SubscriptionDetail,
});

type Pending =
  | { kind: "issue" | "renew"; device: SubscriptionDevice }
  | { kind: "revoke"; device: SubscriptionDevice }
  | { kind: "edit" }
  | null;

function SubscriptionDetail() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const query = useQuery(subscriptionDetailQuery(id));
  const [pending, setPending] = useState<Pending>(null);
  const data = query.data;

  return (
    <Sheet open onOpenChange={(open) => !open && navigate({ to: "/subscriptions" })}>
      <SheetContent className="gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-3xl">
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center gap-2">
            {data ? (
              <>
                <span className="font-mono text-xs text-muted-foreground">
                  {data.subscription.tenantCode}
                </span>
                {data.subscription.tenantName}
              </>
            ) : (
              "Subscription"
            )}
          </SheetTitle>
          <SheetDescription className="font-mono text-xs">{id}</SheetDescription>
          {data ? (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <SubscriptionStatusPill status={data.subscription.status} />
              <ExpiryPill
                expiry={data.subscription.expiry}
                daysRemaining={data.subscription.daysRemaining}
              />
              <Button
                size="xs"
                variant="outline"
                className="ml-auto"
                disabled={data.subscription.status === "cancelled"}
                onClick={() => setPending({ kind: "edit" })}
              >
                <Pencil />
                Edit status / dates
              </Button>
            </div>
          ) : null}
        </SheetHeader>

        {query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : null}
        {query.isPending ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={`s-${i.toString()}`} className="h-5 w-full" />
            ))}
          </div>
        ) : null}
        {data ? <DetailBody data={data} onAction={setPending} /> : null}

        {data && pending?.kind === "edit" ? (
          <EditDialog data={data} onClose={() => setPending(null)} />
        ) : null}
        {data && (pending?.kind === "issue" || pending?.kind === "renew") ? (
          <IssueDialog
            data={data}
            action={pending.kind}
            device={pending.device}
            onClose={() => setPending(null)}
          />
        ) : null}
        {data && pending?.kind === "revoke" ? (
          <RevokeDialog data={data} device={pending.device} onClose={() => setPending(null)} />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function DetailBody({
  data,
  onAction,
}: {
  data: SubscriptionDetailScreen;
  onAction: (pending: Pending) => void;
}) {
  const sub = data.subscription;
  const warnFrom = sub.validUntil
    ? new Date(Date.parse(sub.validUntil) - sub.renewalWarningDays * 86_400_000)
    : null;

  return (
    <>
      {!data.signingKeyConfigured ? (
        <div
          className="flex items-center gap-2 border-b bg-amber-500/10 px-4 py-2 text-xs"
          role="alert"
        >
          <AlertTriangle className="size-4 text-amber-600" />
          The entitlement signing key (<span className="font-mono">ENTITLEMENT_SIGNING_JWK</span>)
          is not configured on this deployment; issuing will answer 503 until it is.
        </div>
      ) : null}

      <Section title="Subscription">
        <KeyValue
          rows={[
            ["Plan", `${data.plan.name} (${data.plan.code})`],
            ["Valid from", <Mono key="f" value={sub.validFrom} />],
            [
              "Valid until",
              <span key="u" className="flex items-center gap-2">
                <Mono value={sub.validUntil} />
                <span className="text-xs text-muted-foreground">
                  {sub.expiry === "pending"
                    ? "starts when the first server activates"
                    : sub.daysRemaining >= 0
                      ? `${sub.daysRemaining} days remaining`
                      : `expired ${-sub.daysRemaining} days ago`}
                </span>
              </span>,
            ],
            [
              "Renewal warning",
              <span key="w">
                {sub.renewalWarningDays} days before expiry{" "}
                <span className="text-xs text-muted-foreground">
                  {warnFrom ? `(from ${toDateInput(warnFrom.toISOString())})` : null}
                </span>
              </span>,
            ],
            ["Offline grace", `${sub.offlineGraceDays} days`],
            [
              "Managed users",
              sub.addonUsers > 0
                ? `${sub.effectiveMaxManagedUsers} (${sub.maxManagedUsers} + ${sub.addonUsers} add-on)`
                : `${sub.maxManagedUsers}`,
            ],
            ["Price (per term)", formatMoney(sub.totalPriceAmount, sub.currency)],
            ["Devices (plan)", `${data.plan.maxDevices}`],
            [
              "Features",
              <span key="x" className="flex flex-wrap gap-1">
                {sub.features.map((f) => (
                  <StatusPill key={f}>{f}</StatusPill>
                ))}
              </span>,
            ],
            ["Licensing", sub.issuable ? "entitlements can be issued" : "issuance blocked"],
          ]}
        />
      </Section>

      <Section title="Devices" meta={`${sub.devices.length} on this tenant`}>
        {sub.devices.length === 0 ? (
          <EmptyState>
            No devices enrolled for this tenant yet. Enrol one (Enrollment) to license it.
          </EmptyState>
        ) : (
          <Table className="text-sm">
            <TableHeader>
              <TableRow>
                <TableHead className="h-8 px-3 pl-4 text-xs">Device</TableHead>
                <TableHead className="h-8 px-3 text-xs">State</TableHead>
                <TableHead className="h-8 px-3 text-xs">Generation</TableHead>
                <TableHead className="h-8 px-3 text-xs">Licensed until</TableHead>
                <TableHead className="h-8 px-3 pr-4 text-right text-xs">License</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sub.devices.map((device) => {
                const live = device.currentGeneration !== null && !device.currentRevoked;
                const enrolled = device.status === "enrolled";
                return (
                  <TableRow key={device.id}>
                    <TableCell className="px-3 py-1 pl-4">
                      <div className="font-mono text-xs">{device.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {device.hostname} · seen {formatAgo(device.lastSeenAt)}
                      </div>
                    </TableCell>
                    <TableCell className="px-3 py-1">
                      <span className="flex flex-wrap gap-1">
                        <StatusPill tone={enrolled ? "success" : "danger"}>
                          {device.status}
                        </StatusPill>
                        {device.keyProtection === "software" ? (
                          <StatusPill tone="warning" title="Hardware key protection: DEGRADED">
                            key: software
                          </StatusPill>
                        ) : (
                          <StatusPill tone="info">key: tpm</StatusPill>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="px-3 py-1 font-mono text-xs tabular-nums">
                      {device.currentGeneration === null ? (
                        <span className="text-muted-foreground">unlicensed</span>
                      ) : (
                        <span className="flex items-center gap-1.5">
                          g{device.currentGeneration}
                          {device.currentRevoked ? (
                            <StatusPill tone="danger">revoked</StatusPill>
                          ) : (
                            <StatusPill tone="success">current</StatusPill>
                          )}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="px-3 py-1">
                      {device.currentValidUntil ? (
                        <Mono value={device.currentValidUntil} />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="px-3 py-1 pr-4">
                      <span className="flex justify-end gap-1">
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={!enrolled || !sub.issuable}
                          onClick={() => onAction({ kind: "issue", device })}
                        >
                          <KeyRound />
                          Issue
                        </Button>
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={!enrolled || !sub.issuable || !live}
                          onClick={() => onAction({ kind: "renew", device })}
                        >
                          <RotateCw />
                          Renew
                        </Button>
                        <Button
                          size="xs"
                          variant="destructive"
                          disabled={!live}
                          onClick={() => onAction({ kind: "revoke", device })}
                        >
                          <ShieldOff />
                          Revoke
                        </Button>
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section title="Entitlement history" meta={`${data.entitlements.length} issued`}>
        <History items={data.entitlements} devices={sub.devices} />
      </Section>
    </>
  );
}

function Mono({ value }: { value: string | null }) {
  if (!value) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <span className="font-mono text-xs tabular-nums" title={formatTimestamp(value)}>
      {toDateInput(value)}
    </span>
  );
}

function History({
  items,
  devices,
}: {
  items: EntitlementHistoryItem[];
  devices: SubscriptionDevice[];
}) {
  if (items.length === 0) {
    return <EmptyState>No entitlement has been issued to this tenant's devices.</EmptyState>;
  }
  const current = new Map(devices.map((d) => [d.id, d.currentGeneration]));
  return (
    <Table className="text-sm">
      <TableHeader>
        <TableRow>
          <TableHead className="h-8 px-3 pl-4 text-xs">Device</TableHead>
          <TableHead className="h-8 px-3 text-xs">Gen</TableHead>
          <TableHead className="h-8 px-3 text-xs">Issued</TableHead>
          <TableHead className="h-8 px-3 text-xs">Valid until</TableHead>
          <TableHead className="h-8 px-3 text-xs">State</TableHead>
          <TableHead className="h-8 px-3 text-xs">License id</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => {
          const state = item.revokedAt
            ? { tone: "danger" as const, label: `revoked ${toDateInput(item.revokedAt)}` }
            : current.get(item.deviceId) === item.generation
              ? { tone: "success" as const, label: "current" }
              : { tone: "neutral" as const, label: "superseded" };
          return (
            <TableRow key={item.id}>
              <TableCell className="px-3 py-1 pl-4 font-mono text-xs">{item.deviceName}</TableCell>
              <TableCell className="px-3 py-1 font-mono text-xs tabular-nums">
                g{item.generation}
              </TableCell>
              <TableCell className="px-3 py-1">
                <span
                  className="font-mono text-xs tabular-nums"
                  title={`${formatTimestamp(item.issuedAt)} by ${item.issuedBy}`}
                >
                  {formatTimestamp(item.issuedAt)}
                </span>
              </TableCell>
              <TableCell className="px-3 py-1">
                <Mono value={item.validUntil} />
              </TableCell>
              <TableCell className="px-3 py-1">
                <StatusPill tone={state.tone}>{state.label}</StatusPill>
              </TableCell>
              <TableCell className="max-w-40 truncate px-3 py-1 font-mono text-xs text-muted-foreground">
                {item.id}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function useInvalidate() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["screens"] });
}

function IssueDialog({
  data,
  action,
  device,
  onClose,
}: {
  data: SubscriptionDetailScreen;
  action: EntitlementAction;
  device: SubscriptionDevice;
  onClose: () => void;
}) {
  const invalidate = useInvalidate();
  const [validUntil, setValidUntil] = useState(toDateInput(data.subscription.validUntil));
  const next = (device.currentGeneration ?? 0) + 1;
  const mutation = useMutation({
    mutationFn: () =>
      issueEntitlement(
        device.id,
        action,
        validUntil ? { validUntil: fromDateInput(validUntil) } : {},
      ),
    onSuccess: async (result) => {
      toast.success(
        `${action === "issue" ? "Issued" : "Renewed"} generation ${result.entitlement.generation} for ${device.name}`,
      );
      await invalidate();
      onClose();
    },
    onError: (error) => toast.error(`${action} failed: ${describeError(error)}`),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {action === "issue" ? "Issue" : "Renew"} license for {device.name}
          </DialogTitle>
          <DialogDescription>
            Signs generation <span className="font-mono">g{next}</span> (ES256) and encrypts it to
            this device's enrolled key. Only that device can open it; older generations can no
            longer supersede it.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup className="gap-3">
          <Field>
            <FieldLabel htmlFor="lic-until">Valid until</FieldLabel>
            <Input
              id="lic-until"
              type="date"
              value={validUntil}
              max={toDateInput(data.subscription.validUntil)}
              onChange={(e) => setValidUntil(e.target.value)}
            />
            <FieldDescription>
              Capped at the subscription end ({toDateInput(data.subscription.validUntil)}). Offline
              grace {data.subscription.offlineGraceDays} d, {data.subscription.maxManagedUsers}{" "}
              managed users.
            </FieldDescription>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={!validUntil || mutation.isPending}>
            {mutation.isPending ? "Signing…" : `${action === "issue" ? "Issue" : "Renew"} g${next}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RevokeDialog({
  data,
  device,
  onClose,
}: {
  data: SubscriptionDetailScreen;
  device: SubscriptionDevice;
  onClose: () => void;
}) {
  const invalidate = useInvalidate();
  const [reason, setReason] = useState("");
  const live = data.entitlements.filter((e) => e.deviceId === device.id && !e.revokedAt);
  const mutation = useMutation({
    mutationFn: () => revokeEntitlement(device.id, { reason: reason.trim() }),
    onSuccess: async (result) => {
      toast.success(
        `Revoked ${result.revokedGenerations.map((g) => `g${g}`).join(", ")} for ${device.name}`,
      );
      await invalidate();
      onClose();
    },
    onError: (error) => toast.error(`Revoke failed: ${describeError(error)}`),
  });
  const valid = reason.trim().length >= 3;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Revoke license for {device.name}</DialogTitle>
          <DialogDescription>
            Revokes {live.map((e) => `g${e.generation}`).join(", ") || "every live generation"}. An
            online agent loses its license on its next check; an offline one within its grace window
            ({data.subscription.offlineGraceDays} d). The reason is recorded in the audit log.
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="revoke-reason">Reason (required)</FieldLabel>
          <Textarea
            id="revoke-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Hardware returned; replacement device enrolled"
            maxLength={500}
          />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => mutation.mutate()}
            disabled={!valid || mutation.isPending}
          >
            {mutation.isPending ? "Revoking…" : "Revoke license"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const STATUSES: SubscriptionStatus[] = [
  "pending",
  "trial",
  "active",
  "past_due",
  "suspended",
  "cancelled",
];

function EditDialog({ data, onClose }: { data: SubscriptionDetailScreen; onClose: () => void }) {
  const invalidate = useInvalidate();
  const sub = data.subscription;
  const [status, setStatus] = useState<SubscriptionStatus>(sub.status);
  const [validUntil, setValidUntil] = useState(toDateInput(sub.validUntil));
  const [warningDays, setWarningDays] = useState(String(sub.renewalWarningDays));
  const [addonUsers, setAddonUsers] = useState(String(sub.addonUsers));
  const addonUsersCount = Math.max(0, Number(addonUsers) || 0);
  const effectiveMaxUsers = sub.maxManagedUsers + addonUsersCount;
  const totalPrice = data.plan.priceAmount + addonUsersCount * data.plan.addonUserPriceAmount;
  const mutation = useMutation({
    mutationFn: () =>
      updateSubscription(sub.id, {
        status,
        // A pending subscription has no end date until it is redeemed (WT-14).
        ...(validUntil ? { validUntil: fromDateInput(validUntil) } : {}),
        renewalWarningDays: Number(warningDays),
        addonUsers: addonUsersCount,
      }),
    onSuccess: async () => {
      toast.success("Subscription updated");
      await invalidate();
      onClose();
    },
    onError: (error) => toast.error(`Update failed: ${describeError(error)}`),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit subscription</DialogTitle>
          <DialogDescription>
            Audited as SUBSCRIPTION_CHANGED with before/after. Cancelling is final: a new agreement
            is a new subscription. Issued licenses keep their dates until renewed or revoked.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup className="gap-3">
          <Field>
            <FieldLabel htmlFor="edit-status">Status</FieldLabel>
            <NativeSelect
              id="edit-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as SubscriptionStatus)}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="edit-until">Valid until</FieldLabel>
              <Input
                id="edit-until"
                type="date"
                value={validUntil}
                onChange={(e) => setValidUntil(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="edit-warn">Warning days</FieldLabel>
              <Input
                id="edit-warn"
                type="number"
                min={1}
                max={365}
                value={warningDays}
                onChange={(e) => setWarningDays(e.target.value)}
              />
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="edit-addon-users">Add-on users</FieldLabel>
            <Input
              id="edit-addon-users"
              type="number"
              min={0}
              max={data.plan.maxAddonUsers}
              disabled={data.plan.maxAddonUsers === 0}
              value={addonUsers}
              onChange={(e) => setAddonUsers(e.target.value)}
            />
            <FieldDescription>
              {data.plan.maxAddonUsers > 0
                ? `Up to ${data.plan.maxAddonUsers}, at ${formatMoney(data.plan.addonUserPriceAmount, data.plan.currency)} each per term.`
                : "This plan does not offer add-on users."}
            </FieldDescription>
          </Field>
          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Effective managed users</span>
              <span className="tabular-nums font-medium">{effectiveMaxUsers}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Total price (per term)</span>
              <span className="tabular-nums font-medium">
                {formatMoney(totalPrice, data.plan.currency)}
              </span>
            </div>
          </div>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={status === "cancelled" ? "destructive" : "default"}
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !validUntil}
          >
            {status === "cancelled" ? "Cancel subscription" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
