// Owner: WT-19. Device backup history drawer: /api/v1/screens/backups/:deviceId (Jobs +
// Artifacts + Restore tests + Policy tabs, one request). Policy edits and restore-test records go
// through their own mutations and invalidate this and the list screen.
import type { BackupArtifact, BackupJob, RestoreOutcome, RestoreTest } from "@cloudbox/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { backupDeviceHistoryQuery, createRestoreTest, updateBackupPolicy } from "@/api/backups";
import { describeError } from "@/api/client";
import { BackupStatePill, formatBytes, RetentionClassPill } from "@/components/backup-bits";
import { EmptyState, ErrorState } from "@/components/page";
import { NativeSelect } from "@/components/subscription-bits";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { formatAgo, formatTimestamp } from "@/lib/time";

export const Route = createFileRoute("/_app/backups/$deviceId")({
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(backupDeviceHistoryQuery(params.deviceId));
  },
  component: DeviceBackupHistory,
});

const TABS = ["jobs", "artifacts", "restore-tests", "policy"] as const;
type Tab = (typeof TABS)[number];

function DeviceBackupHistory() {
  const { deviceId } = Route.useParams();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { tab?: string };
  const tab = (TABS as readonly string[]).includes(search.tab ?? "") ? (search.tab as Tab) : "jobs";
  const query = useQuery(backupDeviceHistoryQuery(deviceId));
  const data = query.data;
  const [recordingRestore, setRecordingRestore] = useState(false);

  const setTab = (next: Tab) =>
    navigate({ to: "/backups/$deviceId", params: { deviceId }, search: { tab: next } });

  return (
    <Sheet open onOpenChange={(open) => !open && navigate({ to: "/backups" })}>
      <SheetContent className="gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-2xl">
        <SheetHeader className="border-b">
          <SheetTitle>{data ? data.device.name : "Device backups"}</SheetTitle>
          <SheetDescription className="font-mono text-xs">
            {data ? `${data.device.tenantCode} · ${data.device.tenantName}` : deviceId}
          </SheetDescription>
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
              {value.replaceAll("-", " ")}
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

        {data && tab === "jobs" ? <JobsTab jobs={data.jobs} /> : null}
        {data && tab === "artifacts" ? <ArtifactsTab artifacts={data.artifacts} /> : null}
        {data && tab === "restore-tests" ? (
          <RestoreTestsTab
            restoreTests={data.restoreTests}
            onRecord={() => setRecordingRestore(true)}
          />
        ) : null}
        {data && tab === "policy" ? (
          <PolicyTab tenantId={data.device.tenantId} deviceId={deviceId} policy={data.policy} />
        ) : null}
      </SheetContent>

      {data ? (
        <RecordRestoreTestDialog
          open={recordingRestore}
          onOpenChange={setRecordingRestore}
          tenantId={data.device.tenantId}
          deviceId={deviceId}
          artifacts={data.artifacts.filter((a) => a.verifiedAt !== null && a.deletedAt === null)}
        />
      ) : null}
    </Sheet>
  );
}

function JobsTab({ jobs }: { jobs: BackupJob[] }) {
  if (jobs.length === 0) return <EmptyState>No backup jobs yet for this device.</EmptyState>;
  return (
    <Table className="text-sm">
      <TableHeader>
        <TableRow>
          <TableHead className="h-8 px-3 text-xs">Started</TableHead>
          <TableHead className="h-8 px-3 text-xs">Kind</TableHead>
          <TableHead className="h-8 px-3 text-xs">State</TableHead>
          <TableHead className="h-8 px-3 text-xs">Size</TableHead>
          <TableHead className="h-8 px-3 text-xs">Source</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {jobs.map((job) => (
          <TableRow key={job.id}>
            <TableCell
              className="h-8 px-3 py-1 font-mono text-xs"
              title={formatTimestamp(job.startedAt)}
            >
              {formatAgo(job.startedAt)}
            </TableCell>
            <TableCell className="h-8 px-3 py-1 text-xs capitalize">
              {job.kind.replaceAll("_", " ")}
            </TableCell>
            <TableCell className="h-8 px-3 py-1">
              <BackupStatePill state={job.state} />
            </TableCell>
            <TableCell className="h-8 px-3 py-1 font-mono text-xs">
              {formatBytes(job.sizeBytes)}
            </TableCell>
            <TableCell className="h-8 px-3 py-1 font-mono text-xs">{job.sourceDataset}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ArtifactsTab({ artifacts }: { artifacts: BackupArtifact[] }) {
  if (artifacts.length === 0) return <EmptyState>No offsite artifacts uploaded yet.</EmptyState>;
  return (
    <Table className="text-sm">
      <TableHeader>
        <TableRow>
          <TableHead className="h-8 px-3 text-xs">Uploaded</TableHead>
          <TableHead className="h-8 px-3 text-xs">Verified</TableHead>
          <TableHead className="h-8 px-3 text-xs">Size</TableHead>
          <TableHead className="h-8 px-3 text-xs">Retention</TableHead>
          <TableHead className="h-8 px-3 text-xs">Expires</TableHead>
          <TableHead className="h-8 px-3 text-xs">Deleted</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {artifacts.map((artifact) => (
          <TableRow key={artifact.id}>
            <TableCell className="h-8 px-3 py-1 font-mono text-xs">
              {formatTimestamp(artifact.uploadedAt)}
            </TableCell>
            <TableCell className="h-8 px-3 py-1 font-mono text-xs">
              {artifact.verifiedAt ? "yes" : "no"}
            </TableCell>
            <TableCell className="h-8 px-3 py-1 font-mono text-xs">
              {formatBytes(artifact.sizeBytes)}
            </TableCell>
            <TableCell className="h-8 px-3 py-1">
              <RetentionClassPill retentionClass={artifact.retentionClass} />
            </TableCell>
            <TableCell className="h-8 px-3 py-1 font-mono text-xs">
              {formatTimestamp(artifact.expiresAt)}
            </TableCell>
            <TableCell className="h-8 px-3 py-1 font-mono text-xs">
              {artifact.deletedAt ? formatTimestamp(artifact.deletedAt) : "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function RestoreTestsTab({
  restoreTests,
  onRecord,
}: {
  restoreTests: RestoreTest[];
  onRecord: () => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between p-3">
        <span className="text-xs text-muted-foreground">
          §23.9: a backup that has never been restored is unproven.
        </span>
        <Button size="xs" onClick={onRecord}>
          Record restore test
        </Button>
      </div>
      {restoreTests.length === 0 ? (
        <EmptyState>No restore drills recorded for this device yet.</EmptyState>
      ) : (
        <Table className="text-sm">
          <TableHeader>
            <TableRow>
              <TableHead className="h-8 px-3 text-xs">Performed</TableHead>
              <TableHead className="h-8 px-3 text-xs">Outcome</TableHead>
              <TableHead className="h-8 px-3 text-xs">Notes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {restoreTests.map((test) => (
              <TableRow key={test.id}>
                <TableCell className="h-8 px-3 py-1 font-mono text-xs">
                  {formatTimestamp(test.performedAt)}
                </TableCell>
                <TableCell className="h-8 px-3 py-1 text-xs capitalize">{test.outcome}</TableCell>
                <TableCell className="h-8 px-3 py-1 text-xs text-muted-foreground">
                  {test.notes ?? "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function PolicyTab({
  tenantId,
  deviceId,
  policy,
}: {
  tenantId: string;
  deviceId: string;
  policy: {
    frequentHours: number;
    dailyKeep: number;
    weeklyKeep: number;
    monthlyKeep: number;
    yearlyKeep: number;
    offsiteEnabled: boolean;
    isDefault: boolean;
  };
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(policy);
  const mutation = useMutation({
    mutationFn: () =>
      updateBackupPolicy(tenantId, {
        frequentHours: form.frequentHours,
        dailyKeep: form.dailyKeep,
        weeklyKeep: form.weeklyKeep,
        monthlyKeep: form.monthlyKeep,
        yearlyKeep: form.yearlyKeep,
        offsiteEnabled: form.offsiteEnabled,
      }),
    onSuccess: async () => {
      toast.success("Retention policy saved");
      await queryClient.invalidateQueries({ queryKey: ["screens", "backups", "device", deviceId] });
      await queryClient.invalidateQueries({ queryKey: ["screens", "backups"] });
    },
    onError: (error) => toast.error(`Could not save policy: ${describeError(error)}`),
  });

  const field = (key: keyof typeof form, label: string) => (
    <div className="flex flex-col gap-1 text-xs">
      <label htmlFor={`policy-${key}`} className="text-muted-foreground">
        {label}
      </label>
      <Input
        id={`policy-${key}`}
        type="number"
        min={0}
        value={form[key] as number}
        onChange={(e) => setForm((f) => ({ ...f, [key]: Number(e.target.value) }))}
      />
    </div>
  );

  return (
    <div className="space-y-4 p-4">
      <p className="text-xs text-muted-foreground">
        {policy.isDefault
          ? "This tenant follows the global default retention policy. Saving here creates its own."
          : "This tenant has its own retention policy."}
      </p>
      <div className="grid grid-cols-2 gap-3">
        {field("frequentHours", "Frequent backup interval (hours)")}
        {field("dailyKeep", "Keep daily (days)")}
        {field("weeklyKeep", "Keep weekly (weeks)")}
        {field("monthlyKeep", "Keep monthly (months)")}
        {field("yearlyKeep", "Keep yearly (years, 0 = off)")}
      </div>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={form.offsiteEnabled}
          onChange={(e) => setForm((f) => ({ ...f, offsiteEnabled: e.target.checked }))}
        />
        Offsite (cloud) replication enabled
      </label>
      <Button size="sm" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
        {mutation.isPending ? "Saving…" : "Save policy"}
      </Button>
    </div>
  );
}

function RecordRestoreTestDialog({
  open,
  onOpenChange,
  tenantId,
  deviceId,
  artifacts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  deviceId: string;
  artifacts: BackupArtifact[];
}) {
  const queryClient = useQueryClient();
  const [artifactId, setArtifactId] = useState(artifacts[0]?.id ?? "");
  const [outcome, setOutcome] = useState<RestoreOutcome>("success");
  const [notes, setNotes] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      createRestoreTest({ tenantId, deviceId, artifactId, outcome, notes: notes || undefined }),
    onSuccess: async () => {
      toast.success("Restore test recorded");
      onOpenChange(false);
      await queryClient.invalidateQueries({ queryKey: ["screens", "backups", "device", deviceId] });
      await queryClient.invalidateQueries({ queryKey: ["screens", "backups"] });
    },
    onError: (error) => toast.error(`Could not record: ${describeError(error)}`),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Record a restore test</DialogTitle>
          <DialogDescription>
            An operator-driven restore drill against a verified cloud artifact (§23.9).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex flex-col gap-1 text-xs">
            <label htmlFor="restore-test-artifact" className="text-muted-foreground">
              Artifact
            </label>
            <NativeSelect
              id="restore-test-artifact"
              value={artifactId}
              onChange={(e) => setArtifactId(e.target.value)}
            >
              {artifacts.length === 0 ? <option value="">No verified artifacts</option> : null}
              {artifacts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.id} · {formatTimestamp(a.uploadedAt)}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-1 text-xs">
            <label htmlFor="restore-test-outcome" className="text-muted-foreground">
              Outcome
            </label>
            <NativeSelect
              id="restore-test-outcome"
              value={outcome}
              onChange={(e) => setOutcome(e.target.value as RestoreOutcome)}
            >
              <option value="success">Success</option>
              <option value="partial">Partial</option>
              <option value="failure">Failure</option>
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-1 text-xs">
            <label htmlFor="restore-test-notes" className="text-muted-foreground">
              Notes (optional)
            </label>
            <Input
              id="restore-test-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending || !artifactId}>
            {mutation.isPending ? "Recording…" : "Record"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
