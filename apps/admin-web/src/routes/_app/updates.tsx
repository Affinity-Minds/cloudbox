// Owner: WT-18. OTA release management (master spec §18, §45; Slices 10.1-10.4). One screen
// request drives the table; the detail sheet is a second, and is client-side state (not a nested
// route, unlike Subscriptions) since nothing here needs a shareable deep link yet.
import type {
  AssignmentScope,
  Release,
  ReleaseAssignment,
  ReleaseChannel,
  ReleaseComponent,
  ReleaseDetailScreen,
  ReleaseListItem,
} from "@cloudbox/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import {
  AlertTriangle,
  Pin,
  Plus,
  RefreshCw,
  Rocket,
  ShieldOff,
  Trash2,
  Upload,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { describeError } from "@/api/client";
import {
  createAssignment,
  deleteAssignment,
  promoteRelease,
  releaseDetailQuery,
  releasesQuery,
  uploadRelease,
  withdrawRelease,
} from "@/api/releases";
import { EmptyState, ErrorState, PageHeader, Section } from "@/components/page";
import {
  ChannelPill,
  ReleaseStatusPill,
  ResultCountsRow,
  ResultStatePill,
} from "@/components/release-bits";
import { StatusPill } from "@/components/status-pill";
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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
import { Textarea } from "@/components/ui/textarea";
import { formatAgo, formatTimestamp } from "@/lib/time";

export const Route = createFileRoute("/_app/updates")({
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(releasesQuery);
  },
  component: UpdatesPage,
});

const COMPONENTS: ReleaseComponent[] = ["agent", "status", "setup", "connect"];
const CHANNELS: ReleaseChannel[] = ["development", "pilot", "stable", "pinned"];

const features = tableFeatures({});
const column = createColumnHelper<typeof features, ReleaseListItem>();

const columns = column.columns([
  column.accessor("component", {
    header: "Component",
    cell: (info) => <span className="font-mono text-xs">{info.getValue()}</span>,
  }),
  column.accessor("version", {
    header: "Version",
    cell: (info) => <span className="font-mono text-xs tabular-nums">{info.getValue()}</span>,
  }),
  column.accessor("channel", {
    header: "Channel",
    cell: (info) => <ChannelPill channel={info.getValue()} />,
  }),
  column.accessor("status", {
    header: "Status",
    cell: (info) => <ReleaseStatusPill status={info.getValue()} />,
  }),
  column.display({
    id: "results",
    header: "Results",
    cell: ({ row }) => <ResultCountsRow counts={row.original.resultCounts} />,
  }),
  column.accessor("assignmentCount", {
    header: "Assignments",
    cell: (info) => <span className="tabular-nums">{info.getValue()}</span>,
  }),
  column.accessor("createdAt", {
    header: "Created",
    cell: (info) => (
      <span className="font-mono text-xs" title={formatTimestamp(info.getValue())}>
        {formatAgo(info.getValue())}
      </span>
    ),
  }),
]);

function UpdatesPage() {
  const query = useQuery(releasesQuery);
  const [uploading, setUploading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const data = query.data?.items ?? [];
  const table = useTable({ features, columns, data, getRowId: (row) => row.id });

  return (
    <>
      <PageHeader
        title="Updates"
        description="OTA releases for Agent, Status, Setup and Connect. Every package is signed; a bad Pilot cannot casually reach the whole fleet."
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
            <Button size="sm" onClick={() => setUploading(true)}>
              <Upload />
              Upload release
            </Button>
          </>
        }
      />

      {query.isSuccess && !query.data.signingKeyConfigured ? (
        <div
          className="flex items-center gap-2 border-b bg-amber-500/10 px-4 py-2 text-xs"
          role="alert"
        >
          <AlertTriangle className="size-4 text-amber-600" />
          The release signing key (<span className="font-mono">RELEASE_SIGNING_JWK</span>) is not
          configured on this deployment; uploading will answer 503 until it is.
        </div>
      ) : null}

      {query.isSuccess ? (
        <div className="flex h-9 items-center gap-4 border-b px-4 text-xs text-muted-foreground">
          <span>
            {data.length} {data.length === 1 ? "release" : "releases"}
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
                    onClick={() => setSelectedId(row.original.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedId(row.original.id);
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
          No releases yet. Use <span className="font-medium text-foreground">Upload release</span>{" "}
          to publish the first Agent/Status/Setup/Connect package.
        </EmptyState>
      ) : null}

      <UploadSheet open={uploading} onOpenChange={setUploading} />
      {selectedId ? (
        <ReleaseDetailSheet id={selectedId} onClose={() => setSelectedId(null)} />
      ) : null}
    </>
  );
}

// ─── upload ───────────────────────────────────────────────────────────────────────────────────

function UploadSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [component, setComponent] = useState<ReleaseComponent>("agent");
  const [version, setVersion] = useState("");
  const [channel, setChannel] = useState<ReleaseChannel>("development");
  const [minAgentVersion, setMinAgentVersion] = useState("");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const mutation = useMutation({
    mutationFn: () => {
      if (!file) throw new Error("file is required");
      return uploadRelease({ file, component, version, channel, minAgentVersion, notes });
    },
    onSuccess: async (result) => {
      toast.success(`Uploaded ${result.release.component} ${result.release.version} (draft)`);
      onOpenChange(false);
      setVersion("");
      setMinAgentVersion("");
      setNotes("");
      setFile(null);
      await queryClient.invalidateQueries({ queryKey: ["screens", "releases"] });
    },
    onError: (error) => toast.error(`Upload failed: ${describeError(error)}`),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Upload release</DialogTitle>
          <DialogDescription>
            Streams into R2, hashed as it writes, and signed (ES256) before it can be assigned.
            Every new release starts as <span className="font-mono">draft</span>.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <FieldGroup className="gap-3">
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="rel-component">Component</FieldLabel>
                <SelectNative
                  id="rel-component"
                  value={component}
                  onChange={(e) => setComponent(e.target.value as ReleaseComponent)}
                >
                  {COMPONENTS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </SelectNative>
              </Field>
              <Field>
                <FieldLabel htmlFor="rel-channel">Target channel</FieldLabel>
                <SelectNative
                  id="rel-channel"
                  value={channel}
                  onChange={(e) => setChannel(e.target.value as ReleaseChannel)}
                >
                  {CHANNELS.filter((c) => c !== "pinned").map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </SelectNative>
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="rel-version">Version</FieldLabel>
              <Input
                id="rel-version"
                placeholder="1.4.2"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                required
              />
              <FieldDescription>Semantic version, e.g. 1.4.2 or 1.4.2-rc.1.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="rel-min-agent">Minimum Agent version</FieldLabel>
              <Input
                id="rel-min-agent"
                placeholder="optional"
                value={minAgentVersion}
                onChange={(e) => setMinAgentVersion(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="rel-notes">Release notes</FieldLabel>
              <Textarea
                id="rel-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                maxLength={4000}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="rel-file">Package</FieldLabel>
              <Input
                id="rel-file"
                type="file"
                required
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              <FieldDescription>
                Cap 200 MB. The object key is generated server-side.
              </FieldDescription>
            </Field>
          </FieldGroup>
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!file || !version || mutation.isPending}>
              {mutation.isPending ? "Uploading…" : "Upload"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── detail ───────────────────────────────────────────────────────────────────────────────────

type Pending =
  | { kind: "promote"; channel: ReleaseChannel }
  | { kind: "withdraw" }
  | { kind: "assign" }
  | null;

function ReleaseDetailSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const query = useQuery(releaseDetailQuery(id));
  const [pending, setPending] = useState<Pending>(null);
  const data = query.data;

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-3xl">
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center gap-2">
            {data ? (
              <>
                <span className="font-mono text-xs text-muted-foreground">
                  {data.release.component}
                </span>
                {data.release.version}
              </>
            ) : (
              "Release"
            )}
          </SheetTitle>
          <SheetDescription className="font-mono text-xs">{id}</SheetDescription>
          {data ? (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <ReleaseStatusPill status={data.release.status} />
              <ChannelPill channel={data.release.channel} />
              <PromoteActions release={data.release} onAction={setPending} />
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

        {data && pending?.kind === "promote" ? (
          <PromoteDialog data={data} channel={pending.channel} onClose={() => setPending(null)} />
        ) : null}
        {data && pending?.kind === "withdraw" ? (
          <WithdrawDialog data={data} onClose={() => setPending(null)} />
        ) : null}
        {data && pending?.kind === "assign" ? (
          <AssignDialog data={data} onClose={() => setPending(null)} />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function PromoteActions({
  release,
  onAction,
}: {
  release: Release;
  onAction: (pending: Pending) => void;
}) {
  if (release.status === "withdrawn") return null;
  if (release.status === "draft") {
    return (
      <Button
        size="xs"
        variant="outline"
        className="ml-auto"
        onClick={() => onAction({ kind: "promote", channel: "pilot" })}
      >
        <Rocket />
        Promote to pilot
      </Button>
    );
  }
  return (
    <span className="ml-auto flex gap-1">
      {release.status === "pilot" ? (
        <Button
          size="xs"
          variant="outline"
          onClick={() => onAction({ kind: "promote", channel: "stable" })}
        >
          <Rocket />
          Promote to stable
        </Button>
      ) : null}
      {release.status === "stable" ? (
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            onAction({
              kind: "promote",
              channel: release.channel === "pinned" ? "stable" : "pinned",
            })
          }
        >
          <Pin />
          {release.channel === "pinned" ? "Unpin (back to stable)" : "Pin this version"}
        </Button>
      ) : null}
      <Button size="xs" variant="destructive" onClick={() => onAction({ kind: "withdraw" })}>
        <ShieldOff />
        Withdraw
      </Button>
    </span>
  );
}

function DetailBody({
  data,
  onAction,
}: {
  data: ReleaseDetailScreen;
  onAction: (pending: Pending) => void;
}) {
  const r = data.release;
  return (
    <>
      {!data.signingKeyConfigured ? (
        <div
          className="flex items-center gap-2 border-b bg-amber-500/10 px-4 py-2 text-xs"
          role="alert"
        >
          <AlertTriangle className="size-4 text-amber-600" />
          <span className="font-mono">RELEASE_SIGNING_JWK</span> is not configured on this
          deployment.
        </div>
      ) : null}

      <Section title="Release">
        <KeyValue
          rows={[
            [
              "Package hash",
              <span key="h" className="break-all font-mono text-xs">
                {r.package.sha256}
              </span>,
            ],
            ["Package size", `${(r.package.sizeBytes / (1024 * 1024)).toFixed(1)} MB`],
            [
              "Object key",
              <span key="k" className="break-all font-mono text-xs">
                {r.package.r2Key}
              </span>,
            ],
            ["Minimum Agent version", r.minAgentVersion ?? "—"],
            ["Rollback of", r.rollbackOf ?? "—"],
            ["Notes", r.notes ?? "—"],
            ["Created by", r.createdBy],
            ["Created", formatTimestamp(r.createdAt)],
            ["Promoted", r.promotedAt ? formatTimestamp(r.promotedAt) : "—"],
            [
              "Withdrawn",
              r.withdrawnAt ? `${formatTimestamp(r.withdrawnAt)} — ${r.withdrawReason}` : "—",
            ],
          ]}
        />
      </Section>

      <Section
        title="Assignments"
        meta={
          <Button size="xs" variant="outline" onClick={() => onAction({ kind: "assign" })}>
            <Plus />
            Add assignment
          </Button>
        }
      >
        <AssignmentsTable data={data} />
      </Section>

      <Section title="Results" meta={`${data.results.length} reported`}>
        {data.results.length === 0 ? (
          <EmptyState>No device has reported a result for this release yet.</EmptyState>
        ) : (
          <Table className="text-sm">
            <TableHeader>
              <TableRow>
                <TableHead className="h-8 px-3 pl-4 text-xs">Device</TableHead>
                <TableHead className="h-8 px-3 text-xs">State</TableHead>
                <TableHead className="h-8 px-3 text-xs">Reported</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.results.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="px-3 py-1 pl-4 font-mono text-xs">
                    {item.deviceName}
                  </TableCell>
                  <TableCell className="px-3 py-1">
                    <ResultStatePill state={item.state} />
                  </TableCell>
                  <TableCell
                    className="px-3 py-1 font-mono text-xs"
                    title={formatTimestamp(item.reportedAt)}
                  >
                    {formatAgo(item.reportedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
    </>
  );
}

function useInvalidate(id: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["screens", "releases"] }),
      queryClient.invalidateQueries({ queryKey: ["screens", "releases", id] }),
    ]);
}

function AssignmentsTable({ data }: { data: ReleaseDetailScreen }) {
  const invalidate = useInvalidate(data.release.id);
  const removeMutation = useMutation({
    mutationFn: (assignmentId: string) => deleteAssignment(data.release.id, assignmentId),
    onSuccess: async () => {
      toast.success("Assignment removed");
      await invalidate();
    },
    onError: (error) => toast.error(`Could not remove: ${describeError(error)}`),
  });

  if (data.assignments.length === 0) {
    return (
      <EmptyState>
        No explicit assignment yet — devices of this component fall back to the newest
        <span className="mx-1 font-mono">stable</span>release, if any.
      </EmptyState>
    );
  }

  return (
    <Table className="text-sm">
      <TableHeader>
        <TableRow>
          <TableHead className="h-8 px-3 pl-4 text-xs">Scope</TableHead>
          <TableHead className="h-8 px-3 text-xs">Target</TableHead>
          <TableHead className="h-8 px-3 text-xs">Created</TableHead>
          <TableHead className="h-8 px-3 pr-4 text-right text-xs">—</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.assignments.map((a: ReleaseAssignment) => (
          <TableRow key={a.id}>
            <TableCell className="px-3 py-1 pl-4">
              <StatusPill tone="info">{a.scope.replace("_", " ")}</StatusPill>
            </TableCell>
            <TableCell className="px-3 py-1 font-mono text-xs">
              {a.scope === "device" ? (a.deviceName ?? a.deviceId) : null}
              {a.scope === "tenant" ? (a.tenantName ?? a.tenantId) : null}
              {a.scope === "fleet_percent" ? `${a.percent}% of fleet` : null}
            </TableCell>
            <TableCell className="px-3 py-1 font-mono text-xs" title={formatTimestamp(a.createdAt)}>
              {formatAgo(a.createdAt)}
            </TableCell>
            <TableCell className="px-3 py-1 pr-4 text-right">
              <Button
                size="xs"
                variant="ghost"
                onClick={() => removeMutation.mutate(a.id)}
                disabled={removeMutation.isPending}
              >
                <Trash2 />
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function PromoteDialog({
  data,
  channel,
  onClose,
}: {
  data: ReleaseDetailScreen;
  channel: ReleaseChannel;
  onClose: () => void;
}) {
  const invalidate = useInvalidate(data.release.id);
  const mutation = useMutation({
    mutationFn: () => promoteRelease(data.release.id, { channel }),
    onSuccess: async () => {
      toast.success(`Promoted to ${channel}`);
      await invalidate();
      onClose();
    },
    onError: (error) => toast.error(`Promote failed: ${describeError(error)}`),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Promote to {channel}</DialogTitle>
          <DialogDescription>
            {channel === "stable"
              ? "Requires the health gate: at least one installed_healthy result and zero installed_unhealthy/rolled_back results. Becomes the channel default for every device with no explicit assignment."
              : channel === "pinned"
                ? "Takes this release out of the broadcast default; only devices with an explicit assignment to it will see it."
                : "No gate. Devices only see it through an explicit device/tenant/percent assignment."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? "Promoting…" : `Promote to ${channel}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WithdrawDialog({ data, onClose }: { data: ReleaseDetailScreen; onClose: () => void }) {
  const invalidate = useInvalidate(data.release.id);
  const [reason, setReason] = useState("");
  const mutation = useMutation({
    mutationFn: () => withdrawRelease(data.release.id, { reason: reason.trim() }),
    onSuccess: async () => {
      toast.success("Release withdrawn");
      await invalidate();
      onClose();
    },
    onError: (error) => toast.error(`Withdraw failed: ${describeError(error)}`),
  });
  const valid = reason.trim().length >= 3;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Withdraw {data.release.component} {data.release.version}
          </DialogTitle>
          <DialogDescription>
            Terminal: a withdrawn release can no longer be assigned or promoted. Existing
            assignments stay recorded for audit but a device resolving updates will skip it.
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="withdraw-reason">Reason (required)</FieldLabel>
          <Textarea
            id="withdraw-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Regressed printing on shared workstations"
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
            {mutation.isPending ? "Withdrawing…" : "Withdraw"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AssignDialog({ data, onClose }: { data: ReleaseDetailScreen; onClose: () => void }) {
  const invalidate = useInvalidate(data.release.id);
  const [scope, setScope] = useState<AssignmentScope>("device");
  const [deviceId, setDeviceId] = useState(data.devices[0]?.id ?? "");
  const [tenantId, setTenantId] = useState(data.tenants[0]?.id ?? "");
  const [percent, setPercent] = useState("5");
  const draftLocked = data.release.status === "draft" && scope !== "device";

  const mutation = useMutation({
    mutationFn: () =>
      createAssignment(data.release.id, {
        scope,
        deviceId: scope === "device" ? deviceId : undefined,
        tenantId: scope === "tenant" ? tenantId : undefined,
        percent: scope === "fleet_percent" ? Number(percent) : undefined,
      }),
    onSuccess: async () => {
      toast.success("Assignment created");
      await invalidate();
      onClose();
    },
    onError: (error) => toast.error(`Could not assign: ${describeError(error)}`),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add assignment</DialogTitle>
          <DialogDescription>
            A device assignment beats a tenant assignment, which beats a fleet-percent bucket, which
            beats the channel default.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup className="gap-3">
          <Field>
            <FieldLabel htmlFor="assign-scope">Scope</FieldLabel>
            <SelectNative
              id="assign-scope"
              value={scope}
              onChange={(e) => setScope(e.target.value as AssignmentScope)}
            >
              <option value="device">Device</option>
              <option value="tenant">Tenant</option>
              <option value="fleet_percent">Fleet percentage</option>
            </SelectNative>
          </Field>
          {scope === "device" ? (
            <Field>
              <FieldLabel htmlFor="assign-device">Device</FieldLabel>
              <SelectNative
                id="assign-device"
                value={deviceId}
                onChange={(e) => setDeviceId(e.target.value)}
              >
                {data.devices.length === 0 ? <option value="">No enrolled device</option> : null}
                {data.devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} · {d.tenantName}
                  </option>
                ))}
              </SelectNative>
            </Field>
          ) : null}
          {scope === "tenant" ? (
            <Field>
              <FieldLabel htmlFor="assign-tenant">Tenant</FieldLabel>
              <SelectNative
                id="assign-tenant"
                value={tenantId}
                onChange={(e) => setTenantId(e.target.value)}
              >
                {data.tenants.length === 0 ? <option value="">No tenant</option> : null}
                {data.tenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.publicCode} · {t.displayName}
                  </option>
                ))}
              </SelectNative>
            </Field>
          ) : null}
          {scope === "fleet_percent" ? (
            <Field>
              <FieldLabel htmlFor="assign-percent">Percent of fleet</FieldLabel>
              <Input
                id="assign-percent"
                type="number"
                min={1}
                max={100}
                value={percent}
                onChange={(e) => setPercent(e.target.value)}
              />
              <FieldDescription>
                Deterministic by device id: raising the percentage only ever adds devices.
              </FieldDescription>
            </Field>
          ) : null}
          {draftLocked ? (
            <p className="text-xs text-destructive">
              A draft release can only be assigned to a specific device (the "internal lab" stage).
            </p>
          ) : null}
        </FieldGroup>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={
              mutation.isPending ||
              draftLocked ||
              (scope === "device" && !deviceId) ||
              (scope === "tenant" && !tenantId)
            }
          >
            {mutation.isPending ? "Assigning…" : "Assign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
