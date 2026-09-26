// Owner: WT-1. Pieces shared by the sign-in and first-sign-in setup pages: the plain page frame and
// the six-box code input (agent-notes ux-patterns "One-time codes": six boxes, submit on the sixth
// digit, paste fills all, autocomplete="one-time-code").
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { Box } from "lucide-react";
import type * as React from "react";
import { FieldLabel } from "@/components/ui/field";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";

export function AuthFrame({
  children,
  wide = false,
}: {
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <main className="flex min-h-svh items-start justify-center bg-background px-4 pt-[14vh]">
      <div className={wide ? "w-full max-w-md" : "w-full max-w-sm"}>
        <div className="mb-6 flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Box className="size-4" />
          </div>
          <span className="text-sm font-semibold">CloudBox</span>
        </div>
        {children}
      </div>
    </main>
  );
}

export function CodeBoxes({
  id,
  label,
  value,
  onChange,
  onComplete,
  disabled,
  invalid,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onComplete: (value: string) => void;
  disabled?: boolean;
  invalid?: boolean;
}) {
  return (
    <>
      <FieldLabel htmlFor={id} className="sr-only">
        {label}
      </FieldLabel>
      <InputOTP
        id={id}
        maxLength={6}
        pattern={REGEXP_ONLY_DIGITS}
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus
        value={value}
        onChange={onChange}
        onComplete={onComplete}
        disabled={disabled}
        aria-invalid={invalid ? true : undefined}
        containerClassName="gap-2"
      >
        <InputOTPGroup>
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <InputOTPSlot
              key={index}
              index={index}
              aria-invalid={invalid ? true : undefined}
              className="size-11 text-lg"
            />
          ))}
        </InputOTPGroup>
      </InputOTP>
    </>
  );
}
