// Owner: WT-1. Customer sign-in (/login on the customer surface): email, then a six-digit code
// sent by email; Turnstile step-up only when the API asks (review T-1). Customers are their own
// identity system (/api/auth, ADR 0002). Nothing here links to the staff console.
import { Email } from "@cloudbox/contracts";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import {
  challengeSiteKey,
  customerSessionQuery,
  describeAuthError,
  sendOtp,
  verifyOtp,
} from "@/api/auth";
import { ApiError } from "@/api/client";
import { AuthFrame, CodeBoxes } from "@/auth/auth-ui";
import { ErrorLine, Honeypot } from "@/auth/form-bits";
import { TurnstileChallenge } from "@/auth/turnstile";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const RESEND_SECONDS = 30;

/** After sign-in: drop the cached 401 and open the portal. */
function useFinish() {
  const queryClient = useQueryClient();
  const router = useRouter();
  return async () => {
    queryClient.removeQueries({ queryKey: customerSessionQuery.queryKey });
    router.history.replace("/portal");
  };
}

export function CustomerLoginPage() {
  return (
    <AuthFrame>
      <CustomerSignIn />
    </AuthFrame>
  );
}

const EmailForm = z.object({ email: Email, website: z.string() });
type EmailForm = z.input<typeof EmailForm>;

/**
 * Turnstile step-up for customer codes (review T-1): invisible until the API answers
 * `challenge_required` for an address over its failure budget. Then the widget appears, and once it
 * yields a token the interrupted action runs again with it. Tokens are single use.
 */
function useStepUp() {
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  const token = useRef<string | null>(null);
  const retry = useRef<(() => void) | null>(null);
  const sentToken = useRef(false);
  return {
    widget: siteKey ? (
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">
          Unusual activity for this address. Confirm you are a person to continue.
        </p>
        <TurnstileChallenge
          siteKey={siteKey}
          resetSignal={resetSignal}
          onToken={(value) => {
            token.current = value;
            const again = retry.current;
            retry.current = null;
            if (value && again) again();
          }}
        />
      </div>
    ) : null,
    /** The token for the next request (then spent), or null. */
    take(): string | null {
      const value = token.current;
      sentToken.current = Boolean(value);
      if (value) {
        token.current = null;
        setResetSignal((n) => n + 1);
      }
      return value;
    },
    /**
     * "armed" (and `again` runs once the widget yields a token) when `cause` asks for the
     * challenge; "rejected" when the request already carried a token (no automatic loop); else null.
     */
    challenged(cause: unknown, again: () => void): "armed" | "rejected" | null {
      const key = challengeSiteKey(cause);
      if (!key) return null;
      setSiteKey(key);
      if (sentToken.current) return "rejected";
      retry.current = again;
      return "armed";
    },
  };
}
type StepUp = ReturnType<typeof useStepUp>;

function CustomerSignIn() {
  const [email, setEmail] = useState<string | null>(null);
  const [honeypot, setHoneypot] = useState("");
  const stepUp = useStepUp();
  return email === null ? (
    <EmailStep
      stepUp={stepUp}
      onSent={(sentTo, hp) => {
        setHoneypot(hp);
        setEmail(sentTo);
      }}
    />
  ) : (
    <CodeStep
      email={email}
      honeypot={honeypot}
      stepUp={stepUp}
      onChangeEmail={() => setEmail(null)}
    />
  );
}

function EmailStep({
  onSent,
  stepUp,
}: {
  onSent: (email: string, honeypot: string) => void;
  stepUp: StepUp;
}) {
  const [error, setError] = useState<string | null>(null);
  const form = useForm<EmailForm, unknown, z.output<typeof EmailForm>>({
    resolver: zodResolver(EmailForm),
    defaultValues: { email: "", website: "" },
  });

  const submit = form.handleSubmit(async ({ email, website }) => {
    setError(null);
    try {
      await sendOtp(email, website, stepUp.take());
      onSent(email, website);
    } catch (cause) {
      setError(
        stepUp.challenged(cause, () => void submit()) === "armed" ? null : describeAuthError(cause),
      );
    }
  });

  const emailError = form.formState.errors.email;
  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <div>
        <h1 className="text-base font-semibold">Sign in</h1>
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
      {stepUp.widget}
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
  stepUp,
  onChangeEmail,
}: {
  email: string;
  honeypot: string;
  stepUp: StepUp;
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
      await verifyOtp(email, value, honeypot, stepUp.take());
      await finish();
    } catch (cause) {
      if (stepUp.challenged(cause, () => void verify(value)) === "armed") {
        setError(null);
        return;
      }
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
      await sendOtp(email, honeypot, stepUp.take());
      setCode("");
      // Nothing here may reveal whether the address exists (closed sign-in, ADR 0009).
      setNotice("If this address can sign in, the code is on its way again.");
      countdown.restart();
    } catch (cause) {
      if (stepUp.challenged(cause, () => void resend()) !== "armed") {
        setError(describeAuthError(cause));
      }
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
      {stepUp.widget}
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
