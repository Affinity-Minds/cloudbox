// Owner: WT-1. Email OTP sign-in: email step → six-digit code step (agent-notes ux-patterns
// "One-time codes": six boxes, submit on the sixth digit, paste fills all, 30 s resend timer,
// autocomplete="one-time-code", server-enforced honeypot).
import { Email } from "@cloudbox/contracts";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { Box, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { describeAuthError, sendOtp, sessionQuery, verifyOtp } from "@/api/auth";
import { ApiError } from "@/api/client";
import { safeRedirect } from "@/auth/session";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";

const RESEND_SECONDS = 30;

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
  }),
  beforeLoad: async ({ context, search }) => {
    const session = await context.queryClient.fetchQuery(sessionQuery).catch(() => null);
    if (session) throw redirect({ href: safeRedirect(search.redirect) });
  },
  component: LoginPage,
});

const EmailForm = z.object({ email: Email, website: z.string() });
type EmailForm = z.input<typeof EmailForm>;

function LoginPage() {
  const [email, setEmail] = useState<string | null>(null);
  const [honeypot, setHoneypot] = useState("");

  return (
    <main className="flex min-h-svh items-start justify-center bg-background px-4 pt-[18vh]">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Box className="size-4" />
          </div>
          <span className="text-sm font-semibold">CloudBox</span>
        </div>
        {email === null ? (
          <EmailStep
            onSent={(sentTo, hp) => {
              setHoneypot(hp);
              setEmail(sentTo);
            }}
          />
        ) : (
          <CodeStep email={email} honeypot={honeypot} onChangeEmail={() => setEmail(null)} />
        )}
      </div>
    </main>
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
        <h1 className="text-base font-semibold">Sign in</h1>
        <p className="text-sm text-muted-foreground">We will email you a six-digit code.</p>
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
      {/* Honeypot: invisible to people, filled by bots; the server rejects any value. */}
      <input
        type="text"
        tabIndex={-1}
        autoComplete="new-password"
        aria-hidden="true"
        className="absolute -left-[10000px] h-px w-px overflow-hidden opacity-0"
        {...form.register("website")}
      />
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
        {form.formState.isSubmitting ? <Loader2 className="animate-spin" /> : null}
        Send code
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
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { redirect: target } = Route.useSearch();
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
      queryClient.removeQueries({ queryKey: sessionQuery.queryKey });
      await navigate({ href: safeRedirect(target), replace: true });
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
      setNotice("A new code is on its way. Earlier codes no longer work.");
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
        <FieldLabel htmlFor="otp" className="sr-only">
          Six-digit code
        </FieldLabel>
        <InputOTP
          id="otp"
          maxLength={6}
          pattern={REGEXP_ONLY_DIGITS}
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          value={code}
          onChange={setCode}
          onComplete={(value: string) => void verify(value)}
          disabled={verifying}
          aria-invalid={error ? true : undefined}
          containerClassName="gap-2"
        >
          <InputOTPGroup>
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <InputOTPSlot
                key={index}
                index={index}
                aria-invalid={error ? true : undefined}
                className="size-11 text-lg"
              />
            ))}
          </InputOTPGroup>
        </InputOTP>
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
