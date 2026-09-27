// Owner: WT-17. Alert evaluator (spec §25/§44, brief Slices 14.1-14.2): runs on a Cron Trigger
// every 5 minutes (src/index.ts `scheduled`) and derives every open/resolved alert purely from D1
// state — never from the heartbeat request path (other worktrees own `routes/v1/agent.ts`; this
// file only reads what heartbeats already wrote to `devices.last_seen_at`/`last_health_json`).
//
// Design: one persistent row per `dedupe_key` for the table's lifetime. A condition that clears
// resolves its row; a condition that recurs later *reopens the same row* rather than inserting a
// second one (`dedupe_key` is UNIQUE, and a plain second INSERT would collide with the old,
// resolved row — the exact "unique index remembers a value forever" trap agent-notes
// cloudflare-workers warns about for SQLite/D1). `ALERT_OPENED`/`ALERT_RESOLVED` are audited
// (system actor) only on that transition; refreshing a still-open alert's evidence is not.
//
// Categories evaluated here: `device_offline`, `license_expiring`, `license_expired`,
// `no_active_plan`, and — from `last_health_json` when present — `rdp_unhealthy`,
// `private_network_failed`, `disk_low`, `reboot_required`. The remaining categories in
// `ALERT_CATEGORIES` (`clock_tamper`, `device_binding_failure`, `backup_*`, `agent_outdated`,
// `update_failed`, `break_glass_active`) belong to phases 9-12/tamper-detection, not built yet;
// they are valid rows the table already accepts, not evaluated by this cron (per the brief's
// explicit scope for Slices 14.1-14.2).
import { AgentHealth, type AlertCategory, type AlertSeverity } from "@cloudbox/contracts";
import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { audit } from "../audit";
import type { Db } from "../db/client";
import { alerts, devices, entitlements, subscriptions, tenants } from "../db/schema";
import { subscriptionLifecycle } from "../entitlement/status";
import type { Bindings } from "../env";
import { newId } from "../ids";
import { notifyOpenAlerts } from "./notify";

const OFFLINE_AFTER_MS = 10 * 60_000;
/** Spec §24: warning below 20% free, critical below 10% free. */
const DISK_WARNING_PERCENT = 20;
const DISK_CRITICAL_PERCENT = 10;

export type ProblemInstance = {
  category: AlertCategory;
  severity: AlertSeverity;
  tenantId: string | null;
  deviceId: string | null;
  evidence: Record<string, unknown>;
};

export const dedupeKeyFor = (p: Pick<ProblemInstance, "category" | "deviceId" | "tenantId">) =>
  `${p.category}:${p.deviceId ?? p.tenantId ?? "global"}`;

type TenantSubRow = {
  tenantId: string;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
  validFrom: string | null;
  validUntil: string | null;
  renewalWarningDays: number | null;
};

/** Whether the tenant's newest non-cancelled subscription is issuable right now (§9.1). */
function isIssuable(row: TenantSubRow, now: Date): boolean {
  if (!row.subscriptionId || !row.validFrom || !row.validUntil) return false;
  if (row.renewalWarningDays === null || !row.subscriptionStatus) return false;
  return subscriptionLifecycle(
    {
      status: row.subscriptionStatus as never,
      validFrom: row.validFrom,
      validUntil: row.validUntil,
      renewalWarningDays: row.renewalWarningDays,
    },
    now,
  ).issuable;
}

/** Health-derived problems for one device, from its last reported `AgentHealth` document. */
function healthProblems(
  deviceId: string,
  tenantId: string,
  lastHealthJson: string | null,
): ProblemInstance[] {
  if (!lastHealthJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(lastHealthJson);
  } catch {
    return [];
  }
  const health = AgentHealth.safeParse(parsed);
  if (!health.success) return [];
  const out: ProblemInstance[] = [];
  const { rdp, network, updates, storage } = health.data;

  if (rdp && rdp.state !== "healthy" && rdp.state !== "unknown") {
    out.push({
      category: "rdp_unhealthy",
      severity: "warning",
      tenantId,
      deviceId,
      evidence: { state: rdp.state, listener: rdp.listener },
    });
  }
  if (network && network.state !== "connected" && network.state !== "unknown") {
    out.push({
      category: "private_network_failed",
      severity: "warning",
      tenantId,
      deviceId,
      evidence: { state: network.state },
    });
  }
  if (updates?.reboot_required) {
    out.push({
      category: "reboot_required",
      severity: "info",
      tenantId,
      deviceId,
      evidence: {},
    });
  }
  if (
    storage &&
    storage.free_bytes != null &&
    storage.total_bytes != null &&
    storage.total_bytes > 0
  ) {
    const freePercent = (storage.free_bytes / storage.total_bytes) * 100;
    if (freePercent < DISK_CRITICAL_PERCENT) {
      out.push({
        category: "disk_low",
        severity: "critical",
        tenantId,
        deviceId,
        evidence: { freePercent, freeBytes: storage.free_bytes, totalBytes: storage.total_bytes },
      });
    } else if (freePercent < DISK_WARNING_PERCENT) {
      out.push({
        category: "disk_low",
        severity: "warning",
        tenantId,
        deviceId,
        evidence: { freePercent, freeBytes: storage.free_bytes, totalBytes: storage.total_bytes },
      });
    }
  }
  return out;
}

async function computeProblems(db: Db, now: Date): Promise<ProblemInstance[]> {
  const offlineCutoff = new Date(now.getTime() - OFFLINE_AFTER_MS).toISOString();

  // One row per tenant (a tenant has at most one non-cancelled subscription — WT-5 invariant).
  const tenantRows: TenantSubRow[] = await db
    .select({
      tenantId: tenants.id,
      subscriptionId: subscriptions.id,
      subscriptionStatus: subscriptions.status,
      validFrom: subscriptions.validFrom,
      validUntil: subscriptions.validUntil,
      renewalWarningDays: subscriptions.renewalWarningDays,
    })
    .from(tenants)
    .leftJoin(
      subscriptions,
      and(eq(subscriptions.tenantId, tenants.id), ne(subscriptions.status, "cancelled")),
    );

  const deviceRows = await db
    .select({
      id: devices.id,
      tenantId: devices.tenantId,
      lastSeenAt: devices.lastSeenAt,
      lastHealthJson: devices.lastHealthJson,
    })
    .from(devices)
    .where(eq(devices.status, "enrolled"));

  const liveEntitlementRows = await db
    .select({ deviceId: entitlements.deviceId })
    .from(entitlements)
    .where(isNull(entitlements.revokedAt));
  const liveEntitlementDeviceIds = new Set(liveEntitlementRows.map((r) => r.deviceId));

  const tenantById = new Map(tenantRows.map((r) => [r.tenantId, r]));

  const problems: ProblemInstance[] = [];

  for (const t of tenantRows) {
    if (!t.subscriptionId || !t.validFrom || !t.validUntil || t.renewalWarningDays === null) {
      continue;
    }
    const { expiry } = subscriptionLifecycle(
      {
        status: t.subscriptionStatus as never,
        validFrom: t.validFrom,
        validUntil: t.validUntil,
        renewalWarningDays: t.renewalWarningDays,
      },
      now,
    );
    if (expiry === "expiring") {
      problems.push({
        category: "license_expiring",
        severity: "warning",
        tenantId: t.tenantId,
        deviceId: null,
        evidence: { validUntil: t.validUntil, renewalWarningDays: t.renewalWarningDays },
      });
    } else if (expiry === "expired") {
      problems.push({
        category: "license_expired",
        severity: "critical",
        tenantId: t.tenantId,
        deviceId: null,
        evidence: { validUntil: t.validUntil },
      });
    }
  }

  for (const d of deviceRows) {
    if (!d.lastSeenAt || d.lastSeenAt < offlineCutoff) {
      problems.push({
        category: "device_offline",
        severity: "warning",
        tenantId: d.tenantId,
        deviceId: d.id,
        evidence: { lastSeenAt: d.lastSeenAt },
      });
    }

    const tenantSub = tenantById.get(d.tenantId);
    const hasPlan = tenantSub ? isIssuable(tenantSub, now) : false;
    if (!liveEntitlementDeviceIds.has(d.id) && !hasPlan) {
      problems.push({
        category: "no_active_plan",
        severity: "warning",
        tenantId: d.tenantId,
        deviceId: d.id,
        evidence: {},
      });
    }

    problems.push(...healthProblems(d.id, d.tenantId, d.lastHealthJson));
  }

  return problems;
}

type ExistingAlertRow = {
  id: string;
  tenantId: string | null;
  deviceId: string | null;
  category: string;
  severity: string;
  status: string;
  dedupeKey: string;
  notifiedAt: string | null;
};

export type EvaluationResult = { opened: number; resolved: number; notified: number };

/** Runs one evaluation pass and reconciles `alerts` with the current problem set. */
export async function evaluateAlerts(
  env: Bindings,
  db: Db,
  now: Date = new Date(),
): Promise<EvaluationResult> {
  const problems = await computeProblems(db, now);
  const currentKeys = new Set(problems.map(dedupeKeyFor));

  // Every row that either matches a currently-detected problem, or is still active from a prior
  // run (so a condition that cleared can be resolved even if it produced no problem this time).
  // Bounded by (active rows + current problems), not by the table's full resolved history, which
  // only grows — `alerts_status_severity_idx`/the unique `dedupe_key` index both apply.
  const dedupeKeys = [...currentKeys];
  const existingRows: ExistingAlertRow[] = await db
    .select({
      id: alerts.id,
      tenantId: alerts.tenantId,
      deviceId: alerts.deviceId,
      category: alerts.category,
      severity: alerts.severity,
      status: alerts.status,
      dedupeKey: alerts.dedupeKey,
      notifiedAt: alerts.notifiedAt,
    })
    .from(alerts)
    .where(
      or(
        ne(alerts.status, "resolved"),
        dedupeKeys.length > 0 ? inArray(alerts.dedupeKey, dedupeKeys) : undefined,
      ),
    );
  const existingByKey = new Map(existingRows.map((r) => [r.dedupeKey, r]));

  const nowIsoStr = now.toISOString();
  let opened = 0;
  let resolved = 0;
  const toNotify: Parameters<typeof notifyOpenAlerts>[2] = [];

  for (const problem of problems) {
    const key = dedupeKeyFor(problem);
    const existing = existingByKey.get(key);
    const evidenceJson = JSON.stringify(problem.evidence);

    if (!existing) {
      const id = newId("alert");
      await db.insert(alerts).values({
        id,
        tenantId: problem.tenantId,
        deviceId: problem.deviceId,
        category: problem.category,
        severity: problem.severity,
        status: "open",
        dedupeKey: key,
        openedAt: nowIsoStr,
        lastEvidenceJson: evidenceJson,
        lastSeenAt: nowIsoStr,
      });
      await audit(db, {
        eventType: "ALERT_OPENED",
        entityType: "alert",
        entityId: id,
        actor: { type: "system", id: "alerts-evaluator", tenantId: problem.tenantId },
        before: null,
        after: { category: problem.category, severity: problem.severity, dedupeKey: key },
        source: "cron",
      });
      opened += 1;
      toNotify.push({ ...problem, id, notifiedAt: null });
    } else if (existing.status === "resolved") {
      await db
        .update(alerts)
        .set({
          status: "open",
          openedAt: nowIsoStr,
          lastSeenAt: nowIsoStr,
          lastEvidenceJson: evidenceJson,
          severity: problem.severity,
          resolvedAt: null,
          acknowledgedAt: null,
          acknowledgedBy: null,
        })
        .where(eq(alerts.id, existing.id));
      await audit(db, {
        eventType: "ALERT_OPENED",
        entityType: "alert",
        entityId: existing.id,
        actor: { type: "system", id: "alerts-evaluator", tenantId: problem.tenantId },
        before: { status: "resolved" },
        after: { status: "open", dedupeKey: key },
        source: "cron",
      });
      opened += 1;
      toNotify.push({ ...problem, id: existing.id, notifiedAt: null });
    } else {
      await db
        .update(alerts)
        .set({ lastSeenAt: nowIsoStr, lastEvidenceJson: evidenceJson, severity: problem.severity })
        .where(eq(alerts.id, existing.id));
      if (existing.status === "open") {
        toNotify.push({ ...problem, id: existing.id, notifiedAt: existing.notifiedAt });
      }
    }
  }

  for (const row of existingRows) {
    if (
      (row.status === "open" || row.status === "acknowledged") &&
      !currentKeys.has(row.dedupeKey)
    ) {
      await db
        .update(alerts)
        .set({ status: "resolved", resolvedAt: nowIsoStr })
        .where(eq(alerts.id, row.id));
      await audit(db, {
        eventType: "ALERT_RESOLVED",
        entityType: "alert",
        entityId: row.id,
        actor: { type: "system", id: "alerts-evaluator", tenantId: row.tenantId },
        before: { status: row.status },
        after: { status: "resolved" },
        source: "cron",
      });
      resolved += 1;
    }
  }

  const notified = await notifyOpenAlerts(env, db, toNotify, now);
  return { opened, resolved, notified };
}
