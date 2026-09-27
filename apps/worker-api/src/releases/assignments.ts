// Owner: WT-18. Release assignment CRUD (device / tenant / fleet_percent scopes), gated
// `update.deploy` at the route layer. A draft release can only be assigned to a device (the spec's
// "Internal lab" stage); tenant and fleet_percent assignments require at least a pilot release.
import type { AssignmentScope, ReleaseAssignment } from "@cloudbox/contracts";
import { and, desc, eq } from "drizzle-orm";
import { audit } from "../audit";
import type { Db } from "../db/client";
import { devices, releaseAssignments, releases, tenants } from "../db/schema";
import { newId, nowIso } from "../ids";

export class AssignmentRefusal extends Error {
  override readonly name = "AssignmentRefusal";
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    readonly detail?: string,
  ) {
    super(detail ?? code);
  }
}

export type Actor = { id: string; correlationId?: string | null };

export async function listAssignments(db: Db, releaseId: string): Promise<ReleaseAssignment[]> {
  const rows = await db
    .select({
      assignment: releaseAssignments,
      deviceName: devices.name,
      tenantName: tenants.displayName,
    })
    .from(releaseAssignments)
    .leftJoin(devices, eq(devices.id, releaseAssignments.deviceId))
    .leftJoin(tenants, eq(tenants.id, releaseAssignments.tenantId))
    .where(eq(releaseAssignments.releaseId, releaseId))
    .orderBy(desc(releaseAssignments.createdAt));

  return rows.map((row) => ({
    id: row.assignment.id,
    releaseId: row.assignment.releaseId,
    scope: row.assignment.scope,
    deviceId: row.assignment.deviceId,
    deviceName: row.deviceName ?? null,
    tenantId: row.assignment.tenantId,
    tenantName: row.tenantName ?? null,
    percent: row.assignment.percent,
    createdBy: row.assignment.createdBy,
    createdAt: row.assignment.createdAt,
  }));
}

export async function createAssignment(
  db: Db,
  input: {
    releaseId: string;
    scope: AssignmentScope;
    deviceId?: string;
    tenantId?: string;
    percent?: number;
    actor: Actor;
  },
): Promise<ReleaseAssignment> {
  const [release] = await db
    .select({ id: releases.id, status: releases.status })
    .from(releases)
    .where(eq(releases.id, input.releaseId));
  if (!release) throw new AssignmentRefusal(404, "not_found", "release");
  if (release.status === "withdrawn") throw new AssignmentRefusal(409, "release_withdrawn");

  let deviceId: string | null = null;
  let tenantId: string | null = null;
  let percent: number | null = null;

  if (input.scope === "device") {
    if (!input.deviceId)
      throw new AssignmentRefusal(400, "invalid_request", "deviceId is required");
    const [device] = await db
      .select({ id: devices.id })
      .from(devices)
      .where(eq(devices.id, input.deviceId));
    if (!device) throw new AssignmentRefusal(404, "not_found", "device");
    deviceId = input.deviceId;
  } else if (input.scope === "tenant") {
    if (release.status === "draft") {
      throw new AssignmentRefusal(
        409,
        "release_not_released",
        "draft releases can only be assigned to a device",
      );
    }
    if (!input.tenantId)
      throw new AssignmentRefusal(400, "invalid_request", "tenantId is required");
    const [tenant] = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, input.tenantId));
    if (!tenant) throw new AssignmentRefusal(404, "not_found", "tenant");
    tenantId = input.tenantId;
  } else {
    if (release.status === "draft") {
      throw new AssignmentRefusal(
        409,
        "release_not_released",
        "draft releases can only be assigned to a device",
      );
    }
    if (!input.percent || input.percent < 1 || input.percent > 100) {
      throw new AssignmentRefusal(400, "invalid_request", "percent must be between 1 and 100");
    }
    percent = input.percent;
  }

  const id = newId("releaseAssignment");
  const createdAt = nowIso();
  const row = {
    id,
    releaseId: input.releaseId,
    scope: input.scope,
    deviceId,
    tenantId,
    percent,
    createdBy: input.actor.id,
    createdAt,
  };

  await db.batch([
    db.insert(releaseAssignments).values(row),
    audit(db, {
      eventType: "UPDATE_DEPLOYED",
      entityType: "release_assignment",
      entityId: id,
      actor: { type: "user", id: input.actor.id },
      before: null,
      after: row,
      correlationId: input.actor.correlationId,
      source: "api",
    }),
  ]);

  return { ...row, deviceName: null, tenantName: null };
}

export async function deleteAssignment(
  db: Db,
  input: { releaseId: string; assignmentId: string; actor: Actor },
): Promise<void> {
  const [row] = await db
    .select()
    .from(releaseAssignments)
    .where(
      and(
        eq(releaseAssignments.id, input.assignmentId),
        eq(releaseAssignments.releaseId, input.releaseId),
      ),
    );
  if (!row) throw new AssignmentRefusal(404, "not_found");

  await db.batch([
    db.delete(releaseAssignments).where(eq(releaseAssignments.id, input.assignmentId)),
    audit(db, {
      eventType: "UPDATE_DEPLOYED",
      action: "assignment_removed",
      entityType: "release_assignment",
      entityId: input.assignmentId,
      actor: { type: "user", id: input.actor.id },
      before: row,
      after: null,
      correlationId: input.actor.correlationId,
      source: "api",
    }),
  ]);
}
