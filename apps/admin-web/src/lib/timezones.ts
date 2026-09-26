// Timezone list, grouping and search matching for components/timezone-select.tsx. Split out of
// the component so the matching function can be unit-tested without mounting React (see
// timezones.test.ts).

/**
 * Common abbreviations/aliases for the ~40 most-selected zones, so "ist" finds Asia/Kolkata and
 * "est" finds America/New_York without the person typing the IANA name. Deliberately small and
 * hand-picked — this is a search aid, not a canonical abbreviation registry (some, like "IST" or
 * "CST", are genuinely ambiguous across zones; that a query matches more than one zone is
 * expected, not a bug).
 */
export const TIMEZONE_ABBREVIATIONS: Record<string, string[]> = {
  "Asia/Kolkata": ["ist", "india"],
  "Asia/Jerusalem": ["israel"],
  "America/New_York": ["est", "edt", "eastern", "new york", "nyc"],
  "America/Chicago": ["cst", "cdt", "central"],
  "America/Denver": ["mst", "mdt", "mountain"],
  "America/Los_Angeles": ["pst", "pdt", "pacific", "la"],
  "America/Anchorage": ["akst", "akdt", "alaska"],
  "Pacific/Honolulu": ["hst", "hawaii"],
  "Europe/London": ["gmt", "bst", "uk", "britain"],
  "Europe/Dublin": ["ireland"],
  "Europe/Paris": ["cet", "cest", "france"],
  "Europe/Berlin": ["cet", "cest", "germany"],
  "Europe/Madrid": ["cet", "cest", "spain"],
  "Europe/Rome": ["cet", "cest", "italy"],
  "Europe/Amsterdam": ["cet", "cest", "netherlands"],
  "Europe/Moscow": ["msk", "russia"],
  "Europe/Istanbul": ["trt", "turkey"],
  "Europe/Athens": ["eet", "greece"],
  "Asia/Dubai": ["gst", "uae"],
  "Asia/Karachi": ["pkt", "pakistan"],
  "Asia/Dhaka": ["bdt", "bangladesh"],
  "Asia/Bangkok": ["ict", "thailand"],
  "Asia/Jakarta": ["wib", "indonesia"],
  "Asia/Singapore": ["sgt", "singapore"],
  "Asia/Hong_Kong": ["hkt", "hong kong"],
  "Asia/Shanghai": ["china"],
  "Asia/Tokyo": ["jst", "japan"],
  "Asia/Seoul": ["kst", "korea"],
  "Asia/Manila": ["pht", "philippines"],
  "Asia/Kuala_Lumpur": ["myt", "malaysia"],
  "Asia/Ho_Chi_Minh": ["vietnam"],
  "Australia/Sydney": ["aest", "aedt", "sydney"],
  "Australia/Perth": ["awst", "perth"],
  "Australia/Melbourne": ["melbourne"],
  "Pacific/Auckland": ["nzst", "nzdt", "new zealand"],
  "Africa/Cairo": ["eet", "egypt"],
  "Africa/Johannesburg": ["sast", "south africa"],
  "Africa/Lagos": ["wat", "nigeria"],
  "America/Sao_Paulo": ["brt", "brazil"],
  "America/Mexico_City": ["mexico"],
  "America/Toronto": ["toronto", "canada"],
  "America/Bogota": ["cot", "colombia"],
  "America/Argentina/Buenos_Aires": ["art", "argentina"],
};

/** A small bundled fallback for a runtime without `Intl.supportedValuesOf` (rare; Workers has it). */
const FALLBACK_ZONES = [
  "UTC",
  ...Object.keys(TIMEZONE_ABBREVIATIONS),
  "America/Vancouver",
  "America/Phoenix",
  "America/Halifax",
  "Europe/Lisbon",
  "Europe/Warsaw",
  "Europe/Zurich",
  "Europe/Stockholm",
  "Asia/Kathmandu",
  "Asia/Taipei",
  "Asia/Colombo",
  "Pacific/Fiji",
  "Indian/Maldives",
  "Atlantic/Reykjavik",
].filter((zone, index, all) => all.indexOf(zone) === index);

export function listTimezones(): string[] {
  try {
    if (typeof Intl.supportedValuesOf === "function") {
      const zones = Intl.supportedValuesOf("timeZone");
      if (zones.length > 0) return zones;
    }
  } catch {
    // fall through to the bundled list
  }
  return FALLBACK_ZONES;
}

/** The part before the first `/`, or "Other" for a bare zone like `UTC`. */
export function regionOf(zone: string): string {
  const slash = zone.indexOf("/");
  return slash === -1 ? "Other" : zone.slice(0, slash);
}

/**
 * Legacy IANA links whose canonical name a runtime's own `Intl.supportedValuesOf('timeZone')`
 * may or may not have caught up to — some ICU builds still list `Asia/Calcutta` instead of
 * `Asia/Kolkata` for the same zone. Matching goes through the canonical name on both sides so a
 * search finds the zone under either spelling, whichever one the runtime actually returned.
 */
const LEGACY_ALIAS_PAIRS: [string, string][] = [
  ["Asia/Calcutta", "Asia/Kolkata"],
  ["Asia/Katmandu", "Asia/Kathmandu"],
  ["Asia/Rangoon", "Asia/Yangon"],
  ["Asia/Saigon", "Asia/Ho_Chi_Minh"],
  ["Asia/Dacca", "Asia/Dhaka"],
  ["Europe/Kiev", "Europe/Kyiv"],
  ["America/Buenos_Aires", "America/Argentina/Buenos_Aires"],
];

/** Every other name this zone is also known by (either direction of the pairs above). */
const ZONE_SYNONYMS: Record<string, string[]> = {};
for (const [a, b] of LEGACY_ALIAS_PAIRS) {
  (ZONE_SYNONYMS[a] ??= []).push(b);
  (ZONE_SYNONYMS[b] ??= []).push(a);
}

/**
 * True when `query` matches `zone` by substring (case-insensitive, anywhere in the IANA name —
 * "asia/" matches every Asia zone, "kolkata" matches Asia/Kolkata even when the runtime lists it
 * as `Asia/Calcutta`, and vice versa) or by a known abbreviation.
 */
export function timezoneMatches(zone: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  if (zone.toLowerCase().includes(q)) return true;
  if (ZONE_SYNONYMS[zone]?.some((synonym) => synonym.toLowerCase().includes(q))) return true;
  const aliasKeys = [zone, ...(ZONE_SYNONYMS[zone] ?? [])];
  return aliasKeys.some((key) =>
    TIMEZONE_ABBREVIATIONS[key]?.some((alias) => alias.includes(q)),
  );
}

/** e.g. "GMT+5:30", from the runtime's own IANA database — never hand-maintained. */
export function utcOffsetLabel(zone: string, at: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "shortOffset",
    }).formatToParts(at);
    return parts.find((part) => part.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}
