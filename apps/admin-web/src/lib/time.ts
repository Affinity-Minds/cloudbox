import { format, formatDistanceToNowStrict } from "date-fns";

/** Accepts ISO-8601 and the Phase 0 SQLite form (`2026-09-26 18:25:28`, UTC). */
export function parseTimestamp(value: string): Date {
  const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  return new Date(iso);
}

export function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  const date = parseTimestamp(value);
  return Number.isNaN(date.getTime()) ? value : format(date, "yyyy-MM-dd HH:mm:ss");
}

/** "3 minutes ago" for the past, "in 24 hours" for the future (e.g. an enrollment token's
 * expiry) — `addSuffix` picks the direction; every prior caller only ever passed a past
 * timestamp, so this is unchanged for them. */
export function formatAgo(value: string | null | undefined): string {
  if (!value) return "never";
  const date = parseTimestamp(value);
  return Number.isNaN(date.getTime())
    ? value
    : formatDistanceToNowStrict(date, { addSuffix: true });
}

export function shortSha(value: string | undefined): string {
  if (!value) return "unknown";
  return /^[0-9a-f]{12,}$/i.test(value) ? value.slice(0, 7) : value;
}
