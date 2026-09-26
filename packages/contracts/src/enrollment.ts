import { z } from "zod";

export const CreateEnrollmentTokenRequest = z.object({
  label: z.string().trim().min(1).max(120),
  expiresInHours: z.number().int().min(1).max(168).default(24),
});
export type CreateEnrollmentTokenRequest = z.infer<typeof CreateEnrollmentTokenRequest>;

/** Stored form: only the hash is persisted; the plaintext is shown once at creation. */
export const EnrollmentToken = z.object({
  id: z.string(),
  tenantId: z.string(),
  label: z.string(),
  createdBy: z.string(),
  expiresAt: z.string(),
  redeemedAt: z.string().nullable(),
  redeemedDeviceId: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type EnrollmentToken = z.infer<typeof EnrollmentToken>;

/** `POST /api/v1/tenants/:tenantId/enrollment-tokens` → 201. `token` is never returned again. */
export const CreateEnrollmentTokenResponse = EnrollmentToken.extend({
  token: z.string(),
});
export type CreateEnrollmentTokenResponse = z.infer<typeof CreateEnrollmentTokenResponse>;
