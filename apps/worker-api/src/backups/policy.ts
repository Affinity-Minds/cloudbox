// Owner: WT-19. Resolves the effective backup policy for a tenant: its own `backup_policies` row
// when one exists, else the global default at `settings['backups.default_policy']` (seeded by
// migration 0017). Never guessed client-side — every consumer (device policy read, staff editor,
// retention sweep) goes through this.
import {
  type BackupPolicyValues,
  DEFAULT_BACKUP_POLICY,
  type EffectiveBackupPolicy,
} from "@cloudbox/contracts";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { backupPolicies, settings } from "../db/schema";

const DEFAULT_POLICY_SETTINGS_KEY = "backups.default_policy";

async function loadGlobalDefault(db: Db): Promise<BackupPolicyValues> {
  const [row] = await db
    .select({ valueJson: settings.valueJson })
    .from(settings)
    .where(eq(settings.key, DEFAULT_POLICY_SETTINGS_KEY));
  if (!row) return DEFAULT_BACKUP_POLICY;
  try {
    return { ...DEFAULT_BACKUP_POLICY, ...JSON.parse(row.valueJson) };
  } catch {
    return DEFAULT_BACKUP_POLICY;
  }
}

/** One D1 round trip (plus the caller's own batch, when combined). */
export async function getEffectivePolicy(db: Db, tenantId: string): Promise<EffectiveBackupPolicy> {
  const [tenantRow] = await db
    .select()
    .from(backupPolicies)
    .where(eq(backupPolicies.tenantId, tenantId));

  if (tenantRow) {
    return {
      tenantId,
      frequentHours: tenantRow.frequentHours,
      dailyKeep: tenantRow.dailyKeep,
      weeklyKeep: tenantRow.weeklyKeep,
      monthlyKeep: tenantRow.monthlyKeep,
      yearlyKeep: tenantRow.yearlyKeep,
      offsiteEnabled: tenantRow.offsiteEnabled,
      isDefault: false,
      updatedBy: tenantRow.updatedBy,
      updatedAt: tenantRow.updatedAt,
    };
  }

  const fallback = await loadGlobalDefault(db);
  return { tenantId, ...fallback, isDefault: true, updatedBy: null, updatedAt: null };
}
