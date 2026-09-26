import type { Db } from "./db/client";
import { auditLog } from "./db/schema";
import { nowIso } from "./ids";

export type AuditActorType = "user" | "device" | "system" | "bootstrap-admin";

export type AuditInput = {
  /** e.g. `TENANT_CREATED`, `foundation.release.changed`. */
  eventType: string;
  entityType: string;
  entityId: string;
  actor: { type: AuditActorType; id: string; tenantId?: string | null };
  before: unknown;
  after: unknown;
  /** Defaults to the last `.`/`_` segment of `eventType`, lower-cased. */
  action?: string;
  correlationId?: string | null;
  /** Where the change came from: `api`, `agent`, `migration`, `deploy`, … */
  source?: string | null;
  /** Supply when the caller must return the audit id. */
  id?: string;
};

const toJson = (value: unknown) =>
  value === undefined || value === null ? null : JSON.stringify(value);

/**
 * Appends one audit row. Returns the Drizzle insert, which is thenable: `await audit(db, …)` runs it
 * alone, and `db.batch([change, audit(db, …)])` commits it atomically with the state change.
 */
export function audit(db: Db, input: AuditInput) {
  const action =
    input.action ?? input.eventType.split(/[._]/).at(-1)?.toLowerCase() ?? input.eventType;
  return db.insert(auditLog).values({
    id: input.id ?? crypto.randomUUID(),
    eventType: input.eventType,
    entityType: input.entityType,
    entityId: input.entityId,
    actorType: input.actor.type,
    actorId: input.actor.id,
    actorTenantId: input.actor.tenantId ?? null,
    action,
    beforeJson: toJson(input.before),
    afterJson: toJson(input.after),
    correlationId: input.correlationId ?? null,
    source: input.source ?? null,
    createdAt: nowIso(),
  });
}
