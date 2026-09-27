// Owner: WT-15. Portal "Activate a server": Owner/Admin mint a one-time activation grant (WT-14's
// existing `POST /api/v1/onboarding/activation-grants`) and see the exact install line once.
import { useMutation, useQuery } from "@tanstack/react-query";
import { Copy, Server } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { describeError } from "@/api/client";
import { createActivationGrant } from "@/api/onboarding";
import { portalHomeQuery } from "@/api/portal";
import { EmptyState, ErrorState, PageHeader } from "@/components/page";
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
import { formatAgo, formatTimestamp } from "@/lib/time";
import { RequireActiveTenant } from "./require-active-tenant";

/** The installer download page doesn't exist yet — a placeholder link, per brief. */
const INSTALLER_DOWNLOAD_URL = "/downloads/cloudbox-agent";

function ActivatePanel({ tenantId }: { tenantId: string }) {
  const home = useQuery(portalHomeQuery(tenantId));
  const [confirming, setConfirming] = useState(false);
  const [label, setLabel] = useState("");
  const [issued, setIssued] = useState<{
    grant: string;
    tenantCode: string;
    expiresAt: string;
  } | null>(null);

  const mutation = useMutation({
    mutationFn: () => createActivationGrant({ tenantId, deviceLabel: label.trim() || undefined }),
    onSuccess: (response) => {
      setIssued({
        grant: response.grant,
        tenantCode: response.tenantCode,
        expiresAt: response.expiresAt,
      });
      setConfirming(false);
    },
    onError: (error) => toast.error("Could not activate", { description: describeError(error) }),
  });

  if (home.isPending) return null;
  if (home.isError) return <ErrorState error={home.error} onRetry={() => home.refetch()} />;

  if (home.data.standing === "user") {
    return (
      <EmptyState>
        Only an Owner or Admin of this organisation can activate a server. Ask one of them.
      </EmptyState>
    );
  }

  const installLine = issued ? `CloudBox.Agent.exe install --enroll-token ${issued.grant}` : "";

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Turn a Windows machine into a CloudBox server for{" "}
        <strong>{home.data.tenant.displayName}</strong> ({home.data.tenant.publicCode}). You'll need
        to run this on the machine itself.
      </p>
      <Field>
        <FieldLabel htmlFor="activate-label">Label (optional)</FieldLabel>
        <Input
          id="activate-label"
          placeholder="e.g. Front desk PC"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <FieldDescription>
          Helps you tell activations apart later, in Enrollment history.
        </FieldDescription>
      </Field>
      <Button onClick={() => setConfirming(true)}>
        <Server />
        Activate this machine as a server
      </Button>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              Activate this machine as a server for {home.data.tenant.publicCode}?
            </DialogTitle>
            <DialogDescription>
              Are you sure? This mints a one-time code, valid for 15 minutes, that turns the machine
              you run the installer on into this organisation's server.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button disabled={mutation.isPending} onClick={() => mutation.mutate()}>
              {mutation.isPending ? "Activating…" : "Activate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {issued ? (
        <div className="space-y-3 rounded-lg border p-4">
          <p className="text-sm font-medium">
            Shown once — copy it now. Expires {formatAgo(issued.expiresAt)} (
            {formatTimestamp(issued.expiresAt)}).
          </p>
          <InputGroup>
            <InputGroupInput readOnly value={installLine} className="font-mono text-xs" />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                aria-label="Copy install command"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(installLine);
                    toast.success("Copied");
                  } catch {
                    toast.error("Could not copy — select and copy it manually.");
                  }
                }}
              >
                <Copy />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          <p className="text-sm text-muted-foreground">
            Don't have the CloudBox Server Setup installer yet?{" "}
            <a
              href={INSTALLER_DOWNLOAD_URL}
              className="underline underline-offset-4"
              target="_blank"
              rel="noreferrer"
            >
              Download it
            </a>
            .
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function ActivatePage() {
  return (
    <>
      <PageHeader
        title="Activate a server"
        description="Turn a machine into a CloudBox server for this organisation."
      />
      <div className="pt-4">
        <RequireActiveTenant>
          {(tenantId) => <ActivatePanel tenantId={tenantId} />}
        </RequireActiveTenant>
      </div>
    </>
  );
}
