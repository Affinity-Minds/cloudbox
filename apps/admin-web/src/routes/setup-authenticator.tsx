// Owner: WT-1. First staff sign-in, step 2 of 2 (ADR 0009): enrol an authenticator app. Confirm
// the password, scan the QR (rendered in the browser from the otpauth URI), verify one code, then
// see the backup codes once.
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { Check, Copy, Loader2 } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import { describeAuthError, enableAuthenticator, sessionQuery, verifyTotp } from "@/api/auth";
import { AuthFrame, CodeBoxes } from "@/auth/auth-ui";
import { pendingSetupPath, requireSession } from "@/auth/session";
import { SetupSteps, SignOutLink } from "@/auth/setup-ui";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/setup-authenticator")({
  beforeLoad: async ({ context, location }) => {
    const session = await requireSession(context.queryClient, location.href);
    const pending = pendingSetupPath(session);
    if (pending !== "/setup-authenticator") throw redirect({ to: pending ?? "/" });
  },
  component: SetupAuthenticatorPage,
});

type Enrolment = { totpURI: string; backupCodes: string[] };

function SetupAuthenticatorPage() {
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  return (
    <AuthFrame wide>
      <SetupSteps current={2} />
      {!enrolment ? (
        <PasswordStep onEnrolment={setEnrolment} />
      ) : !confirmed ? (
        <ScanStep enrolment={enrolment} onConfirmed={() => setConfirmed(true)} />
      ) : (
        <BackupCodesStep codes={enrolment.backupCodes} />
      )}
    </AuthFrame>
  );
}

function PasswordStep({ onEnrolment }: { onEnrolment: (e: Enrolment) => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!password) return;
        setBusy(true);
        setError(null);
        try {
          onEnrolment(await enableAuthenticator(password));
        } catch (cause) {
          setError(describeAuthError(cause));
          setPassword("");
        } finally {
          setBusy(false);
        }
      }}
    >
      <div>
        <h1 className="text-base font-semibold">Set up your authenticator</h1>
        <p className="text-sm text-muted-foreground">
          Staff sign in with a password and a code from an authenticator app (Google Authenticator,
          Microsoft Authenticator, 1Password, Authy…). Confirm your password to start.
        </p>
      </div>
      <Field data-invalid={error ? true : undefined}>
        <FieldLabel htmlFor="password">Your password</FieldLabel>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {error ? <FieldError>{error}</FieldError> : null}
      </Field>
      <Button type="submit" className="w-full" disabled={busy || !password}>
        {busy ? <Loader2 className="animate-spin" /> : null}
        Continue
      </Button>
      <SignOutLink />
    </form>
  );
}

function ScanStep({ enrolment, onConfirmed }: { enrolment: Enrolment; onConfirmed: () => void }) {
  const queryClient = useQueryClient();
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const secret = new URL(enrolment.totpURI).searchParams.get("secret") ?? "";

  useEffect(() => {
    // Rendered locally: the secret never leaves the browser for a QR service.
    void QRCode.toDataURL(enrolment.totpURI, { margin: 1, width: 208 }).then(setQr);
  }, [enrolment.totpURI]);

  async function confirm(value: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await verifyTotp(value);
      queryClient.removeQueries({ queryKey: sessionQuery.queryKey });
      onConfirmed();
    } catch (cause) {
      setCode("");
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
        if (code.length === 6) void confirm(code);
      }}
    >
      <div>
        <h1 className="text-base font-semibold">Scan this code</h1>
        <p className="text-sm text-muted-foreground">
          Open your authenticator app, add an account, and scan the QR code. Then enter the
          six-digit code it shows.
        </p>
      </div>
      <div className="flex items-start gap-4">
        <div className="flex size-[208px] shrink-0 items-center justify-center rounded-md border bg-white">
          {qr ? (
            <img src={qr} alt="QR code for your authenticator app" width={208} height={208} />
          ) : (
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0 space-y-1 text-xs text-muted-foreground">
          <p>Can't scan? Enter this key in the app instead:</p>
          <p className="break-all font-mono text-sm text-foreground">
            {secret.match(/.{1,4}/g)?.join(" ")}
          </p>
          <p>Type: time-based, 6 digits, 30 seconds.</p>
        </div>
      </div>
      <Field data-invalid={error ? true : undefined}>
        <CodeBoxes
          id="setup-totp"
          label="Six-digit code from the app"
          value={code}
          onChange={setCode}
          onComplete={(value) => void confirm(value)}
          disabled={busy}
          invalid={Boolean(error)}
        />
        {error ? (
          <FieldError>{error}</FieldError>
        ) : (
          <FieldDescription>It submits by itself on the sixth digit.</FieldDescription>
        )}
      </Field>
      <Button type="submit" className="w-full" disabled={busy || code.length !== 6}>
        {busy ? <Loader2 className="animate-spin" /> : null}
        Verify
      </Button>
    </form>
  );
}

function BackupCodesStep({ codes }: { codes: string[] }) {
  const navigate = useNavigate();
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-base font-semibold">Save your backup codes</h1>
        <p className="text-sm text-muted-foreground">
          If you lose your phone, each of these codes signs you in once instead of the app. They are
          shown only now. Keep them in your password manager.
        </p>
      </div>
      <ol className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-md border bg-muted/40 px-4 py-3 font-mono text-sm">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ol>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={async () => {
          await navigator.clipboard.writeText(codes.join("\n"));
          setCopied(true);
        }}
      >
        {copied ? <Check /> : <Copy />}
        {copied ? "Copied" : "Copy codes"}
      </Button>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={saved}
          onChange={(event) => setSaved(event.target.checked)}
        />
        I have saved these codes somewhere safe.
      </label>
      <Button
        type="button"
        className="w-full"
        disabled={!saved}
        onClick={() => void navigate({ to: "/", replace: true })}
      >
        Go to the console
      </Button>
    </div>
  );
}
