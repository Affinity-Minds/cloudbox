// Owner: WT-14. Server licence keys (ADR 0011): staff generate batches for resellers; a buyer
// redeems one at /start. Keys are shown once, at generation (copy / CSV); afterwards only the last
// four symbols exist for support.
import {
  type GenerateLicenseKeysResponse,
  LICENSE_KEY_REVOKE_REASON_CODES,
  type LicenseKeyListItem,
  type LicenseKeyStatus,
  type Plan,
} from "@cloudbox/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Copy, Download, KeyRound, Plus, RefreshCw, ShieldOff } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api, describeError } from "@/api/client";
import {
  batchCsv,
  generateLicenseKeys,
  licenseKeysQuery,
  revokeLicenseKey,
} from "@/api/license-keys";
import { EmptyState, ErrorState, PageHeader, Section } from "@/components/page";
import { formatMoney } from "@/components/plan-bits";
import {
  isReasonValid,
  ReasonSelect,
  type ReasonValue,
  reasonRequestBody,
} from "@/components/reason-select";
import { StatusPill, type Tone } from "@/components/status-pill";
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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
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
import { formatAgo, formatTimestamp } from "@/lib/time";

export const Route = createFileRoute("/_app/licences")({ component: LicencesPage });

type Shown = LicenseKeyStatus | "expired";
const TONE: Record<Shown, Tone> = {
  unredeemed: "info",
  redeemed: "success",
  revoked: "danger",
  expired: "neutral",
};
const shown = (item: LicenseKeyListItem): Shown => (item.expired ? "expired" : item.status);

const plansQuery = {
  queryKey: ["plans"],
  queryFn: () => api<{ items: Plan[] }>("/api/v1/plans"),
};

function LicencesPage() {
  const [batch, setBatch] = useState("");
  const [status, setStatus] = useState<LicenseKeyStatus | "">("");
  const [last4, setLast4] = useState("");
  const [generating, setGenerating] = useState(false);
  const [revoking, setRevoking] = useState<LicenseKeyListItem | null>(null);
  const filter = {
    batch: batch || undefined,
    status: status || undefined,
    last4: /^[0-9A-Za-z]{4}$/.test(last4) ? last4.toUpperCase() : undefined,
  };
  const keys = useQuery(licenseKeysQuery(filter));

  return (
    <>
      <PageHeader
        title="Licence keys"
        description="Server licence keys for resellers. A buyer redeems one when they sign up at /start."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => keys.refetch()}
              disabled={keys.isFetching}
            >
              <RefreshCw className={keys.isFetching ? "animate-spin" : undefined} />
              Refresh
            </Button>
            <Button size="sm" onClick={() => setGenerating(true)}>
              <Plus />
              Generate batch
            </Button>
          </>
        }
      />

      {keys.isError ? <ErrorState error={keys.error} onRetry={() => keys.refetch()} /> : null}

      <Section title="Batches" meta={keys.data ? `${keys.data.batches.length} batches` : null}>
        <Table className="text-sm">
          <TableHeader>
            <TableRow>
              <TableHead className="h-8 px-3 text-xs">Batch</TableHead>
              <TableHead className="h-8 px-3 text-xs">Plan</TableHead>
              <TableHead className="h-8 px-3 text-xs">Price</TableHead>
              <TableHead className="h-8 px-3 text-xs">Created</TableHead>
              <TableHead className="h-8 px-3 text-xs">Expires</TableHead>
              <TableHead className="h-8 px-3 text-right text-xs">Keys</TableHead>
              <TableHead className="h-8 px-3 text-right text-xs">Unredeemed</TableHead>
              <TableHead className="h-8 px-3 text-right text-xs">Redeemed</TableHead>
              <TableHead className="h-8 px-3 text-right text-xs">Revoked</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.isPending ? (
              <SkeletonRows columns={9} />
            ) : (
              (keys.data?.batches ?? []).map((b) => (
                <TableRow
                  key={b.batchId}
                  className="cursor-pointer"
                  data-state={batch === b.batchId ? "selected" : undefined}
                  onClick={() => setBatch(batch === b.batchId ? "" : b.batchId)}
                >
                  <TableCell className="h-8 px-3 py-1 font-medium">{b.batchLabel}</TableCell>
                  <TableCell className="h-8 px-3 py-1 font-mono text-xs">{b.planCode}</TableCell>
                  <TableCell
                    className="h-8 px-3 py-1 tabular-nums text-xs"
                    title="The plan's current price, for display only — not what this batch was sold for."
                  >
                    {formatMoney(b.planPriceAmount, b.planCurrency)}
                  </TableCell>
                  <TableCell
                    className="h-8 px-3 py-1 font-mono text-xs"
                    title={formatTimestamp(b.createdAt)}
                  >
                    {formatAgo(b.createdAt)}
                  </TableCell>
                  <TableCell className="h-8 px-3 py-1 font-mono text-xs">
                    {b.expiresAt ? b.expiresAt.slice(0, 10) : "never"}
                  </TableCell>
                  <TableCell className="h-8 px-3 py-1 text-right tabular-nums">{b.total}</TableCell>
                  <TableCell className="h-8 px-3 py-1 text-right tabular-nums">
                    {b.unredeemed}
                  </TableCell>
                  <TableCell className="h-8 px-3 py-1 text-right tabular-nums">
                    {b.redeemed}
                  </TableCell>
                  <TableCell className="h-8 px-3 py-1 text-right tabular-nums">
                    {b.revoked}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        {keys.isSuccess && keys.data.batches.length === 0 ? (
          <EmptyState>No licence keys yet. Generate a batch for a store.</EmptyState>
        ) : null}
      </Section>

      <Section title="Keys" meta={keys.data ? `${keys.data.items.length} shown` : null}>
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
          <span className="text-xs text-muted-foreground">Status</span>
          <NativeSelect
            className="w-40"
            value={status}
            onChange={(e) => setStatus(e.target.value as LicenseKeyStatus | "")}
          >
            <option value="">All</option>
            <option value="unredeemed">Unredeemed</option>
            <option value="redeemed">Redeemed</option>
            <option value="revoked">Revoked</option>
          </NativeSelect>
          <span className="ml-2 text-xs text-muted-foreground">Last four</span>
          <Input
            className="h-8 w-28 font-mono uppercase"
            maxLength={4}
            placeholder="XXXX"
            value={last4}
            onChange={(e) => setLast4(e.target.value)}
          />
          {batch ? (
            <Button size="xs" variant="ghost" onClick={() => setBatch("")}>
              Clear batch filter
            </Button>
          ) : null}
        </div>
        <Table className="text-sm">
          <TableHeader>
            <TableRow>
              <TableHead className="h-8 px-3 text-xs">Key</TableHead>
              <TableHead className="h-8 px-3 text-xs">Batch</TableHead>
              <TableHead className="h-8 px-3 text-xs">Status</TableHead>
              <TableHead className="h-8 px-3 text-xs">Redeemed by</TableHead>
              <TableHead className="h-8 px-3 text-xs">Tenant</TableHead>
              <TableHead className="h-8 px-3 text-xs" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.isPending ? (
              <SkeletonRows columns={6} />
            ) : (
              (keys.data?.items ?? []).map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="h-8 px-3 py-1 font-mono text-xs">
                    …{item.codeLast4}
                  </TableCell>
                  <TableCell className="h-8 px-3 py-1">{item.batchLabel}</TableCell>
                  <TableCell className="h-8 px-3 py-1">
                    <StatusPill tone={TONE[shown(item)]} title={item.revokeReason ?? undefined}>
                      {shown(item)}
                    </StatusPill>
                  </TableCell>
                  <TableCell className="h-8 px-3 py-1 text-xs">
                    {item.redeemedByEmail ?? "—"}
                  </TableCell>
                  <TableCell className="h-8 px-3 py-1 font-mono text-xs">
                    {item.redeemedTenantCode ?? "—"}
                  </TableCell>
                  <TableCell className="h-8 px-3 py-1 text-right">
                    {item.status === "unredeemed" ? (
                      <Button size="xs" variant="ghost" onClick={() => setRevoking(item)}>
                        <ShieldOff />
                        Revoke
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        {keys.isSuccess && keys.data.items.length === 0 ? (
          <EmptyState>No keys match these filters.</EmptyState>
        ) : null}
      </Section>

      <GenerateDialog open={generating} onOpenChange={setGenerating} />
      <RevokeDialog item={revoking} onClose={() => setRevoking(null)} />
    </>
  );
}

function SkeletonRows({ columns }: { columns: number }) {
  return Array.from({ length: 3 }, (_, i) => (
    <TableRow key={`s-${i.toString()}`}>
      {Array.from({ length: columns }, (_, j) => (
        <TableCell key={`c-${j.toString()}`} className="h-8 px-3">
          <Skeleton className="h-4 w-full" />
        </TableCell>
      ))}
    </TableRow>
  ));
}

function download(batch: GenerateLicenseKeysResponse) {
  const blob = new Blob([batchCsv(batch)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `cloudbox-licence-keys-${batch.batchLabel.replace(/[^\w-]+/g, "-")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function GenerateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const plans = useQuery({ ...plansQuery, enabled: open });
  const [planCode, setPlanCode] = useState("");
  const [quantity, setQuantity] = useState("10");
  const [label, setLabel] = useState("");
  const [expires, setExpires] = useState("");
  const [batch, setBatch] = useState<GenerateLicenseKeysResponse | null>(null);
  const plan = planCode || plans.data?.items[0]?.code || "";

  const mutation = useMutation({
    mutationFn: () =>
      generateLicenseKeys({
        planCode: plan,
        quantity: Number(quantity),
        batchLabel: label,
        ...(expires ? { expiresAt: new Date(`${expires}T23:59:59.000Z`).toISOString() } : {}),
      }),
    onSuccess: async (result) => {
      setBatch(result);
      await queryClient.invalidateQueries({ queryKey: ["license-keys"] });
    },
    onError: (error) => toast.error(`Could not generate: ${describeError(error)}`),
  });

  const close = () => {
    onOpenChange(false);
    setBatch(null);
    setLabel("");
    setExpires("");
    setQuantity("10");
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-lg">
        {batch ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <KeyRound className="size-4" />
                {batch.count} keys · {batch.batchLabel}
              </DialogTitle>
              <DialogDescription>
                Shown once. Copy them or download the CSV now; afterwards only the last four symbols
                are kept.
              </DialogDescription>
            </DialogHeader>
            <pre className="max-h-64 overflow-auto rounded-md border bg-muted p-3 font-mono text-xs leading-5">
              {batch.keys.map((k) => k.code).join("\n")}
            </pre>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(batch.keys.map((k) => k.code).join("\n"));
                    toast.success("Copied");
                  } catch {
                    toast.error("Could not copy. Select the keys and copy them manually.");
                  }
                }}
              >
                <Copy />
                Copy all
              </Button>
              <Button variant="outline" onClick={() => download(batch)}>
                <Download />
                Download CSV
              </Button>
              <Button onClick={close}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Generate licence keys</DialogTitle>
              <DialogDescription>
                One key activates one organisation on the chosen plan. The plan starts when the
                buyer's first server is activated.
              </DialogDescription>
            </DialogHeader>
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                mutation.mutate();
              }}
            >
              <Field>
                <FieldLabel htmlFor="lk-plan">Plan</FieldLabel>
                <NativeSelect
                  id="lk-plan"
                  value={plan}
                  onChange={(e) => setPlanCode(e.target.value)}
                  disabled={plans.isPending}
                >
                  {(plans.data?.items ?? []).map((p) => (
                    <option key={p.code} value={p.code}>
                      {p.name} ({p.code}) · {p.maxDevices} server{p.maxDevices === 1 ? "" : "s"}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel htmlFor="lk-qty">Quantity</FieldLabel>
                  <Input
                    id="lk-qty"
                    type="number"
                    min={1}
                    max={500}
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="lk-exp">Expires (optional)</FieldLabel>
                  <Input
                    id="lk-exp"
                    type="date"
                    value={expires}
                    onChange={(e) => setExpires(e.target.value)}
                  />
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="lk-label">Batch label</FieldLabel>
                <Input
                  id="lk-label"
                  placeholder="e.g. Store A — October"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
                <FieldDescription>Which store or order these keys are for.</FieldDescription>
              </Field>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={close}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={
                    !plan ||
                    !label.trim() ||
                    !(Number(quantity) >= 1 && Number(quantity) <= 500) ||
                    mutation.isPending
                  }
                >
                  {mutation.isPending ? "Generating…" : "Generate"}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

const LICENSE_KEY_REVOKE_REASON_LABELS: Record<
  (typeof LICENSE_KEY_REVOKE_REASON_CODES)[number],
  string
> = {
  store_return: "Store return",
  issued_in_error: "Issued in error",
  lost_or_leaked: "Lost or leaked",
  batch_withdrawn: "Batch withdrawn",
  other: "Other",
};

function RevokeDialog({ item, onClose }: { item: LicenseKeyListItem | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState<ReasonValue>({ code: "" });
  const mutation = useMutation({
    mutationFn: () => revokeLicenseKey(item?.id ?? "", reasonRequestBody(reason)),
    onSuccess: async () => {
      toast.success(`Key …${item?.codeLast4} revoked`);
      setReason({ code: "" });
      onClose();
      await queryClient.invalidateQueries({ queryKey: ["license-keys"] });
    },
    onError: (error) => toast.error(`Could not revoke: ${describeError(error)}`),
  });
  return (
    <Dialog open={item !== null} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Revoke key …{item?.codeLast4}?</DialogTitle>
          <DialogDescription>
            Nobody can redeem it afterwards; a buyer who tries is told the key is not valid. Already
            redeemed keys cannot be revoked here.
          </DialogDescription>
        </DialogHeader>
        <ReasonSelect
          options={LICENSE_KEY_REVOKE_REASON_CODES.map((code) => ({
            code,
            label: LICENSE_KEY_REVOKE_REASON_LABELS[code],
          }))}
          value={reason}
          onChange={setReason}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!isReasonValid(reason) || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? "Revoking…" : "Revoke key"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
