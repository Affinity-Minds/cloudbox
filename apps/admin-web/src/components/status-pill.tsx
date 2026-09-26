import type * as React from "react";
import { cn } from "@/lib/utils";

export type Tone = "neutral" | "success" | "warning" | "danger" | "info";

const TONES: Record<Tone, string> = {
  neutral: "border-border bg-muted text-muted-foreground",
  success: "border-emerald-600/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  warning: "border-amber-600/20 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  danger: "border-red-600/20 bg-red-500/10 text-red-700 dark:text-red-400",
  info: "border-sky-600/20 bg-sky-500/10 text-sky-700 dark:text-sky-400",
};

/** Coloured status pill for tables: tone carries meaning, the label carries the value. */
export function StatusPill({
  tone = "neutral",
  className,
  ...props
}: React.ComponentProps<"span"> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-sm border px-1.5 font-mono text-[11px] leading-none whitespace-nowrap",
        TONES[tone],
        className,
      )}
      {...props}
    />
  );
}
