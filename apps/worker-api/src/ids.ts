import { ID_PREFIX, type IdKind } from "@cloudbox/contracts";

/** `ten_…`, `dev_…`, etc. Every server-generated id goes through here. */
export function newId(kind: IdKind): string {
  return `${ID_PREFIX[kind]}${crypto.randomUUID()}`;
}

/** ISO-8601 UTC. The single source of "now" for stored timestamps. */
export function nowIso(): string {
  return new Date().toISOString();
}
