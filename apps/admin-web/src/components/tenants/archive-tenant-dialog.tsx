// Typed-name confirmation (agent-notes ux-patterns "Confirmations"): not security, a moment to
// notice which record is selected. Stays open on failure (409 refusal) and shows the reason.
import type { Tenant } from "@cloudbox/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { ApiError } from "@/api/client";
import { archiveTenant } from "@/api/tenants";
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

export function ArchiveTenantDialog({
  tenant,
  open,
  onOpenChange,
  onArchived,
}: {
  tenant: Tenant;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onArchived?: (tenant: Tenant) => void;
}) {
  const [typed, setTyped] = useState("");
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => archiveTenant(tenant.id),
    onSuccess: (archived) => {
      queryClient.invalidateQueries({ queryKey: ["screens", "tenants"] });
      toast.success(`${archived.displayName} archived`);
      setTyped("");
      onOpenChange(false);
      onArchived?.(archived);
    },
  });

  const matches = typed.trim() === tenant.displayName;
  const refusalReason =
    mutation.isError && mutation.error instanceof ApiError && mutation.error.status === 409
      ? String(mutation.error.detail ?? "Cannot archive this tenant right now.")
      : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setTyped("");
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Archive {tenant.displayName}?</DialogTitle>
          <DialogDescription>
            {tenant.publicCode} moves to <span className="font-mono">archived</span> and drops off
            the active tenant list. This cannot be undone from here.
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="confirm-name">
            Type <span className="font-medium">{tenant.displayName}</span> to confirm
          </FieldLabel>
          <Input
            id="confirm-name"
            autoFocus
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          <FieldDescription>
            Archiving is refused while devices are enrolled or a subscription is still open.
          </FieldDescription>
        </Field>
        {refusalReason ? (
          <p role="alert" className="text-sm text-destructive">
            {refusalReason}
          </p>
        ) : mutation.isError ? (
          <p role="alert" className="text-sm text-destructive">
            Could not archive. Try again.
          </p>
        ) : null}
        <DialogFooter>
          <Button
            variant="destructive"
            disabled={!matches || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? "Archiving…" : "Archive tenant"}
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
