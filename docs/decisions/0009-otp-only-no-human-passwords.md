# ADR 0009 — One-time codes everywhere; no human-typed passwords

**Status:** Accepted (owner decision, 2026-09-27 01:15 IST). Overrides spec §4.5, §14.2, §28.1 where they specify a password for CloudBox Connect.

## Context
The spec gives SaaS administrators email OTP and gives CloudBox Connect end users Tenant ID + Client ID + password. The owner has decided the product will not ask any human for a password.

## Decision
- Every human sign-in in CloudBox (Super Admin console, tenant portal, CloudBox Connect) uses a one-time code delivered out of band. Console/portal: email OTP via Better Auth (Phase 1, as built). Connect: Tenant ID + Client ID identify the client identity; the code is delivered to the email on that client identity. Step-up for sensitive actions is a fresh code.
- No `emailAndPassword`/credential plugin is enabled anywhere; no password columns exist for humans; no reset-password flow exists.
- Sign-in never creates accounts. A user row exists only because an administrator created it (staff grant, tenant membership add, bootstrap super admin). Unknown emails receive the same response as known ones and nothing is stored.
- Tenant memberships and staff roles are granted directly by an authorised administrator; there is no invite-acceptance step.
- Machine credentials are unaffected: managed Windows account passwords (random, rotated, never shown to humans), the per-device support credential in the vault, device bearer tokens and enrollment codes are not human passwords and remain as designed.

## Consequences
- Client identities (Phase 6, WT-11) need a deliverable address; Connect's login screen becomes Tenant ID + Client ID + code, with the code entry identical to the console's.
- The anti-enumeration guarantee moves from "any email gets a row" to "unknown emails are indistinguishable but never stored" (WT-1 follow-up).
- Fewer tables, no password hashing dependency, one sign-in UX across three products.

## Verification / follow-up
- WT-1 follow-up PR: unknown-email tests, bootstrap pre-creation, `ensureUserByEmail`.
- ALPHA_v0.1.md WT-11 row updated; `docs/plans/briefs/WT-1-auth.md` and `WT-2-tenants.md` remain valid.
