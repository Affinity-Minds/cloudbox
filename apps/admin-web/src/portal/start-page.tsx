// Owner: WT-14. /start on the customer surface (ADR 0011): self-service onboarding.
// email → six-digit code (both behind a Turnstile widget that is always shown) → organisation:
// create one, or redeem a server licence key from a reseller. Then /portal. The only customer
// flow that creates an identity; /login stays closed.
import { Email } from "@cloudbox/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Building2, KeyRound, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { customerSessionQuery, describeAuthError } from "@/api/auth";
import { describeError } from "@/api/client";
import {
  createOwnTenant,
  onboardingConfigQuery,
  onboardingOverviewQuery,
  redeemLicenseKey,
  startSendCode,
  startVerify,
} from "@/api/onboarding";
import { AuthFrame, CodeBoxes } from "@/auth/auth-ui";
import { ErrorLine, Honeypot } from "@/auth/form-bits";
import { TurnstileChallenge } from "@/auth/turnstile";
import { NativeSelect } from "@/components/subscription-bits";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** One Turnstile token per request; the widget re-issues after each use. */
function useTurnstile() {
  const config = useQuery(onboardingConfigQuery);
  const [token, setToken] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  const siteKey = config.data?.turnstileSiteKey ?? null;
  return {
    ready: Boolean(token),
    unavailable: config.isSuccess && !siteKey,
    widget: siteKey ? (
      <TurnstileChallenge siteKey={siteKey} resetSignal={resetSignal} onToken={setToken} />
    ) : config.isPending ? (
      <div className="min-h-[65px]" />
    ) : null,
    take(): string | null {
      const value = token;
      setToken(null);
      setResetSignal((n) => n + 1);
      return value;
    },
  };
}

export function StartPage() {
  const session = useQuery({ ...customerSessionQuery, retry: false });
  const [email, setEmail] = useState<string | null>(null);
  const [hp, setHp] = useState("");
  const signedIn = session.isSuccess;
  return (
    <AuthFrame wide>
      {session.isPending ? null : signedIn ? (
        <OrganisationStep email={session.data.user.email} />
      ) : email === null ? (
        <EmailStep
          onSent={(address, honeypot) => {
            setHp(honeypot);
            setEmail(address);
          }}
        />
      ) : (
        <CodeStep email={email} honeypot={hp} onBack={() => setEmail(null)} />
      )}
    </AuthFrame>
  );
}

function EmailStep({ onSent }: { onSent: (email: string, honeypot: string) => void }) {
  const turnstile = useTurnstile();
  const [value, setValue] = useState("");
  const [website, setWebsite] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = Email.safeParse(value);
    if (!parsed.success) return setError("Enter a valid email address.");
    setBusy(true);
    setError(null);
    try {
      await startSendCode(parsed.data, turnstile.take(), website);
      onSent(parsed.data, website);
    } catch (cause) {
      setError(describeAuthError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <div>
        <h1 className="text-base font-semibold">Get started with CloudBox</h1>
        <p className="text-sm text-muted-foreground">
          Enter your work email. We send it a six-digit code; then you set up your organisation.
        </p>
      </div>
      <Field>
        <FieldLabel htmlFor="start-email">Email</FieldLabel>
        <Input
          id="start-email"
          type="email"
          autoComplete="email"
          inputMode="email"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </Field>
      <Honeypot value={website} onChange={(e) => setWebsite(e.target.value)} name="website" />
      {turnstile.widget}
      {turnstile.unavailable ? (
        <ErrorLine>Sign-up is not available right now. Contact CloudBox support.</ErrorLine>
      ) : null}
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <Button type="submit" className="w-full" disabled={busy || !turnstile.ready}>
        {busy ? <Loader2 className="animate-spin" /> : null}
        Send code
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        Already set up?{" "}
        <a href="/login" className="underline underline-offset-4">
          Sign in
        </a>
      </p>
    </form>
  );
}

function CodeStep({
  email,
  honeypot,
  onBack,
}: {
  email: string;
  honeypot: string;
  onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const turnstile = useTurnstile();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const inFlight = useRef(false);

  async function verify(value: string) {
    if (inFlight.current || !turnstile.ready) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await startVerify(email, value, turnstile.take(), honeypot);
      inFlight.current = true; // signed in: never send this code again while the page moves on
      // Refetch the (401) session the page is watching: it now answers, and the page moves on.
      await queryClient.resetQueries({ queryKey: customerSessionQuery.queryKey });
    } catch (cause) {
      setError(describeAuthError(cause));
      setCode("");
      inFlight.current = false;
    } finally {
      setBusy(false);
    }
  }

  // A code typed before the challenge finished is sent as soon as the widget yields a token.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the token's arrival triggers this.
  useEffect(() => {
    if (turnstile.ready && code.length === 6 && !error) void verify(code);
  }, [turnstile.ready]);

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
          We sent a six-digit code to <span className="font-medium text-foreground">{email}</span>.
          It expires in 5 minutes.
        </p>
      </div>
      <Field data-invalid={error ? true : undefined}>
        <CodeBoxes
          id="start-otp"
          label="Six-digit code"
          value={code}
          onChange={setCode}
          onComplete={(value) => void verify(value)}
          disabled={busy}
          invalid={Boolean(error)}
        />
        {error ? <ErrorLine>{error}</ErrorLine> : null}
      </Field>
      {turnstile.widget}
      <Button
        type="submit"
        className="w-full"
        disabled={busy || code.length !== 6 || !turnstile.ready}
      >
        {busy ? <Loader2 className="animate-spin" /> : null}
        Continue
      </Button>
      <button
        type="button"
        className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        onClick={onBack}
      >
        Use a different email
      </button>
    </form>
  );
}

function timeZones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["UTC"];
  }
}

function OrganisationStep({ email }: { email: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const zones = useMemo(timeZones, []);
  const [mode, setMode] = useState<"create" | "key">("create");
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [timezone, setTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return setError("Enter your organisation's name.");
    if (mode === "key" && !key.trim()) return setError("Enter the licence key from your card.");
    setBusy(true);
    setError(null);
    try {
      if (mode === "key") {
        await redeemLicenseKey({ code: key, displayName: name, timezone });
      } else {
        await createOwnTenant({ displayName: name, timezone });
      }
      await queryClient.invalidateQueries({ queryKey: onboardingOverviewQuery.queryKey });
      await queryClient.invalidateQueries({ queryKey: customerSessionQuery.queryKey });
      router.history.replace("/portal");
    } catch (cause) {
      const message = describeError(cause);
      setError(
        message.includes("invalid_license_key")
          ? "That licence key is not valid. Check it against your card, or contact the store."
          : message.includes("429")
            ? "Too many attempts. Wait a while and try again."
            : `Could not set up the organisation (${message}).`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <h1 className="text-base font-semibold">Set up your organisation</h1>
        <p className="text-sm text-muted-foreground">
          Signed in as <span className="font-medium text-foreground">{email}</span>. You become its
          Owner.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {(
          [
            ["create", Building2, "Create an organisation", "A plan is attached by CloudBox."],
            ["key", KeyRound, "Have a licence key?", "From the store where you bought it."],
          ] as const
        ).map(([value, Icon, title, hint]) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            onClick={() => setMode(value)}
            className={cn(
              "rounded-md border p-3 text-left text-sm",
              mode === value ? "border-primary bg-primary/5" : "hover:bg-muted",
            )}
          >
            <Icon className="mb-1 size-4" />
            <div className="font-medium">{title}</div>
            <div className="text-xs text-muted-foreground">{hint}</div>
          </button>
        ))}
      </div>
      {mode === "key" ? (
        <Field>
          <FieldLabel htmlFor="lic-key">Licence key</FieldLabel>
          <Input
            id="lic-key"
            className="font-mono uppercase"
            placeholder="CBX-LIC-XXXXX-XXXXX-XXXXX-XXXXX"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </Field>
      ) : null}
      <Field>
        <FieldLabel htmlFor="org-name">Organisation name</FieldLabel>
        <Input id="org-name" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field>
        <FieldLabel htmlFor="org-tz">Time zone</FieldLabel>
        <NativeSelect id="org-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </NativeSelect>
        <FieldDescription>Used for maintenance windows and reports.</FieldDescription>
      </Field>
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? <Loader2 className="animate-spin" /> : null}
        {mode === "key" ? "Redeem and create organisation" : "Create organisation"}
      </Button>
    </form>
  );
}
