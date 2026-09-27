// Owner: WT-P2-reasons. Reason catalogues for every revoke/retire/archive/delete confirmation
// (docs/handoffs/wt-p2-reason-dropdowns.md). One zod enum per action, so the API validates the
// exact same list the admin-web `ReasonSelect` dropdown offers — no catalogue drift between the
// two. `reasonRequest()` builds the `{ reasonCode, reasonText? }` request shape shared by every
// endpoint: `reasonText` is required (min 5 chars) only when `reasonCode` is `"other"`.
//
// Backwards compatibility: every endpoint here also accepts the old bare `{ reason: string }`
// shape for one release, mapped to `{ reasonCode: "other", reasonText: reason }`. Remove the
// legacy branch once callers have moved over (tracked in the handoff).
import { z } from "zod";

function reasonRequest<T extends readonly [string, ...string[]]>(codes: T) {
  const ReasonCode = z.enum(codes);
  const current = z
    .object({
      reasonCode: ReasonCode,
      reasonText: z.string().trim().min(5).max(500).optional(),
    })
    .refine((value) => value.reasonCode !== "other" || (value.reasonText?.length ?? 0) >= 5, {
      message: 'reasonText (min 5 chars) is required when reasonCode is "other"',
      path: ["reasonText"],
    });
  // Legacy shape (pre-dropdown): a bare free-text reason, same minimum length it always had.
  const legacy = z.object({ reason: z.string().trim().min(3).max(500) });
  const Request = z
    .union([current, legacy])
    .transform((value) =>
      "reasonCode" in value
        ? { reasonCode: value.reasonCode, reasonText: value.reasonText?.trim() || undefined }
        : { reasonCode: "other" as const, reasonText: value.reason.trim() },
    );
  return { ReasonCode, Request };
}

/** `<code>: <text>` when there's free text, else the bare code — the format stored in an
 * existing `revoke_reason`/`reason` column and easy to read back in an audit list. */
export function formatReason(value: { reasonCode: string; reasonText?: string }): string {
  return value.reasonText ? `${value.reasonCode}: ${value.reasonText}` : value.reasonCode;
}

export const DEVICE_REVOKE_REASON_CODES = [
  "decommissioned",
  "replaced",
  "lost_or_stolen",
  "tenant_offboarded",
  "security_incident",
  "other",
] as const;
const deviceRevoke = reasonRequest(DEVICE_REVOKE_REASON_CODES);
export const DeviceRevokeReasonCode = deviceRevoke.ReasonCode;
export type DeviceRevokeReasonCode = z.infer<typeof DeviceRevokeReasonCode>;
export const RevokeDeviceRequest = deviceRevoke.Request;
export type RevokeDeviceRequest = z.infer<typeof RevokeDeviceRequest>;

export const ENTITLEMENT_REVOKE_REASON_CODES = [
  "non_payment",
  "tenant_offboarded",
  "device_replaced",
  "issued_in_error",
  "security_incident",
  "other",
] as const;
const entitlementRevoke = reasonRequest(ENTITLEMENT_REVOKE_REASON_CODES);
export const EntitlementRevokeReasonCode = entitlementRevoke.ReasonCode;
export type EntitlementRevokeReasonCode = z.infer<typeof EntitlementRevokeReasonCode>;
export const RevokeEntitlementRequest = entitlementRevoke.Request;
export type RevokeEntitlementRequest = z.infer<typeof RevokeEntitlementRequest>;

export const LICENSE_KEY_REVOKE_REASON_CODES = [
  "store_return",
  "issued_in_error",
  "lost_or_leaked",
  "batch_withdrawn",
  "other",
] as const;
const licenseKeyRevoke = reasonRequest(LICENSE_KEY_REVOKE_REASON_CODES);
export const LicenseKeyRevokeReasonCode = licenseKeyRevoke.ReasonCode;
export type LicenseKeyRevokeReasonCode = z.infer<typeof LicenseKeyRevokeReasonCode>;
export const RevokeLicenseKeyRequest = licenseKeyRevoke.Request;
export type RevokeLicenseKeyRequest = z.infer<typeof RevokeLicenseKeyRequest>;

export const PLAN_RETIRE_REASON_CODES = [
  "superseded",
  "pricing_change",
  "discontinued",
  "other",
] as const;
const planRetire = reasonRequest(PLAN_RETIRE_REASON_CODES);
export const PlanRetireReasonCode = planRetire.ReasonCode;
export type PlanRetireReasonCode = z.infer<typeof PlanRetireReasonCode>;
export const RetirePlanRequest = planRetire.Request;
export type RetirePlanRequest = z.infer<typeof RetirePlanRequest>;

export const TENANT_ARCHIVE_REASON_CODES = [
  "churned",
  "duplicate",
  "test_tenant",
  "merged",
  "other",
] as const;
const tenantArchive = reasonRequest(TENANT_ARCHIVE_REASON_CODES);
export const TenantArchiveReasonCode = tenantArchive.ReasonCode;
export type TenantArchiveReasonCode = z.infer<typeof TenantArchiveReasonCode>;
export const ArchiveTenantRequest = tenantArchive.Request;
export type ArchiveTenantRequest = z.infer<typeof ArchiveTenantRequest>;

export const MEMBERSHIP_REVOKE_REASON_CODES = [
  "left_organisation",
  "role_change",
  "security_incident",
  "other",
] as const;
const membershipRevoke = reasonRequest(MEMBERSHIP_REVOKE_REASON_CODES);
export const MembershipRevokeReasonCode = membershipRevoke.ReasonCode;
export type MembershipRevokeReasonCode = z.infer<typeof MembershipRevokeReasonCode>;
/**
 * Unlike the other catalogues above, this one is optional: the ops console's tenant-detail
 * dialog always sends the catalogued `{reasonCode, reasonText?}` shape (WT-2's `<ReasonSelect>`),
 * but the customer portal's members page (WT-15, no dropdown there) sends a bare free-text
 * `{reason}` or no body at all — a self-service removal is not held to the same bureaucratic
 * standard as a staff action. The bare-`{}` branch (same pattern as `RevokeStaffRequest` below)
 * lets a missing body still validate.
 */
export const RemoveMembershipRequest = z
  .union([membershipRevoke.Request, z.object({}).strict()])
  .transform((value) => ("reasonCode" in value ? value : {}));
export type RemoveMembershipRequest = z.infer<typeof RemoveMembershipRequest>;

/**
 * WT-15's staff revoke reason predates this catalogue (`docs/handoffs/wt-p13-portal-staff.md`)
 * and was, and stays, entirely optional — `revokeStaff()` sends no body at all when the operator
 * gives no reason. Unlike every other catalogue above, the request schema is a union with a bare
 * `{}` branch so a missing body still validates; `reasonCode`/`reasonText` are absent (not just
 * `undefined`-typed) on that branch, transformed to `{}` rather than `{reasonCode: undefined, ...}`.
 */
export const STAFF_REVOKE_REASON_CODES = [
  "role_change",
  "offboarded",
  "security_incident",
  "other",
] as const;
const staffRevoke = reasonRequest(STAFF_REVOKE_REASON_CODES);
export const StaffRevokeReasonCode = staffRevoke.ReasonCode;
export type StaffRevokeReasonCode = z.infer<typeof StaffRevokeReasonCode>;
export const RevokeStaffRequest = z
  .union([staffRevoke.Request, z.object({}).strict()])
  .transform((value) => ("reasonCode" in value ? value : {}));
export type RevokeStaffRequest = z.infer<typeof RevokeStaffRequest>;

export const EMAIL_PROVIDER_DELETE_REASON_CODES = [
  "replaced",
  "credentials_rotated",
  "unused",
  "other",
] as const;
const emailProviderDelete = reasonRequest(EMAIL_PROVIDER_DELETE_REASON_CODES);
export const EmailProviderDeleteReasonCode = emailProviderDelete.ReasonCode;
export type EmailProviderDeleteReasonCode = z.infer<typeof EmailProviderDeleteReasonCode>;
export const DeleteEmailProviderRequest = emailProviderDelete.Request;
export type DeleteEmailProviderRequest = z.infer<typeof DeleteEmailProviderRequest>;
