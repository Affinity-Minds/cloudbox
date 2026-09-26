// Owner: WT-1. One sign-in page, two entry points (ADR 0009):
// - Staff: email + password, then the six-digit code from their authenticator app (or a backup code).
// - Customers (tenant members): email, then a six-digit code sent by email.
// Customers never see a password field; staff never receive email codes.
import { Email } from "@cloudbox/contracts";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import {
  describeAuthError,
  sendOtp,
  sessionQuery,
  signInWithPassword,
  verifyBackupCode,
  verifyOtp,
  verifyTotp,
} from "@/api/auth";
import { ApiError } from "@/api/client";
import { AuthFrame, CodeBoxes } from "@/auth/auth-ui";
import { safeRedirect } from "@/auth/session";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const RESEND_SECONDS = 30;

type Mode = "staff" | "customer";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string; as?: Mode } => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
    as: search.as === "customer" ? "customer" : search.as === "staff" ? "staff" : undefined,
  }),
  beforeLoad: async ({ context, search }) => {
    const session = await context.queryClient.fetchQuery(sessionQuery).catch(() => null);
    if (session) throw redirect({ href: safeRedirect(search.redirect) });
  },
  component: LoginPage,
});

/** After any successful sign-in: drop the cached 401 and go where the user was headed. */
function useFinish() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { redirect: target } = Route.useSearch();
  return async () => {
    queryClient.removeQueries({ queryKey: sessionQuery.queryKey });
    // The console's guard sends staff with pending setup to /setup-password first.
    await navigate({ href: safeRedirect(target), replace: true });
  };
}

function LoginPage() {
  const search = Route.useSearch();
  const [mode, setMode] = useState<Mode>(search.as ?? "staff");
  return (
    <AuthFrame>
      <div role="tablist" aria-label="Who is signing in" className="mb-5 grid grid-cols-2 gap-2">
        {(
          [
            ["staff", "Staff sign-in", "Password + authenticator"],
            ["customer", "Customer sign-in", "Code by email"],
          ] as const
        ).map(([value, title, hint]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            onClick={() => setMode(value)}
            className={`rounded-md border px-3 py-2 text-left text-sm transition-colors ${
              mode === value
                ? "border-primary bg-primary/5"
                : "border-border text-muted-foreground hover:bg-muted/50"
            }`}
          >
            <span className="block font-medium text-foreground">{title}</span>
            <span className="block text-xs text-muted-foreground">{hint}</span>
          </button>
        ))}
      </div>
      {mode === "staff" ? <StaffSignIn /> : <CustomerSignIn />}
    </AuthFrame>
  );
}

/** Invisible to people, filled by bots; the server rejects any value (x-cloudbox-hp). */
function Honeypot(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="text"
      tabIndex={-1}
      autoComplete="new-password"
      aria-hidden="true"
      className="absolute -left-[10000px] h-px w-px overflow-hidden opacity-0"
      {...props}
    />
  );
}

function ErrorLine({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
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

// ─── Customers ──────────────────────────────────────────────────────────────────────────────

const EmailForm = z.object({ email: Email, website: z.string() });
type EmailForm = z.input<typeof EmailForm>;

function CustomerSignIn() {
  const [email, setEmail] = useState<string | null>(null);
  const [honeypot, setHoneypot] = useState("");
  return email === null ? (
    <EmailStep
      onSent={(sentTo, hp) => {
        setHoneypot(hp);
        setEmail(sentTo);
      }}
    />
  ) : (
    <CodeStep email={email} honeypot={honeypot} onChangeEmail={() => setEmail(null)} />
  );
}

function EmailStep({ onSent }: { onSent: (email: string, honeypot: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  const form = useForm<EmailForm, unknown, z.output<typeof EmailForm>>({
    resolver: zodResolver(EmailForm),
    defaultValues: { email: "", website: "" },
  });

  const submit = form.handleSubmit(async ({ email, website }) => {
    setError(null);
    try {
      await sendOtp(email, website);
      onSent(email, website);
    } catch (cause) {
      setError(describeAuthError(cause));
    }
  });

  const emailError = form.formState.errors.email;
  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <div>
        <h1 className="text-base font-semibold">Customer sign-in</h1>
        <p className="text-sm text-muted-foreground">
          Enter the email your organisation registered. If it can sign in, we email it a six-digit
          code.
        </p>
      </div>
      <Field data-invalid={emailError ? true : undefined}>
        <FieldLabel htmlFor="email">Email</FieldLabel>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          autoFocus
          aria-invalid={emailError ? true : undefined}
          {...form.register("email")}
        />
        <FieldError errors={emailError ? [{ message: "Enter a valid email address." }] : []} />
      </Field>
      <Honeypot {...form.register("website")} />
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
        {form.formState.isSubmitting ? <Loader2 className="animate-spin" /> : null}
        Continue
      </Button>
    </form>
  );
}

function useCountdown(seconds: number) {
  const [until, setUntil] = useState(() => Date.now() + seconds * 1000);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  const left = Math.max(0, Math.ceil((until - now) / 1000));
  return { left, restart: () => setUntil(Date.now() + seconds * 1000) };
}

function CodeStep({
  email,
  honeypot,
  onChangeEmail,
}: {
  email: string;
  honeypot: string;
  onChangeEmail: () => void;
}) {
  const finish = useFinish();
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const countdown = useCountdown(RESEND_SECONDS);
  const inFlight = useRef(false);

  async function verify(value: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setVerifying(true);
    setError(null);
    setNotice(null);
    try {
      await verifyOtp(email, value, honeypot);
      await finish();
    } catch (cause) {
      setError(describeAuthError(cause));
      setCode("");
      if (cause instanceof ApiError && cause.error === "too_many_attempts") countdown.restart();
    } finally {
      inFlight.current = false;
      setVerifying(false);
    }
  }

  async function resend() {
    setResending(true);
    setError(null);
    try {
      await sendOtp(email, honeypot);
      setCode("");
      // Nothing here may reveal whether the address exists (closed sign-in, ADR 0009).
      setNotice("If this address can sign in, the code is on its way again.");
      countdown.restart();
    } catch (cause) {
      setError(describeAuthError(cause));
    } finally {
      setResending(false);
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (code.length === 6) void verify(code);
      }}
    >
      <div>
        <h1 className="text-base font-semibold">Enter your code</h1>
        <p className="text-sm text-muted-foreground">
          If <span className="font-medium text-foreground">{email}</span> can sign in, a six-digit
          code is on its way. It expires in 5 minutes.
        </p>
      </div>
      <Field data-invalid={error ? true : undefined}>
        <CodeBoxes
          id="otp"
          label="Six-digit code"
          value={code}
          onChange={setCode}
          onComplete={(value) => void verify(value)}
          disabled={verifying}
          invalid={Boolean(error)}
        />
        {error ? (
          <FieldError>{error}</FieldError>
        ) : notice ? (
          <FieldDescription>{notice}</FieldDescription>
        ) : (
          <FieldDescription>
            Paste the whole code or type it; it submits by itself.
          </FieldDescription>
        )}
      </Field>
      <Button type="submit" className="w-full" disabled={verifying || code.length !== 6}>
        {verifying ? <Loader2 className="animate-spin" /> : null}
        {verifying ? "Checking…" : "Sign in"}
      </Button>
      <div className="flex items-center justify-between text-sm">
        <button
          type="button"
          className="text-muted-foreground underline-offset-4 hover:underline"
          onClick={onChangeEmail}
        >
          Use a different email
        </button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={countdown.left > 0 || resending}
          onClick={() => void resend()}
        >
          {countdown.left > 0 ? `Resend in ${countdown.left} s` : "Resend code"}
        </Button>
      </div>
    </form>
  );
}
