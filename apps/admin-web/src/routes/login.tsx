// Owner: WT-1. Staff sign-in (ops console, owner decision: a separate, discreet surface under
// OPS_BASE_PATH): email + password, then the six-digit code from the authenticator app (or a
// backup code). Staff identities are their own system (/api/ops/auth, ADR 0002/0009); customers
// sign in at /login on the customer surface, which never links here.
import { Email } from "@cloudbox/contracts";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import {
  describeAuthError,
  sessionQuery,
  signInWithPassword,
  verifyBackupCode,
  verifyTotp,
} from "@/api/auth";
import { ApiError } from "@/api/client";
import { AuthFrame, CodeBoxes } from "@/auth/auth-ui";
import { ErrorLine, Honeypot } from "@/auth/form-bits";
import { safeRedirect, withBase } from "@/auth/session";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
  }),
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.fetchQuery(sessionQuery).catch(() => null);
    if (session) throw redirect({ to: "/" });
  },
  component: StaffLoginPage,
});

/** After sign-in: drop the cached 401 and go where the user was headed (inside the console). */
function useFinish() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { redirect: target } = Route.useSearch();
  return async () => {
    queryClient.removeQueries({ queryKey: sessionQuery.queryKey });
    // The console's guard sends staff with pending setup to /setup-password first.
    router.history.replace(withBase(router.basepath, safeRedirect(target)));
  };
}

function StaffLoginPage() {
  return (
    <AuthFrame>
      <StaffSignIn />
    </AuthFrame>
  );
}

// ─── Staff ──────────────────────────────────────────────────────────────────────────────────

const StaffForm = z.object({ email: Email, password: z.string().min(1), website: z.string() });
type StaffForm = z.input<typeof StaffForm>;

function StaffSignIn() {
  const [step, setStep] = useState<"password" | "code">("password");
  const [email, setEmail] = useState("");
  return step === "password" ? (
    <StaffPasswordStep
      onSecondFactor={(address) => {
        setEmail(address);
        setStep("code");
      }}
    />
  ) : (
    <StaffCodeStep email={email} onRestart={() => setStep("password")} />
  );
}

function StaffPasswordStep({ onSecondFactor }: { onSecondFactor: (email: string) => void }) {
  const finish = useFinish();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<StaffForm, unknown, z.output<typeof StaffForm>>({
    resolver: zodResolver(StaffForm),
    defaultValues: { email: "", password: "", website: "" },
  });

  const submit = form.handleSubmit(async ({ email, password, website }) => {
    setError(null);
    try {
      const result = await signInWithPassword(email, password, website);
      if (result?.twoFactorRedirect) onSecondFactor(email);
      else await finish();
    } catch (cause) {
      form.resetField("password");
      setError(describeAuthError(cause));
    }
  });

  const errors = form.formState.errors;
  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <div>
        <h1 className="text-base font-semibold">Staff sign-in</h1>
        <p className="text-sm text-muted-foreground">
          Your CloudBox staff email and password. Your authenticator app comes next.
        </p>
      </div>
      <Field data-invalid={errors.email ? true : undefined}>
        <FieldLabel htmlFor="staff-email">Email</FieldLabel>
        <Input
          id="staff-email"
          type="email"
          autoComplete="username"
          inputMode="email"
          autoFocus
          aria-invalid={errors.email ? true : undefined}
          {...form.register("email")}
        />
        <FieldError errors={errors.email ? [{ message: "Enter a valid email address." }] : []} />
      </Field>
      <Field data-invalid={errors.password ? true : undefined}>
        <FieldLabel htmlFor="staff-password">Password</FieldLabel>
        <Input
          id="staff-password"
          type="password"
          autoComplete="current-password"
          aria-invalid={errors.password ? true : undefined}
          {...form.register("password")}
        />
        <FieldError errors={errors.password ? [{ message: "Enter your password." }] : []} />
      </Field>
      <Honeypot {...form.register("website")} />
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
        {form.formState.isSubmitting ? <Loader2 className="animate-spin" /> : null}
        Continue
      </Button>
      <p className="text-xs text-muted-foreground">
        Forgot your password? Ask a CloudBox super admin to set a new initial password.
      </p>
    </form>
  );
}

function StaffCodeStep({ email, onRestart }: { email: string; onRestart: () => void }) {
  const finish = useFinish();
  const [useBackup, setUseBackup] = useState(false);
  const [code, setCode] = useState("");
  const [backup, setBackup] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function submit(run: () => Promise<unknown>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await run();
      await finish();
    } catch (cause) {
      setCode("");
      setBackup("");
      if (
        cause instanceof ApiError &&
        ["too_many_attempts_request_new_code", "invalid_two_factor_cookie"].includes(cause.error)
      ) {
        onRestart();
        return;
      }
      setError(describeAuthError(cause));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (useBackup && backup.trim()) void submit(() => verifyBackupCode(backup.trim()));
        else if (!useBackup && code.length === 6) void submit(() => verifyTotp(code));
      }}
    >
      <div>
        <h1 className="text-base font-semibold">
          {useBackup ? "Enter a backup code" : "Enter your authenticator code"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {useBackup ? (
            <>Each backup code works once.</>
          ) : (
            <>
              The six-digit code for <span className="font-medium text-foreground">{email}</span>{" "}
              from your authenticator app.
            </>
          )}
        </p>
      </div>
      <Field data-invalid={error ? true : undefined}>
        {useBackup ? (
          <>
            <FieldLabel htmlFor="backup-code">Backup code</FieldLabel>
            <Input
              id="backup-code"
              autoComplete="one-time-code"
              autoFocus
              spellCheck={false}
              className="font-mono"
              value={backup}
              onChange={(event) => setBackup(event.target.value)}
              aria-invalid={error ? true : undefined}
            />
          </>
        ) : (
          <CodeBoxes
            id="totp"
            label="Six-digit authenticator code"
            value={code}
            onChange={setCode}
            onComplete={(value) => void submit(() => verifyTotp(value))}
            disabled={busy}
            invalid={Boolean(error)}
          />
        )}
        {error ? (
          <FieldError>{error}</FieldError>
        ) : useBackup ? null : (
          <FieldDescription>It submits by itself on the sixth digit.</FieldDescription>
        )}
      </Field>
      <Button
        type="submit"
        className="w-full"
        disabled={busy || (useBackup ? !backup.trim() : code.length !== 6)}
      >
        {busy ? <Loader2 className="animate-spin" /> : null}
        {busy ? "Checking…" : "Sign in"}
      </Button>
      <div className="flex items-center justify-between text-sm">
        <button
          type="button"
          className="text-muted-foreground underline-offset-4 hover:underline"
          onClick={onRestart}
        >
          Start again
        </button>
        <button
          type="button"
          className="text-muted-foreground underline-offset-4 hover:underline"
          onClick={() => {
            setUseBackup((value) => !value);
            setError(null);
          }}
        >
          {useBackup ? "Use the authenticator app" : "Use a backup code"}
        </button>
      </div>
    </form>
  );
}
