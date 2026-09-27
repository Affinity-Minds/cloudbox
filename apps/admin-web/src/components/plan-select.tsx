// Reusable plan combobox (Popover + Command, the shadcn way — no separate Select was installed
// for this). Lists ACTIVE plans, searchable by code or name; shows the current value even if that
// plan has since been retired, marked "retired" (agent-notes ux-patterns: never hide state).

import { useQuery } from "@tanstack/react-query";
import { ChevronsUpDown } from "lucide-react";
import { useState } from "react";
import { activePlansQuery } from "@/api/plans";
import { formatMoney, formatTermDays } from "@/components/plan-bits";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export function PlanSelect({
  id,
  value,
  onChange,
  disabled,
}: {
  id?: string;
  /** A plan code, or empty/undefined for "no plan chosen". */
  value: string | null | undefined;
  onChange: (code: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const query = useQuery(activePlansQuery);
  const plans = query.data ?? [];
  const selected = plans.find((plan) => plan.code === value);
  const isRetiredElsewhere = Boolean(value) && !selected && !query.isPending;

  const label = selected
    ? `${selected.name} · ${selected.code}`
    : isRetiredElsewhere
      ? `${value} (retired)`
      : query.isPending
        ? "Loading plans…"
        : "Select a plan";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between font-normal"
        >
          <span className="truncate">{label}</span>
          <ChevronsUpDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) min-w-56 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search plans by code or name…" />
          <CommandList>
            <CommandEmpty>No plan matches.</CommandEmpty>
            <CommandGroup>
              {isRetiredElsewhere && value ? (
                <CommandItem disabled value={`__current__ ${value}`} className="opacity-60">
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">
                      Current: <span className="font-mono">{value}</span> (retired)
                    </span>
                    <span className="text-xs text-muted-foreground">
                      No longer offered; kept for this record.
                    </span>
                  </span>
                </CommandItem>
              ) : null}
              {plans.map((plan) => (
                <CommandItem
                  key={plan.code}
                  value={`${plan.code} ${plan.name}`}
                  data-checked={plan.code === value}
                  onSelect={() => {
                    onChange(plan.code);
                    setOpen(false);
                  }}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">
                      {plan.name}{" "}
                      <span className="font-mono text-xs text-muted-foreground">{plan.code}</span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {plan.maxDevices} device{plan.maxDevices === 1 ? "" : "s"} ·{" "}
                      {plan.maxManagedUsers} users · {formatMoney(plan.priceAmount, plan.currency)}{" "}
                      / {formatTermDays(plan.termDays)}
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
