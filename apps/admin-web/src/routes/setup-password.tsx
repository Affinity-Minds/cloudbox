// Owner: WT-1. First staff sign-in, step 1 of 2 (ADR 0009): replace the initial password an admin
// set. The server refuses every staff route until this and the authenticator are done.
import { StaffPassword } from "@cloudbox/contracts";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { changePassword, describeAuthError, sessionQuery } from "@/api/auth";
import { AuthFrame } from "@/auth/auth-ui";
import { pendingSetupPath, requireSession } from "@/auth/session";
import { SetupSteps, SignOutLink } from "@/auth/setup-ui";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/setup-password")({
  beforeLoad: async ({ context, location }) => {
    const session = await requireSession(context.queryClient, location.href);
    const pending = pendingSetupPath(session);
    if (pending !== "/setup-password") throw redirect({ to: pending ?? "/" });
  },
  component: SetupPasswordPage,
});

const Form = z
  .object({ current: z.string().min(1), next: StaffPassword, confirm: z.string() })
  .refine((v) => v.next === v.confirm, { path: ["confirm"], message: "The passwords differ." })
  .refine((v) => v.next !== v.current, {
    path: ["next"],
    message: "Choose a password different from the initial one.",
  });
type Form = z.input<typeof Form>;

function SetupPasswordPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<Form>({
    resolver: zodResolver(Form),
    defaultValues: { current: "", next: "", confirm: "" },
  });
  const errors = form.formState.errors;

  const submit = form.handleSubmit(async ({ current, next }) => {
    setError(null);
    try {
      await changePassword(current, next);
      queryClient.removeQueries({ queryKey: sessionQuery.queryKey });
      await navigate({ to: "/setup-authenticator", replace: true });
    } catch (cause) {
      setError(describeAuthError(cause));
    }
  });

  return (
    <AuthFrame>
      <SetupSteps current={1} />
      <form onSubmit={submit} noValidate className="space-y-4">
        <div>
          <h1 className="text-base font-semibold">Choose your password</h1>
          <p className="text-sm text-muted-foreground">
            Replace the initial password you were given. Only you will know the new one.
          </p>
        </div>
        <Field data-invalid={errors.current ? true : undefined}>
          <FieldLabel htmlFor="current">Initial password</FieldLabel>
          <Input
            id="current"
            type="password"
            autoComplete="current-password"
            autoFocus
            {...form.register("current")}
          />
          <FieldError errors={errors.current ? [{ message: "Enter the initial password." }] : []} />
        </Field>
        <Field data-invalid={errors.next ? true : undefined}>
          <FieldLabel htmlFor="next">New password</FieldLabel>
          <Input id="next" type="password" autoComplete="new-password" {...form.register("next")} />
          {errors.next ? (
            <FieldError
              errors={[
                {
                  message:
                    errors.next.type === "custom"
                      ? errors.next.message
                      : "Use at least 12 characters.",
                },
              ]}
            />
          ) : (
            <FieldDescription>At least 12 characters. A passphrase works well.</FieldDescription>
          )}
        </Field>
        <Field data-invalid={errors.confirm ? true : undefined}>
          <FieldLabel htmlFor="confirm">Repeat the new password</FieldLabel>
          <Input
            id="confirm"
            type="password"
            autoComplete="new-password"
            {...form.register("confirm")}
          />
          <FieldError errors={errors.confirm ? [{ message: errors.confirm.message }] : []} />
        </Field>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? <Loader2 className="animate-spin" /> : null}
          Save and continue
        </Button>
        <SignOutLink />
      </form>
    </AuthFrame>
  );
}
