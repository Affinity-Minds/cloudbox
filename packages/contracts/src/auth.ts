import { z } from "zod";

export const StaffRole = z.enum(["super_admin", "admin", "support", "read_only"]);
export type StaffRole = z.infer<typeof StaffRole>;

/**
 * One spelling per mailbox (review U-1): NFKC-normalised, trimmed and lower-cased *before*
 * validation, so compatibility and case variants (e.g. the Kelvin sign "K") map to the same address
 * as its plain spelling, and every limit keyed by it is shared.
 */
export const normalizeEmail = (value: string) => value.normalize("NFKC").trim().toLowerCase();

export const Email = z
  .string()
  .max(320)
  .transform(normalizeEmail)
  .pipe(z.email().max(254));

/** `POST /api/auth/email-otp/send-verification-otp` (Better Auth emailOTP plugin). */
export const OtpSendRequest = z.object({
  email: Email,
  type: z.literal("sign-in"),
});
export type OtpSendRequest = z.infer<typeof OtpSendRequest>;

/** `POST /api/auth/sign-in/email-otp`. */
export const OtpVerifyRequest = z.object({
  email: Email,
  otp: z.string().regex(/^\d{6}$/),
});
export type OtpVerifyRequest = z.infer<typeof OtpVerifyRequest>;

export const SessionUser = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  staffRole: StaffRole.nullable(),
});
export type SessionUser = z.infer<typeof SessionUser>;

/**
 * Staff first-sign-in gates (ADR 0009). Until both are false, every staff route answers 403
 * `setup_required` and the console sends the user to /setup-password, then /setup-authenticator.
 */
export const StaffSetup = z.object({
  passwordChangeRequired: z.boolean(),
  authenticatorRequired: z.boolean(),
});
export type StaffSetup = z.infer<typeof StaffSetup>;

/** `GET /api/v1/auth/session`. */
export const SessionResponse = z.object({
  user: SessionUser,
  permissions: z.array(z.string()),
  activeTenantId: z.string().nullable(),
  /** Present for staff only. */
  setup: StaffSetup.nullable().optional(),
  /** Which sign-in surface the session came from: `/login` (customer) or the ops login (staff). */
  surface: z.enum(["customer", "staff"]).optional(),
});
export type SessionResponse = z.infer<typeof SessionResponse>;

/** Staff passwords (ADR 0009): an admin sets the initial one; the staff member must change it. */
export const StaffPassword = z.string().min(12).max(256);

/**
 * `POST /api/v1/staff`. `initialPassword` is required when the email is not yet staff; for an
 * existing staff member it resets the password, which forces a change and authenticator
 * re-enrolment at the next sign-in. Never logged or audited.
 */
export const CreateStaffRequest = z.object({
  email: Email,
  role: StaffRole,
  initialPassword: StaffPassword.optional(),
});
export type CreateStaffRequest = z.infer<typeof CreateStaffRequest>;

export const StaffMember = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string(),
  role: StaffRole,
  createdBy: z.string().nullable(),
  createdAt: z.string(),
});
export type StaffMember = z.infer<typeof StaffMember>;
