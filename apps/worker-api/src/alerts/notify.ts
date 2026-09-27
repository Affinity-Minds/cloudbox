// Owner: WT-17. Alert email notifications (spec §25 "do not email every heartbeat failure
// independently"; the brief's cooldown rule). Sends to the tenant's support/primary contact
// (device/tenant alerts) and the staff distribution list (`getStaffRecipients`), gated by a 6h
// cooldown per dedupe key stored on `alerts.notified_at`. Only `open` alerts of severity
// `warning`/`critical` are notified — an `acknowledged` alert has already been seen by a human,
// and `info` never pages anyone.
//
// TODO(WT-17, not built): a daily digest option (one summary email instead of per-alert sends)
// was called out in the brief as a later enhancement; nothing here builds it yet.
import { ALERT_CATEGORY_LABEL, type AlertCategory, type AlertSeverity } from "@cloudbox/contracts";
import { eq, inArray } from "drizzle-orm";
import { audit } from "../audit";
import type { Db } from "../db/client";
import { alerts, tenants } from "../db/schema";
import { sendEmail } from "../email/send";
import type { Bindings } from "../env";
import { getStaffRecipients } from "./settings";

const COOLDOWN_MS = 6 * 60 * 60_000;

export type NotifiableAlert = {
  id: string;
  category: AlertCategory;
  severity: AlertSeverity;
  tenantId: string | null;
  deviceId: string | null;
  notifiedAt: string | null;
  evidence: Record<string, unknown>;
};

function dueForNotification(alert: NotifiableAlert, now: Date): boolean {
  if (alert.severity === "info") return false;
  if (!alert.notifiedAt) return true;
  return now.getTime() - Date.parse(alert.notifiedAt) >= COOLDOWN_MS;
}

function emailBody(
  alert: NotifiableAlert,
  tenant: { code: string; name: string } | undefined,
): { subject: string; text: string } {
  const label = ALERT_CATEGORY_LABEL[alert.category];
  const scope = tenant ? `${tenant.name} (${tenant.code})` : "CloudBox";
  const subject = `[CloudBox] ${alert.severity.toUpperCase()}: ${label} — ${scope}`;
  const lines = [
    `${label} (${alert.severity}) is currently open.`,
    tenant ? `Tenant: ${tenant.name} (${tenant.code})` : null,
    alert.deviceId ? `Device: ${alert.deviceId}` : null,
    Object.keys(alert.evidence).length > 0 ? `Evidence: ${JSON.stringify(alert.evidence)}` : null,
    "",
    "Acknowledge or resolve this alert from the CloudBox console's Alerts page.",
  ].filter((line): line is string => line !== null);
  return { subject, text: lines.join("\n") };
}

/**
 * Notifies every candidate that is due (severity, cooldown), then stamps `notified_at` and audits
 * `ALERT_NOTIFIED`. Candidates with no resolvable recipient are skipped without spending the
 * cooldown, so configuring a contact later lets the next cron tick notify promptly.
 */
export async function notifyOpenAlerts(
  env: Bindings,
  db: Db,
  candidates: NotifiableAlert[],
  now = new Date(),
): Promise<number> {
  const due = candidates.filter((a) => dueForNotification(a, now));
  if (due.length === 0) return 0;

  const staffRecipients = await getStaffRecipients(db);
  const tenantIds = [...new Set(due.map((a) => a.tenantId).filter((t): t is string => t !== null))];
  const tenantContacts = new Map<string, { code: string; name: string; email: string | null }>();
  if (tenantIds.length > 0) {
    const rows = await db
      .select({
        id: tenants.id,
        code: tenants.publicCode,
        name: tenants.displayName,
        support: tenants.supportContactEmail,
        primary: tenants.primaryContactEmail,
      })
      .from(tenants)
      .where(inArray(tenants.id, tenantIds));
    for (const row of rows) {
      tenantContacts.set(row.id, {
        code: row.code,
        name: row.name,
        email: row.support ?? row.primary ?? null,
      });
    }
  }

  const nowIsoStr = now.toISOString();
  let notified = 0;

  for (const alert of due) {
    const tenant = alert.tenantId ? tenantContacts.get(alert.tenantId) : undefined;
    const recipients = [...staffRecipients];
    if (tenant?.email) recipients.push(tenant.email);
    if (recipients.length === 0) continue;

    const { subject, text } = emailBody(alert, tenant);
    let anySent = false;
    for (const to of recipients) {
      const outcome = await sendEmail(
        env,
        { to, subject, text },
        { purpose: "alert_notification" },
      );
      if (outcome.messageId) anySent = true;
    }

    await db.update(alerts).set({ notifiedAt: nowIsoStr }).where(eq(alerts.id, alert.id));
    await audit(db, {
      eventType: "ALERT_NOTIFIED",
      entityType: "alert",
      entityId: alert.id,
      actor: { type: "system", id: "alerts-evaluator", tenantId: alert.tenantId },
      before: null,
      after: { category: alert.category, severity: alert.severity, recipients, sent: anySent },
      source: "cron",
    });
    notified += 1;
  }

  return notified;
}
