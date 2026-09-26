// Timezone combobox: every `Intl.supportedValuesOf('timeZone')` zone (fallback list otherwise),
// grouped by region, searchable by substring or common abbreviation (lib/timezones.ts), each
// showing its current UTC offset. Keyboard navigable via cmdk (Command already gives this).
import { ChevronsUpDown } from "lucide-react";
import { useMemo, useState } from "react";
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
import { listTimezones, regionOf, timezoneMatches, utcOffsetLabel } from "@/lib/timezones";

export function TimezoneSelect({
  id,
  value,
  onChange,
  disabled,
}: {
  id?: string;
  value: string;
  onChange: (zone: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const now = useMemo(() => new Date(), []);

  const grouped = useMemo(() => {
    const matches = listTimezones().filter((zone) => timezoneMatches(zone, search));
    const byRegion = new Map<string, string[]>();
    for (const zone of matches) {
      const region = regionOf(zone);
      const list = byRegion.get(region) ?? [];
      list.push(zone);
      byRegion.set(region, list);
    }
    return [...byRegion.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [search]);

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
          <span className="truncate">
            {value || "Select a timezone"}
            {value ? (
              <span className="ml-1.5 font-mono text-xs text-muted-foreground">
                {utcOffsetLabel(value, now)}
              </span>
            ) : null}
          </span>
          <ChevronsUpDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) min-w-64 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search zones (kolkata, asia/, ist…)"
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>No zone matches.</CommandEmpty>
            {grouped.map(([region, zones]) => (
              <CommandGroup key={region} heading={region}>
                {zones.map((zone) => (
                  <CommandItem
                    key={zone}
                    value={zone}
                    data-checked={zone === value}
                    onSelect={() => {
                      onChange(zone);
                      setOpen(false);
                      setSearch("");
                    }}
                  >
                    <span className="truncate">{zone.slice(region.length + 1) || zone}</span>
                    <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
                      {utcOffsetLabel(zone, now)}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
