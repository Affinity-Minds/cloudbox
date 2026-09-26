import { CreateMembershipRequest, MembershipStanding } from "@cloudbox/contracts";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { describeError } from "@/api/client";
import { inviteMember } from "@/api/tenants";
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

export function InviteMemberDialog({
  tenantId,
  open,
  onOpenChange,
}: {
  tenantId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const form = useForm({
    resolver: zodResolver(CreateMembershipRequest),
    defaultValues: { email: "", standing: "user" as const },
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: form.reset is stable; only re-open should clear the form.
  useEffect(() => {
    if (open) form.reset({ email: "", standing: "user" });
  }, [open]);

  const mutation = useMutation({
    mutationFn: (values: { email: string; standing: "owner" | "admin" | "user" }) =>
      inviteMember(tenantId, values),
    onSuccess: (membership) => {
      queryClient.invalidateQueries({ queryKey: ["screens", "tenants", tenantId] });
      toast.success(`Invited ${membership.email}`);
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error("Could not invite this person", { description: describeError(error) });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={form.handleSubmit((values) => mutation.mutate(values))} noValidate>
          <DialogHeader>
            <DialogTitle>Invite a member</DialogTitle>
            <DialogDescription>
              They sign in with email OTP. No invite link to accept — the membership is active right
              away.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-2">
            <Field data-invalid={form.formState.errors.email ? true : undefined}>
              <FieldLabel htmlFor="invite-email">Email</FieldLabel>
              <Input id="invite-email" type="email" autoFocus {...form.register("email")} />
              <FieldError errors={[form.formState.errors.email]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="invite-standing">Standing</FieldLabel>
              <SelectNative id="invite-standing" {...form.register("standing")}>
                {MembershipStanding.options.map((standing) => (
                  <option key={standing} value={standing}>
                    {standing}
                  </option>
                ))}
              </SelectNative>
            </Field>
          </FieldGroup>
          {mutation.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {describeError(mutation.error)}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? "Inviting…" : "Invite"}
            </Button>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
