// Create/edit sheet. Nothing is written until Save (agent-notes ux-patterns): a new tenant has no
// id and does not exist until the create request lands; editing an existing tenant patches only
// the fields the form touched.
import { CreateTenantRequest, type Tenant, TenantStatus } from "@cloudbox/contracts";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import type { z } from "zod";
import { describeError } from "@/api/client";
import { createTenant, updateTenant } from "@/api/tenants";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";

const FormSchema = CreateTenantRequest.extend({
  status: TenantStatus.exclude(["archived"]).optional(),
});
type FormValues = z.input<typeof FormSchema>;

const EDITABLE_STATUSES = TenantStatus.exclude(["archived"]).options;

function toFormValues(tenant?: Tenant): FormValues {
  if (!tenant) return { displayName: "" };
  return {
    displayName: tenant.displayName,
    legalName: tenant.legalName ?? undefined,
    primaryContactEmail: tenant.primaryContactEmail ?? undefined,
    supportContactEmail: tenant.supportContactEmail ?? undefined,
    billingContactEmail: tenant.billingContactEmail ?? undefined,
    timezone: tenant.timezone,
    planCode: tenant.planCode ?? undefined,
    renewalWarningDays: tenant.renewalWarningDays,
    notes: tenant.notes ?? undefined,
    status: tenant.status === "archived" ? undefined : tenant.status,
  };
}

export function TenantFormSheet({
  open,
  onOpenChange,
  tenant,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Omit for create; pass the tenant being edited for edit. */
  tenant?: Tenant;
  onSaved?: (tenant: Tenant) => void;
}) {
  const queryClient = useQueryClient();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const isEdit = tenant !== undefined;

  const form = useForm<FormValues, unknown, z.output<typeof FormSchema>>({
    resolver: zodResolver(FormSchema),
    defaultValues: toFormValues(tenant),
  });

  // Re-seed the form when a different tenant opens for editing (or the sheet re-opens to create).
  // biome-ignore lint/correctness/useExhaustiveDependencies: form.reset is stable; only the sheet opening or the target tenant should re-seed it.
  useEffect(() => {
    if (open) form.reset(toFormValues(tenant));
  }, [open, tenant?.id]);

  const mutation = useMutation({
    mutationFn: (values: z.output<typeof FormSchema>) =>
      isEdit && tenant ? updateTenant(tenant.id, values) : createTenant(values),
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ["screens", "tenants"] });
      toast.success(isEdit ? "Tenant updated" : `Tenant created — ${saved.publicCode}`);
      onOpenChange(false);
      onSaved?.(saved);
    },
    onError: (error) => {
      toast.error("Could not save the tenant", { description: describeError(error) });
    },
  });

  const attemptClose = (next: boolean) => {
    if (!next && form.formState.isDirty && !mutation.isSuccess) {
      setConfirmDiscard(true);
      return;
    }
    onOpenChange(next);
  };

  return (
    <>
      <Sheet open={open} onOpenChange={attemptClose}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          <form
            id="tenant-form"
            onSubmit={form.handleSubmit((values) => mutation.mutate(values))}
            noValidate
          >
            <SheetHeader>
              <SheetTitle>{isEdit ? `Edit ${tenant.displayName}` : "New tenant"}</SheetTitle>
              <SheetDescription>
                {isEdit
                  ? "Changes are saved when you click Save."
                  : "A code (CBX-00001 style) is assigned when you save."}
              </SheetDescription>
            </SheetHeader>
            <FieldGroup className="px-4">
              <Field data-invalid={form.formState.errors.displayName ? true : undefined}>
                <FieldLabel htmlFor="displayName">Display name</FieldLabel>
                <Input id="displayName" autoFocus {...form.register("displayName")} />
                <FieldError errors={[form.formState.errors.displayName]} />
              </Field>
              <Field>
                <FieldLabel htmlFor="legalName">Legal name</FieldLabel>
                <Input id="legalName" {...form.register("legalName")} />
              </Field>
              <Field data-invalid={form.formState.errors.primaryContactEmail ? true : undefined}>
                <FieldLabel htmlFor="primaryContactEmail">Primary contact email</FieldLabel>
                <Input
                  id="primaryContactEmail"
                  type="email"
                  {...form.register("primaryContactEmail")}
                />
                <FieldError errors={[form.formState.errors.primaryContactEmail]} />
              </Field>
              <Field>
                <FieldLabel htmlFor="supportContactEmail">Support contact email</FieldLabel>
                <Input
                  id="supportContactEmail"
                  type="email"
                  {...form.register("supportContactEmail")}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="billingContactEmail">Billing contact email</FieldLabel>
                <Input
                  id="billingContactEmail"
                  type="email"
                  {...form.register("billingContactEmail")}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel htmlFor="timezone">Timezone</FieldLabel>
                  <Input id="timezone" placeholder="UTC" {...form.register("timezone")} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="planCode">Plan code</FieldLabel>
                  <Input id="planCode" placeholder="cloudbox-6" {...form.register("planCode")} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel htmlFor="renewalWarningDays">Renewal warning (days)</FieldLabel>
                  <Input
                    id="renewalWarningDays"
                    type="number"
                    min={1}
                    max={365}
                    {...form.register("renewalWarningDays", { valueAsNumber: true })}
                  />
                </Field>
                {isEdit ? (
                  <Field>
                    <FieldLabel htmlFor="status">Status</FieldLabel>
                    <SelectNative id="status" {...form.register("status")}>
                      {EDITABLE_STATUSES.map((status) => (
                        <option key={status} value={status}>
                          {status}
                        </option>
                      ))}
                    </SelectNative>
                  </Field>
                ) : null}
              </div>
              <Field>
                <FieldLabel htmlFor="notes">Notes</FieldLabel>
                <Textarea id="notes" rows={3} {...form.register("notes")} />
              </Field>
            </FieldGroup>
          </form>
          <SheetFooter>
            {mutation.isError ? (
              <p className="text-sm text-destructive">{describeError(mutation.error)}</p>
            ) : null}
            <Button type="submit" form="tenant-form" disabled={mutation.isPending}>
              {mutation.isPending ? "Saving…" : "Save"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => attemptClose(false)}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <Dialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>
              Nothing has been saved. Closing now loses what you entered.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmDiscard(false);
                onOpenChange(false);
              }}
            >
              Discard
            </Button>
            <Button variant="outline" onClick={() => setConfirmDiscard(false)}>
              Keep editing
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
