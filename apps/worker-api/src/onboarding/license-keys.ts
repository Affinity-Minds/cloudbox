// Owner: WT-14. Server licence keys (ADR 0011): staff generate them in batches for resellers; a
// buyer redeems one at onboarding, which creates their tenant with a `pending` subscription for the
// key's plan (redeemed later, at the first server activation).
//
// Keys: `CBX-LIC-XXXXX-XXXXX-XXXXX-XXXXX`: 20 Crockford base32 symbols from crypto.getRandomValues
// (100 bits, WT-3's `randomCrockfordBase32`), four groups of five (the brief's four groups and its
// 20 symbols / ~100 bits cannot both hold with groups of four; see the WT-14 handoff). Only the SHA-256 is stored, plus the last four symbols
// for support lookups; the plaintext exists once, in the generation response.
import type {
  GenerateLicenseKeysRequest,
  GenerateLicenseKeysResponse,
  LicenseKeyBatch,
  LicenseKeyListItem,
  LicenseKeysQuery,
  LicenseKeysResponse,
} from "@cloudbox/contracts";
import { and, desc, eq, isNull, type SQL, sql } from "drizzle-orm";
import { audit } from "../audit";
import { randomCrockfordBase32, sha256Hex } from "../crypto";
import type { Db } from "../db/client";
import { plans, subscriptions, tenants } from "../db/schema";
import { newId } from "../ids";
import { allocateTenantCode, ownedTenantStatements } from "./common";
import { licenseKeys } from "./license-keys-table";

export const LICENSE_KEY_PATTERN = /^CBX-LIC-[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/;

export function formatLicenseKey(): string {
  const s = randomCrockfordBase32(20);
  return `CBX-LIC-${s.slice(0, 5)}-${s.slice(5, 10)}-${s.slice(10, 15)}-${s.slice(15)}`;
}

/**
 * The canonical `CBX-LIC-XXXXX-XXXXX-XXXXX-XXXXX` for a key as typed: upper-cased, spaces and
 * dashes dropped, then re-grouped (review P2-8); null when it cannot be a key.
 */
export function canonicalLicenseKey(raw: string): string | null {
  const s = raw.toUpperCase().replace(/[\s-]+/g, "");
  if (!/^CBXLIC[0-9A-HJKMNP-TV-Z]{20}$/.test(s)) return null;
  const k = s.slice(6);
  return `CBX-LIC-${k.slice(0, 5)}-${k.slice(5, 10)}-${k.slice(10, 15)}-${k.slice(15)}`;
}

/** Hash of the canonical form, so a key typed in lower case or with odd spacing still matches. */
export const hashLicenseKey = (code: string) => sha256Hex(canonicalLicenseKey(code) ?? code);

/**
 * Rows per INSERT. D1 allows 100 bound parameters per statement, so the rows travel as one JSON
 * parameter (`json_each`), 100 per statement (~20 KB): a 500-key batch is 5 statements.
 */
const ROWS_PER_INSERT = 100;

export class LicenseKeyRefusal extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
  ) {
    super(code);
  }
}

export async function generateLicenseKeys(
  db: Db,
  input: GenerateLicenseKeysRequest & { createdBy: string; correlationId: string | null },
  now = new Date(),
): Promise<GenerateLicenseKeysResponse> {
  const [plan] = await db
    .select({ code: plans.code })
    .from(plans)
    .where(eq(plans.code, input.planCode));
  if (!plan) throw new LicenseKeyRefusal(400, "unknown_plan");
  const expiresAt = input.expiresAt ? new Date(input.expiresAt).toISOString() : null;
  if (expiresAt && Date.parse(expiresAt) <= now.getTime()) {
    throw new LicenseKeyRefusal(400, "expires_at_in_past");
  }

  const batchId = newId("licenseKeyBatch");
  const createdAt = now.toISOString();
  const keys: GenerateLicenseKeysResponse["keys"] = [];
  const rows: { id: string; h: string; l: string }[] = [];
  for (let i = 0; i < input.quantity; i += 1) {
    const code = formatLicenseKey();
    const id = newId("licenseKey");
    const last4 = code.slice(-4);
    keys.push({ id, code, last4 });
    rows.push({ id, h: await hashLicenseKey(code), l: last4 });
  }
  const inserts = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    const chunk = JSON.stringify(rows.slice(i, i + ROWS_PER_INSERT));
    // Every column of `licenseKeys`, in declaration order (drizzle's INSERT … SELECT form).
    inserts.push(
      db.insert(licenseKeys).select(sql`
        SELECT json_extract(value, '$.id'), ${batchId}, json_extract(value, '$.h'),
               json_extract(value, '$.l'), ${plan.code}, ${input.batchLabel}, 'unredeemed',
               ${input.createdBy}, ${createdAt}, ${expiresAt}, NULL, NULL, NULL, NULL, NULL
        FROM json_each(${chunk})`),
    );
  }
  // One transaction: every key of the batch and its audit row, or none. Never the keys in the audit.
  await db.batch([
    audit(db, {
      eventType: "LICENSE_KEYS_GENERATED",
      entityType: "license_key_batch",
      entityId: batchId,
      actor: { type: "user", id: input.createdBy },
      before: null,
      after: {
        batchId,
        batchLabel: input.batchLabel,
        planCode: plan.code,
        count: rows.length,
        expiresAt,
      },
      correlationId: input.correlationId,
      source: "api",
    }),
    ...inserts,
  ]);
  return {
    batchId,
    batchLabel: input.batchLabel,
    planCode: plan.code,
    expiresAt,
    count: keys.length,
    keys,
  };
}

const csvCell = (value: string) =>
  /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

export function licenseKeysCsv(batch: GenerateLicenseKeysResponse): string {
  const lines = ["key,last4,plan,batch,expires_at"];
  for (const key of batch.keys) {
    lines.push(
      [key.code, key.last4, batch.planCode, batch.batchLabel, batch.expiresAt ?? ""]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function listLicenseKeys(
  db: Db,
  query: LicenseKeysQuery,
  now = new Date(),
): Promise<LicenseKeysResponse> {
  const filters: SQL[] = [];
  if (query.batch) filters.push(eq(licenseKeys.batchId, query.batch));
  if (query.status) filters.push(eq(licenseKeys.status, query.status));
  if (query.last4) filters.push(eq(licenseKeys.codeLast4, query.last4));
  const [items, batches] = await db.batch([
    db
      .select({
        id: licenseKeys.id,
        batchId: licenseKeys.batchId,
        batchLabel: licenseKeys.batchLabel,
        codeLast4: licenseKeys.codeLast4,
        planCode: licenseKeys.planCode,
        status: licenseKeys.status,
        createdBy: licenseKeys.createdBy,
        createdAt: licenseKeys.createdAt,
        expiresAt: licenseKeys.expiresAt,
        redeemedAt: licenseKeys.redeemedAt,
        redeemedTenantId: licenseKeys.redeemedTenantId,
        redeemedTenantCode: tenants.publicCode,
        redeemedByEmail: licenseKeys.redeemedByEmail,
        revokedAt: licenseKeys.revokedAt,
        revokeReason: licenseKeys.revokeReason,
      })
      .from(licenseKeys)
      .leftJoin(tenants, eq(tenants.id, licenseKeys.redeemedTenantId))
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(licenseKeys.createdAt), licenseKeys.id)
      .limit(1000),
    db
      .select({
        batchId: licenseKeys.batchId,
        batchLabel: sql<string>`min(${licenseKeys.batchLabel})`.as("b_label"),
        planCode: sql<string>`min(${licenseKeys.planCode})`.as("b_plan"),
        createdAt: sql<string>`min(${licenseKeys.createdAt})`.as("b_created_at"),
        createdBy: sql<string>`min(${licenseKeys.createdBy})`.as("b_created_by"),
        expiresAt: sql<string | null>`min(${licenseKeys.expiresAt})`.as("b_expires_at"),
        total: sql<number>`count(*)`.mapWith(Number).as("b_total"),
        unredeemed: sql<number>`sum(${licenseKeys.status} = 'unredeemed')`
          .mapWith(Number)
          .as("b_unredeemed"),
        redeemed: sql<number>`sum(${licenseKeys.status} = 'redeemed')`
          .mapWith(Number)
          .as("b_redeemed"),
        revoked: sql<number>`sum(${licenseKeys.status} = 'revoked')`
          .mapWith(Number)
          .as("b_revoked"),
        // Migration 0011 (owner addition): the plan's current price, for display only — see
        // LicenseKeyBatch's own doc comment.
        planPriceAmount: sql<number>`min(${plans.priceAmount})`.mapWith(Number).as("b_price"),
        planCurrency: sql<string>`min(${plans.currency})`.as("b_currency"),
      })
      .from(licenseKeys)
      .leftJoin(plans, eq(plans.code, licenseKeys.planCode))
      .groupBy(licenseKeys.batchId)
      .orderBy(desc(sql`b_created_at`)),
  ]);
  const at = now.toISOString();
  return {
    batches: batches as LicenseKeyBatch[],
    items: items.map(
      (row): LicenseKeyListItem => ({
        ...row,
        expired: row.status === "unredeemed" && row.expiresAt !== null && row.expiresAt <= at,
      }),
    ),
  };
}

export async function revokeLicenseKey(
  db: Db,
  input: { id: string; reason: string; actorId: string; correlationId: string | null },
): Promise<void> {
  const revokedAt = new Date().toISOString();
  const [row] = await db
    .update(licenseKeys)
    .set({ status: "revoked", revokedAt, revokeReason: input.reason })
    .where(and(eq(licenseKeys.id, input.id), eq(licenseKeys.status, "unredeemed")))
    .returning({
      batchId: licenseKeys.batchId,
      codeLast4: licenseKeys.codeLast4,
      planCode: licenseKeys.planCode,
    });
  if (!row) {
    const [existing] = await db
      .select({ status: licenseKeys.status })
      .from(licenseKeys)
      .where(eq(licenseKeys.id, input.id));
    if (!existing) throw new LicenseKeyRefusal(404, "not_found");
    throw new LicenseKeyRefusal(409, `already_${existing.status}`);
  }
  await audit(db, {
    eventType: "LICENSE_KEY_REVOKED",
    entityType: "license_key",
    entityId: input.id,
    actor: { type: "user", id: input.actorId },
    before: { status: "unredeemed" },
    after: { status: "revoked", revokedAt, reason: input.reason, ...row },
    correlationId: input.correlationId,
    source: "api",
  });
}

/**
 * Redeems a key for a signed-in customer: claims the key (one conditional UPDATE, checked alone:
 * agent-notes cloudflare-workers "a transaction cannot be made conditional on one row changed"),
 * then in one batch creates the tenant, the caller's owner membership, a `pending` subscription
 * for the key's plan, links the key to the tenant, and audits it all. If the batch fails the claim
 * is given back. Every refusal is the same `invalid_license_key`.
 */
export async function redeemLicenseKey(
  db: Db,
  input: {
    code: string;
    displayName: string;
    timezone: string;
    userId: string;
    email: string;
    correlationId: string | null;
  },
  now = new Date(),
): Promise<{ tenantId: string; tenantCode: string; subscriptionId: string }> {
  const invalid = new LicenseKeyRefusal(400, "invalid_license_key");
  const code = canonicalLicenseKey(input.code);
  if (!code || !LICENSE_KEY_PATTERN.test(code)) throw invalid;
  const at = now.toISOString();
  const codeHash = await sha256Hex(code);
  const [claimed] = await db
    .update(licenseKeys)
    .set({ status: "redeemed", redeemedAt: at, redeemedByEmail: input.email })
    .where(
      and(
        eq(licenseKeys.codeHash, codeHash),
        eq(licenseKeys.status, "unredeemed"),
        isNull(licenseKeys.revokedAt),
        sql`(${licenseKeys.expiresAt} IS NULL OR ${licenseKeys.expiresAt} > ${at})`,
      ),
    )
    .returning({ id: licenseKeys.id, planCode: licenseKeys.planCode });
  if (!claimed) throw invalid;

  const [plan] = await db.select().from(plans).where(eq(plans.code, claimed.planCode));
  try {
    if (!plan) throw new Error(`license key ${claimed.id}: plan ${claimed.planCode} missing`);
    const tenantId = newId("tenant");
    const tenantCode = await allocateTenantCode(db, at);
    const subscriptionId = newId("subscription");
    const subscription = {
      id: subscriptionId,
      tenantId,
      planCode: plan.code,
      status: "pending" as const,
      validFrom: null,
      validUntil: null,
      maxManagedUsers: plan.maxManagedUsers,
      featuresJson: plan.featuresJson,
      offlineGraceDays: plan.offlineGraceDays,
      renewalWarningDays: plan.renewalWarningDays,
      createdAt: at,
      updatedAt: at,
    };
    const actor = { type: "user" as const, id: input.userId, tenantId };
    await db.batch([
      ...ownedTenantStatements(db, {
        tenantId,
        tenantCode,
        userId: input.userId,
        email: input.email,
        displayName: input.displayName,
        timezone: input.timezone,
        source: "license_redemption",
        correlationId: input.correlationId,
        now: at,
      }),
      db.insert(subscriptions).values(subscription),
      // After the tenant insert, so the FK is satisfied.
      db
        .update(licenseKeys)
        .set({ redeemedTenantId: tenantId })
        .where(eq(licenseKeys.id, claimed.id)),
      audit(db, {
        eventType: "SUBSCRIPTION_CHANGED",
        action: "created",
        entityType: "subscription",
        entityId: subscriptionId,
        actor,
        before: null,
        after: {
          ...subscription,
          features: JSON.parse(plan.featuresJson),
          licenseKeyId: claimed.id,
        },
        correlationId: input.correlationId,
        source: "license_key",
      }),
      audit(db, {
        eventType: "LICENSE_KEY_REDEEMED",
        entityType: "license_key",
        entityId: claimed.id,
        actor,
        before: { status: "unredeemed" },
        after: {
          status: "redeemed",
          redeemedAt: at,
          redeemedTenantId: tenantId,
          redeemedByEmail: input.email,
          planCode: plan.code,
          subscriptionId,
        },
        correlationId: input.correlationId,
        source: "license_redemption",
      }),
    ]);
    return { tenantId, tenantCode, subscriptionId };
  } catch (error) {
    // Give the key back: nothing else was written (the batch is one transaction).
    await db
      .update(licenseKeys)
      .set({ status: "unredeemed", redeemedAt: null, redeemedByEmail: null })
      .where(and(eq(licenseKeys.id, claimed.id), isNull(licenseKeys.redeemedTenantId)));
    throw error;
  }
}
