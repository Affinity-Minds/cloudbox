// A plain <select>, styled to match Input, for the handful of pickers that don't need Radix's
// combobox behaviour (status/plan filters, standing). Not a shadcn primitive.
import { ChevronDown } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/utils";

export function SelectNative({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <div className="relative">
      <select
        data-slot="select-native"
        className={cn(
          "h-8 w-full min-w-0 appearance-none rounded-lg border border-input bg-transparent px-2.5 py-1 pr-7 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}
