// Create/edit sheet for the plan designer. Nothing is written until Save (agent-notes
// ux-patterns): a new plan has no row until the create request lands; editing patches only the
// fields the form touched. `code` is immutable — editable only on create, disabled after.
import { CreatePlanRequest, Feature, type Plan, type UpdatePlanRequest } from "@cloudbox/contracts";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { describeError } from "@/api/client";
import { createPlan, updatePlan } from "@/api/plans";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";

const FEATURES = Feature.options;
const FEATURE_LABEL: Record<(typeof FEATURES)[number], string> = {
  remote_access: "Remote access",
  managed_backup: "Managed backup",
  fleet: "Fleet",
};

const blankToUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema);

const FormSchema = CreatePlanRequest.extend({
  description: blankToUndefined(CreatePlanRequest.shape.description),
});
type FormValues = z.input<typeof FormSchema>;

function toFormValues(plan?: Plan): FormValues {
  if (!plan) {
    return {
      code: "",
      name: "",
      description: undefined,
      maxDevices: 1,
      maxManagedUsers: 1,
      features: [],
      offlineGraceDays: 7,
      renewalWarningDays: 30,
      termDays: 365,
    };
  }
  return {
    code: plan.code,
    name: plan.name,
    description: plan.description ?? undefined,
    maxDevices: plan.maxDevices,
    maxManagedUsers: plan.maxManagedUsers,
    features: plan.features,
    offlineGraceDays: plan.offlineGraceDays,
    renewalWarningDays: plan.renewalWarningDays,
    termDays: plan.termDays,
  };
}

export function PlanFormSheet({
  open,
  onOpenChange,
  plan,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Omit for create; pass the plan being edited for edit. */
  plan?: Plan;
  onSaved?: (plan: Plan) => void;
}) {
  const queryClient = useQueryClient();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const isEdit = plan !== undefined;

  const form = useForm<FormValues, unknown, z.output<typeof FormSchema>>({
    resolver: zodResolver(FormSchema),
    defaultValues: toFormValues(plan),
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: form.reset is stable; only the sheet opening or the target plan should re-seed it.
  useEffect(() => {
    if (open) form.reset(toFormValues(plan));
  }, [open, plan?.code]);

  const mutation = useMutation({
    mutationFn: (values: z.output<typeof FormSchema>) => {
      if (isEdit && plan) {
        const patch: UpdatePlanRequest = {
          name: values.name,
          description: values.description ?? null,
          maxDevices: values.maxDevices,
          maxManagedUsers: values.maxManagedUsers,
          features: values.features,
          offlineGraceDays: values.offlineGraceDays,
          renewalWarningDays: values.renewalWarningDays,
          termDays: values.termDays,
        };
        return updatePlan(plan.code, patch);
      }
      return createPlan(values);
    },
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ["screens", "plans"] });
      queryClient.invalidateQueries({ queryKey: ["plans", "active"] });
      toast.success(isEdit ? "Plan updated" : `Plan created — ${saved.code}`);
      onOpenChange(false);
      onSaved?.(saved);
    },
    onError: (error) => {
      toast.error("Could not save the plan", { description: describeError(error) });
    },
  });

  const attemptClose = (next: boolean) => {
    if (!next && form.formState.isDirty && !mutation.isSuccess) {
      setConfirmDiscard(true);
      return;
    }
    onOpenChange(next);
  };

  const toggleFeature = (feature: (typeof FEATURES)[number], checked: boolean) => {
    const current = form.getValues("features") ?? [];
    form.setValue(
      "features",
      checked ? [...current, feature] : current.filter((f) => f !== feature),
      { shouldDirty: true },
    );
  };

  return (
    <>
      <Sheet open={open} onOpenChange={attemptClose}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          <form
            id="plan-form"
            onSubmit={form.handleSubmit((values) => mutation.mutate(values))}
            noValidate
          >
            <SheetHeader>
              <SheetTitle>{isEdit ? `Edit ${plan.name}` : "New plan"}</SheetTitle>
              <SheetDescription>
                {isEdit
                  ? "Changes are saved when you click Save. Retiring or reactivating is separate."
                  : "The code is permanent once saved."}
              </SheetDescription>
            </SheetHeader>
            <FieldGroup className="px-4">
              <div className="grid grid-cols-2 gap-3">
                <Field data-invalid={form.formState.errors.code ? true : undefined}>
                  <FieldLabel htmlFor="code">Code</FieldLabel>
                  <Input
                    id="code"
                    placeholder="cloudbox-6"
                    disabled={isEdit}
                    {...form.register("code")}
                  />
                  <FieldError errors={[form.formState.errors.code]} />
                  {!isEdit ? (
                    <FieldDescription>
                      Lowercase letters, digits and hyphens, 3–32 characters. Cannot be changed
                      later.
                    </FieldDescription>
                  ) : null}
                </Field>
                <Field data-invalid={form.formState.errors.name ? true : undefined}>
                  <FieldLabel htmlFor="name">Name</FieldLabel>
                  <Input id="name" autoFocus {...form.register("name")} />
                  <FieldError errors={[form.formState.errors.name]} />
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="description">Description</FieldLabel>
                <Textarea id="description" rows={2} {...form.register("description")} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field data-invalid={form.formState.errors.maxDevices ? true : undefined}>
                  <FieldLabel htmlFor="maxDevices">Max devices</FieldLabel>
                  <Input
                    id="maxDevices"
                    type="number"
                    min={1}
                    {...form.register("maxDevices", { valueAsNumber: true })}
                  />
                  <FieldError errors={[form.formState.errors.maxDevices]} />
                </Field>
                <Field data-invalid={form.formState.errors.maxManagedUsers ? true : undefined}>
                  <FieldLabel htmlFor="maxManagedUsers">Max managed users</FieldLabel>
                  <Input
                    id="maxManagedUsers"
                    type="number"
                    min={1}
                    {...form.register("maxManagedUsers", { valueAsNumber: true })}
                  />
                  <FieldError errors={[form.formState.errors.maxManagedUsers]} />
                </Field>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <Field data-invalid={form.formState.errors.offlineGraceDays ? true : undefined}>
                  <FieldLabel htmlFor="offlineGraceDays">Offline grace (days)</FieldLabel>
                  <Input
                    id="offlineGraceDays"
                    type="number"
                    min={0}
                    max={90}
                    {...form.register("offlineGraceDays", { valueAsNumber: true })}
                  />
                  <FieldError errors={[form.formState.errors.offlineGraceDays]} />
                </Field>
                <Field data-invalid={form.formState.errors.renewalWarningDays ? true : undefined}>
                  <FieldLabel htmlFor="renewalWarningDays">Renewal warning (days)</FieldLabel>
                  <Input
                    id="renewalWarningDays"
                    type="number"
                    min={1}
                    max={365}
                    {...form.register("renewalWarningDays", { valueAsNumber: true })}
                  />
                  <FieldError errors={[form.formState.errors.renewalWarningDays]} />
                </Field>
                <Field data-invalid={form.formState.errors.termDays ? true : undefined}>
                  <FieldLabel htmlFor="termDays">Term (days)</FieldLabel>
                  <Input
                    id="termDays"
                    type="number"
                    min={1}
                    max={3650}
                    {...form.register("termDays", { valueAsNumber: true })}
                  />
                  <FieldError errors={[form.formState.errors.termDays]} />
                </Field>
              </div>
              <Field>
                <FieldLabel>Features</FieldLabel>
                <div className="flex flex-wrap gap-4">
                  {FEATURES.map((feature) => (
                    <label key={feature} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="size-4 rounded border-input"
                        checked={form.watch("features")?.includes(feature) ?? false}
                        onChange={(event) => toggleFeature(feature, event.target.checked)}
                      />
                      {FEATURE_LABEL[feature]}
                    </label>
                  ))}
                </div>
                <FieldError errors={[form.formState.errors.features]} />
              </Field>
            </FieldGroup>
          </form>
          <SheetFooter>
            {mutation.isError ? (
              <p className="text-sm text-destructive">{describeError(mutation.error)}</p>
            ) : null}
            <Button type="submit" form="plan-form" disabled={mutation.isPending}>
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
