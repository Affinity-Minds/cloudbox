// Owner: WT-3. Single-use enrollment tokens per tenant. The tenant picker reuses the fleet
// screen's embedded tenant list (see api/devices.ts) until WT-2 ships a real tenants list.
import type { EnrollmentToken } from "@cloudbox/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Copy, KeyRound, Plus, RefreshCw, ShieldOff } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { describeError } from "@/api/client";
import {
  createEnrollmentToken,
  enrollmentTokensQuery,
  fleetQuery,
  revokeEnrollmentToken,
} from "@/api/devices";
import { EmptyState, ErrorState, PageHeader } from "@/components/page";
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
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
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

export const Route = createFileRoute("/_app/enrollment")({
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(fleetQuery({}));
  },
  component: EnrollmentPage,
});

type TokenState = "active" | "redeemed" | "revoked" | "expired";

function tokenState(token: EnrollmentToken): TokenState {
  if (token.revokedAt) return "revoked";
  if (token.redeemedAt) return "redeemed";
  if (token.expiresAt <= new Date().toISOString()) return "expired";
  return "active";
}

const STATE_TONE: Record<TokenState, Tone> = {
  active: "info",
  redeemed: "success",
  revoked: "danger",
  expired: "neutral",
};

function EnrollmentPage() {
  const tenants = useQuery(fleetQuery({}));
  const [tenantId, setTenantId] = useState("");
  const [creating, setCreating] = useState(false);
  const options = tenants.data?.tenants ?? [];
  const selectedTenant = tenantId || options[0]?.id || "";

  const tokens = useQuery(enrollmentTokensQuery(selectedTenant));

  return (
    <>
      <PageHeader
        title="Enrollment"
        description="Single-use tokens a device redeems at CloudBox Server Setup to enroll into a tenant."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => tokens.refetch()}
              disabled={!selectedTenant || tokens.isFetching}
            >
              <RefreshCw className={tokens.isFetching ? "animate-spin" : undefined} />
              Refresh
            </Button>
            <Button size="sm" onClick={() => setCreating(true)} disabled={!selectedTenant}>
              <Plus />
              New token
            </Button>
          </>
        }
      />

      <div className="flex items-center gap-2 border-b px-4 py-2">
        <span className="text-xs text-muted-foreground">Tenant</span>
        <NativeSelect
          className="w-64"
          value={selectedTenant}
          onChange={(event) => setTenantId(event.target.value)}
          disabled={tenants.isPending || options.length === 0}
        >
          {options.length === 0 ? <option value="">No tenants yet</option> : null}
          {options.map((t) => (
            <option key={t.id} value={t.id}>
              {t.publicCode} · {t.displayName}
            </option>
          ))}
        </NativeSelect>
      </div>

      {tenants.isSuccess && options.length === 0 ? (
        <EmptyState>
          No tenants yet. Enrollment tokens are issued per tenant; a tenant needs to exist first.
        </EmptyState>
      ) : null}

      {selectedTenant ? (
        tokens.isError ? (
          <ErrorState error={tokens.error} onRetry={() => tokens.refetch()} />
        ) : (
          <Table className="text-sm">
            <TableHeader>
              <TableRow>
                <TableHead className="h-8 px-3 text-xs">Label</TableHead>
                <TableHead className="h-8 px-3 text-xs">Status</TableHead>
                <TableHead className="h-8 px-3 text-xs">Created</TableHead>
                <TableHead className="h-8 px-3 text-xs">Expires</TableHead>
                <TableHead className="h-8 px-3 text-xs">Device</TableHead>
                <TableHead className="h-8 px-3 text-xs" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.isPending
                ? Array.from({ length: 3 }, (_, i) => (
                    <TableRow key={`skeleton-${i.toString()}`}>
                      {Array.from({ length: 6 }, (_, j) => (
                        <TableCell key={`cell-${j.toString()}`} className="h-8 px-3">
                          <Skeleton className="h-4 w-full" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                : (tokens.data ?? []).map((token) => (
                    <TokenRow key={token.id} token={token} tenantId={selectedTenant} />
                  ))}
            </TableBody>
          </Table>
        )
      ) : null}

      {selectedTenant && tokens.isSuccess && tokens.data.length === 0 ? (
        <EmptyState>
          No enrollment tokens yet for this tenant. Create one, then run CloudBox Server Setup on
          the machine and paste it in.
        </EmptyState>
      ) : null}

      {selectedTenant ? (
        <NewTokenDialog open={creating} onOpenChange={setCreating} tenantId={selectedTenant} />
      ) : null}
    </>
  );
}

function TokenRow({ token, tenantId }: { token: EnrollmentToken; tenantId: string }) {
  const state = tokenState(token);
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const mutation = useMutation({
    mutationFn: () => revokeEnrollmentToken(tenantId, token.id),
    onSuccess: async () => {
      toast.success(`"${token.label}" revoked`);
      setConfirming(false);
      await queryClient.invalidateQueries({ queryKey: ["enrollment-tokens", tenantId] });
    },
    onError: (error) => toast.error(`Could not revoke: ${describeError(error)}`),
  });

  return (
    <TableRow>
      <TableCell className="h-8 px-3 py-1">{token.label}</TableCell>
      <TableCell className="h-8 px-3 py-1">
        <StatusPill tone={STATE_TONE[state]}>{state}</StatusPill>
      </TableCell>
      <TableCell
        className="h-8 px-3 py-1 font-mono text-xs"
        title={formatTimestamp(token.createdAt)}
      >
        {formatAgo(token.createdAt)}
      </TableCell>
      <TableCell
        className="h-8 px-3 py-1 font-mono text-xs"
        title={formatTimestamp(token.expiresAt)}
      >
        {formatAgo(token.expiresAt)}
      </TableCell>
      <TableCell className="h-8 px-3 py-1 font-mono text-xs text-muted-foreground">
        {token.redeemedDeviceId ?? "—"}
      </TableCell>
      <TableCell className="h-8 px-3 py-1 text-right">
        {state === "active" ? (
          <Button size="xs" variant="ghost" onClick={() => setConfirming(true)}>
            <ShieldOff />
            Revoke
          </Button>
        ) : null}
      </TableCell>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Revoke "{token.label}"?</DialogTitle>
            <DialogDescription>
              The code stops working immediately. Any device that already redeemed it is unaffected
              — this only blocks a future redemption.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
            >
              {mutation.isPending ? "Revoking…" : "Revoke token"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TableRow>
  );
}

const EXPIRY_OPTIONS = [
  { hours: 1, label: "1 hour" },
  { hours: 24, label: "24 hours" },
  { hours: 72, label: "3 days" },
  { hours: 168, label: "7 days" },
];

function NewTokenDialog({
  open,
  onOpenChange,
  tenantId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
}) {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");
  const [expiresInHours, setExpiresInHours] = useState(24);
  const [issued, setIssued] = useState<{ token: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const mutation = useMutation({
    mutationFn: () => createEnrollmentToken(tenantId, { label, expiresInHours }),
    onSuccess: async (response) => {
      setIssued({ token: response.token, expiresAt: response.expiresAt });
      await queryClient.invalidateQueries({ queryKey: ["enrollment-tokens", tenantId] });
    },
    onError: (error) => toast.error(`Could not create: ${describeError(error)}`),
  });

  const reset = () => {
    setLabel("");
    setExpiresInHours(24);
    setIssued(null);
    setCopied(false);
  };

  const copy = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.token);
      setCopied(true);
      toast.success("Copied");
    } catch {
      toast.error("Could not copy — select and copy the code manually.");
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="sm:max-w-md">
        {issued ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <KeyRound className="size-4" />
                Enrollment code
              </DialogTitle>
              <DialogDescription>
                Shown once — copy it now. It expires {formatAgo(issued.expiresAt)} (
                {formatTimestamp(issued.expiresAt)}).
              </DialogDescription>
            </DialogHeader>
            <InputGroup>
              <InputGroupInput readOnly value={issued.token} className="font-mono tracking-wide" />
              <InputGroupAddon align="inline-end">
                <InputGroupButton onClick={copy} size="icon-xs" aria-label="Copy code">
                  <Copy />
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            <DialogFooter>
              <Button
                onClick={() => {
                  onOpenChange(false);
                  reset();
                }}
              >
                {copied ? "Done" : "Close"}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>New enrollment token</DialogTitle>
              <DialogDescription>
                Single-use. Run CloudBox Server Setup on the machine and paste the code in before it
                expires.
              </DialogDescription>
            </DialogHeader>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                mutation.mutate();
              }}
              className="space-y-3"
            >
              <Field>
                <FieldLabel htmlFor="token-label">Label</FieldLabel>
                <Input
                  id="token-label"
                  placeholder="e.g. Front desk PC"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  required
                />
                <FieldDescription>Helps you tell tokens apart in the list below.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="token-expiry">Expires in</FieldLabel>
                <NativeSelect
                  id="token-expiry"
                  value={expiresInHours}
                  onChange={(event) => setExpiresInHours(Number(event.target.value))}
                >
                  {EXPIRY_OPTIONS.map((option) => (
                    <option key={option.hours} value={option.hours}>
                      {option.label}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!label.trim() || mutation.isPending}>
                  {mutation.isPending ? "Creating…" : "Create token"}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
