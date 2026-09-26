// Owner: WT-0. The single Drizzle schema for D1. Other worktrees request columns via their handoff.
// Better Auth tables are generated (`pnpm auth:generate`) from src/auth; do not hand-edit them.
// Our timestamps are ISO-8601 UTC text; Better Auth's are its generated integer millis.
import { relations, sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const isoNow = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
const createdAt = () => text("created_at").notNull().default(isoNow);

// ─── Phase 0 (migrations 0001/0002, extended by 0003) ─────────────────────────────────────────

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey().notNull(),
  valueJson: text("value_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey().notNull(),
    eventType: text("event_type").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
    createdAt: text("created_at").notNull(),
    actorTenantId: text("actor_tenant_id"),
    correlationId: text("correlation_id"),
    source: text("source"),
  },
  (table) => [
    index("audit_log_created_at_idx").on(table.createdAt),
    index("audit_log_entity_idx").on(table.entityType, table.entityId, table.createdAt),
    index("audit_log_actor_tenant_idx").on(table.actorTenantId, table.createdAt),
  ],
);

// ─── Better Auth (generated: auth@1.7.6 generate, drizzle/sqlite, plugins: emailOTP) ──────────

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).default(false).notNull(),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));

// ─── Staff and permissions ────────────────────────────────────────────────────────────────────

export const STAFF_ROLES = ["super_admin", "admin", "support", "read_only"] as const;
const staffRoleCheck = sql`('super_admin', 'admin', 'support', 'read_only')`;

export const staffMembers = sqliteTable(
  "staff_members",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id),
    role: text("role", { enum: STAFF_ROLES }).notNull(),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (table) => [check("staff_members_role_check", sql`${table.role} IN ${staffRoleCheck}`)],
);

export const permissions = sqliteTable("permissions", {
  key: text("key").primaryKey(),
  description: text("description").notNull(),
});

export const rolePermissions = sqliteTable(
  "role_permissions",
  {
    role: text("role", { enum: STAFF_ROLES }).notNull(),
    permissionKey: text("permission_key")
      .notNull()
      .references(() => permissions.key),
  },
  (table) => [
    primaryKey({ columns: [table.role, table.permissionKey] }),
    check("role_permissions_role_check", sql`${table.role} IN ${staffRoleCheck}`),
  ],
);

// ─── Plans ────────────────────────────────────────────────────────────────────────────────────

export const plans = sqliteTable("plans", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  maxDevices: integer("max_devices").notNull(),
  maxManagedUsers: integer("max_managed_users").notNull(),
  featuresJson: text("features_json").notNull(),
  offlineGraceDays: integer("offline_grace_days").notNull(),
  renewalWarningDays: integer("renewal_warning_days").notNull(),
});

// ─── Tenancy ──────────────────────────────────────────────────────────────────────────────────

export const TENANT_STATUSES = [
  "trial",
  "provisioning",
  "active",
  "past_due",
  "suspended",
  "cancelled",
  "archived",
] as const;

export const tenants = sqliteTable(
  "tenants",
  {
    id: text("id").primaryKey(),
    publicCode: text("public_code").notNull().unique(),
    displayName: text("display_name").notNull(),
    legalName: text("legal_name"),
    status: text("status", { enum: TENANT_STATUSES }).notNull().default("provisioning"),
    primaryContactEmail: text("primary_contact_email"),
    supportContactEmail: text("support_contact_email"),
    billingContactEmail: text("billing_contact_email"),
    timezone: text("timezone").notNull().default("UTC"),
    maintenanceWindowJson: text("maintenance_window_json"),
    renewalWarningDays: integer("renewal_warning_days").notNull().default(30),
    backupPolicyJson: text("backup_policy_json"),
    planCode: text("plan_code").references(() => plans.code),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: text("updated_at").notNull().default(isoNow),
    archivedAt: text("archived_at"),
  },
  (table) => [
    index("tenants_status_idx").on(table.status, table.createdAt),
    check(
      "tenants_status_check",
      sql`${table.status} IN ('trial', 'provisioning', 'active', 'past_due', 'suspended', 'cancelled', 'archived')`,
    ),
  ],
);

export const MEMBERSHIP_STANDINGS = ["owner", "admin", "user"] as const;

export const tenantMemberships = sqliteTable(
  "tenant_memberships",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    standing: text("standing", { enum: MEMBERSHIP_STANDINGS }).notNull(),
    status: text("status", { enum: ["active", "revoked"] })
      .notNull()
      .default("active"),
    invitedBy: text("invited_by"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("tenant_memberships_tenant_user_uq").on(table.tenantId, table.userId),
    index("tenant_memberships_user_idx").on(table.userId, table.status),
    check(
      "tenant_memberships_standing_check",
      sql`${table.standing} IN ('owner', 'admin', 'user')`,
    ),
    check("tenant_memberships_status_check", sql`${table.status} IN ('active', 'revoked')`),
  ],
);

// ─── Devices and enrollment ───────────────────────────────────────────────────────────────────

export const devices = sqliteTable(
  "devices",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: text("name").notNull(),
    status: text("status", { enum: ["enrolled", "revoked", "transferred"] })
      .notNull()
      .default("enrolled"),
    devicePublicKeyJwk: text("device_public_key_jwk").notNull(),
    deviceKeyThumbprint: text("device_key_thumbprint").notNull().unique(),
    keyProtection: text("key_protection", { enum: ["tpm", "software"] }).notNull(),
    hostname: text("hostname").notNull(),
    windowsBuild: text("windows_build"),
    agentVersion: text("agent_version"),
    lastSeenAt: text("last_seen_at"),
    lastHealthJson: text("last_health_json"),
    enrolledAt: text("enrolled_at").notNull().default(isoNow),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    index("devices_tenant_status_idx").on(table.tenantId, table.status),
    check("devices_status_check", sql`${table.status} IN ('enrolled', 'revoked', 'transferred')`),
    check("devices_key_protection_check", sql`${table.keyProtection} IN ('tpm', 'software')`),
  ],
);

export const enrollmentTokens = sqliteTable(
  "enrollment_tokens",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    tokenHash: text("token_hash").notNull().unique(),
    label: text("label").notNull(),
    createdBy: text("created_by").notNull(),
    expiresAt: text("expires_at").notNull(),
    redeemedAt: text("redeemed_at"),
    redeemedDeviceId: text("redeemed_device_id").references(() => devices.id),
    revokedAt: text("revoked_at"),
    createdAt: createdAt(),
  },
  (table) => [index("enrollment_tokens_tenant_idx").on(table.tenantId, table.createdAt)],
);

export const deviceCredentials = sqliteTable(
  "device_credentials",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: createdAt(),
    revokedAt: text("revoked_at"),
  },
  (table) => [index("device_credentials_device_idx").on(table.deviceId)],
);

// ─── Subscriptions and entitlements ───────────────────────────────────────────────────────────

export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    planCode: text("plan_code")
      .notNull()
      .references(() => plans.code),
    status: text("status", {
      enum: ["trial", "active", "past_due", "suspended", "cancelled"],
    }).notNull(),
    validFrom: text("valid_from").notNull(),
    validUntil: text("valid_until").notNull(),
    maxManagedUsers: integer("max_managed_users").notNull(),
    featuresJson: text("features_json").notNull(),
    offlineGraceDays: integer("offline_grace_days").notNull(),
    renewalWarningDays: integer("renewal_warning_days").notNull(),
    createdAt: createdAt(),
    updatedAt: text("updated_at").notNull().default(isoNow),
  },
  (table) => [
    index("subscriptions_tenant_status_idx").on(table.tenantId, table.status),
    check(
      "subscriptions_status_check",
      sql`${table.status} IN ('trial', 'active', 'past_due', 'suspended', 'cancelled')`,
    ),
  ],
);

export const entitlements = sqliteTable(
  "entitlements",
  {
    id: text("id").primaryKey(),
    subscriptionId: text("subscription_id")
      .notNull()
      .references(() => subscriptions.id),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id),
    generation: integer("generation").notNull(),
    claimsJson: text("claims_json").notNull(),
    /** Compact JWE. Never logged, never returned to the admin UI. */
    token: text("token").notNull(),
    issuedBy: text("issued_by").notNull(),
    issuedAt: text("issued_at").notNull().default(isoNow),
    validUntil: text("valid_until").notNull(),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    uniqueIndex("entitlements_device_generation_uq").on(table.deviceId, table.generation),
    index("entitlements_subscription_idx").on(table.subscriptionId),
  ],
);

export const signingKeys = sqliteTable(
  "signing_keys",
  {
    kid: text("kid").primaryKey(),
    alg: text("alg").notNull(),
    publicJwk: text("public_jwk").notNull(),
    status: text("status", { enum: ["active", "retired"] })
      .notNull()
      .default("active"),
    createdAt: createdAt(),
  },
  (table) => [check("signing_keys_status_check", sql`${table.status} IN ('active', 'retired')`)],
);
