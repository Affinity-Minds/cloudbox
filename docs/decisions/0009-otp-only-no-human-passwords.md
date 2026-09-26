# ADR 0009 — Sign-in model: staff use password + authenticator; everyone else uses one-time codes

**Status:** Accepted (owner decisions, 2026-09-27 01:15 and 01:50 IST). Overrides spec §6.1 (staff email OTP) and §4.5/§14.2/§28.1 (Connect password).

## Context
The spec gives SaaS administrators email OTP and gives CloudBox Connect end users Tenant ID + Client ID + password. The owner has decided the product will not ask any human for a password.

## Decision
- **Staff** (Super Admin, Admin, Support, Read Only): email + password + authenticator app (TOTP). First sign-in is forced through changing the initial password and enrolling an authenticator (QR shown once, backup codes shown once). Staff never receive email codes. Step-up for sensitive actions is a fresh TOTP.
- **Tenant members** (portal) and **CloudBox Connect** users: one-time codes only, no password. Console/portal: email OTP via Better Auth. Connect: Tenant ID + Client ID identify the client identity; the code goes to that identity's email.
- Passwords exist only for staff, hashed by Better Auth; there is no self-service reset by email (an administrator sets a new initial password, which again forces change + re-enrolment).
- Sign-in never creates accounts. A user row exists only because an administrator created it (staff grant, tenant membership add, bootstrap super admin). Unknown emails receive the same response as known ones and nothing is stored.
- Tenant memberships and staff roles are granted directly by an authorised administrator; there is no invite-acceptance step.
- Machine credentials are unaffected: managed Windows account passwords (random, rotated, never shown to humans), the per-device support credential in the vault, device bearer tokens and enrollment codes are not human passwords and remain as designed.

## Consequences
- Client identities (Phase 6, WT-11) need a deliverable address; Connect's login screen becomes Tenant ID + Client ID + code, with the code entry identical to the console's.
- The anti-enumeration guarantee moves from "any email gets a row" to "unknown emails are indistinguishable but never stored" (WT-1 follow-up).
- Two sign-in entry points on one login page (staff / customer); customers never see a password field.

## Verification / follow-up
- WT-1 follow-up PR: unknown-email tests, bootstrap pre-creation, `ensureUserByEmail`.
- ALPHA_v0.1.md WT-11 row updated; `docs/plans/briefs/WT-1-auth.md` and `WT-2-tenants.md` remain valid.
