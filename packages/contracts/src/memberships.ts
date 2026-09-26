import { z } from "zod";
import { Email } from "./auth";

export const MembershipStanding = z.enum(["owner", "admin", "user"]);
export type MembershipStanding = z.infer<typeof MembershipStanding>;

export const MembershipStatus = z.enum(["active", "revoked"]);
export type MembershipStatus = z.infer<typeof MembershipStatus>;

export const Membership = z.object({
  id: z.string(),
  tenantId: z.string(),
  userId: z.string(),
  email: z.string(),
  name: z.string(),
  standing: MembershipStanding,
  status: MembershipStatus,
  invitedBy: z.string().nullable(),
  createdAt: z.string(),
});
export type Membership = z.infer<typeof Membership>;

export const CreateMembershipRequest = z.object({
  email: Email,
  standing: MembershipStanding,
});
export type CreateMembershipRequest = z.infer<typeof CreateMembershipRequest>;

export const UpdateMembershipRequest = z.object({
  standing: MembershipStanding,
});
export type UpdateMembershipRequest = z.infer<typeof UpdateMembershipRequest>;

/** `GET /api/v1/me/tenants`. */
export const MyTenant = z.object({
  tenantId: z.string(),
  publicCode: z.string(),
  displayName: z.string(),
  standing: MembershipStanding,
});
export type MyTenant = z.infer<typeof MyTenant>;

/** `POST /api/v1/me/active-tenant`. */
export const SetActiveTenantRequest = z.object({ tenantId: z.string() });
export type SetActiveTenantRequest = z.infer<typeof SetActiveTenantRequest>;
