// Owner: WT-1. Small form pieces shared by the staff and customer sign-in pages.
import type * as React from "react";

export function Honeypot(props: React.InputHTMLAttributes<HTMLInputElement>) {
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

export function ErrorLine({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  );
}
