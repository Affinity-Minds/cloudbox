import { z } from "zod";

export const StaffRole = z.enum(["super_admin", "admin", "support", "read_only"]);
export type StaffRole = z.infer<typeof StaffRole>;

export const Email = z
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());

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

/** `GET /api/v1/auth/session`. */
export const SessionResponse = z.object({
  user: SessionUser,
  permissions: z.array(z.string()),
  activeTenantId: z.string().nullable(),
});
export type SessionResponse = z.infer<typeof SessionResponse>;

/** `POST /api/v1/staff`. */
export const CreateStaffRequest = z.object({
  email: Email,
  role: StaffRole,
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
