# ADR 0002 — Email one-time codes via Better Auth and Cloudflare Email Service (customers); closed sign-in

**Status:** Accepted, amended 2026-09-27 (owner decisions: closed sign-in; staff use password + authenticator, see ADR 0009)
**Date:** 2026-09-26 (proposed), 2026-09-27 (amended)
**Context:** Slice 1.1 implementation (WT-1), WT-8 review H-1/H-2/M-3
**Stakeholders:** WT-0, WT-1 (Auth), WT-2 (memberships), WT-12 (email providers)

## Problem

CloudBox needs passwordless sign-in for tenant members (the customer portal), with no custom auth
code, a verified sending domain, a local dev mode, rate limits, and no way to learn from the sign-in
screen whether an address has an account. Staff sign in differently (ADR 0009).

## Decision

1. **Better Auth 1.7 `emailOTP` plugin** over D1 (Drizzle adapter). Codes: 6 digits, 5 minutes,
   single use (atomic consume), 3 attempts then burned, stored encrypted with `BETTER_AUTH_SECRET`
   (recoverable, so a resend can re-send the same code). Only `type: "sign-in"` codes are issued.
2. **Closed sign-in.** Sign-in never creates a `user` row (`disableSignUp`, plus our own masking in
   the send hook). An address with no user row, and a staff address, get exactly the answer a
   customer gets (`200 {success:true}`), but no code is generated, stored or sent; the request is
   recorded as `AUTH_OTP_SENT {outcome: "unknown_email" | "staff_email", client}`. A code submitted
   for such an address fails exactly like a wrong code (`400 INVALID_OTP`). Users come into existence
   only through admin actions: staff grants (`POST /api/v1/staff`), tenant memberships (WT-2), and
   the bootstrap super admin — all through `ensureUserByEmail(env, email)` in
   `apps/worker-api/src/auth/users.ts`.
3. **Resend re-sends the still-valid code** (`resendStrategy: "reuse"`): a send request by anyone else
   cannot invalidate the code already in the owner's inbox.
4. **Limits.** Better Auth per-IP limits in D1 (`rate_limit`, migration 0004): send 3 / 60 s, code
   sign-in 3 / 60 s. On top, from the audit log: per (email, client IP or IPv6 /64) 5 sends / 15 min,
   per email 30 / h. Over a cap the caller gets the same 200 with nothing sent or recorded — never a
   429 that would let a third party lock an address out or reveal whether it exists (review H-1).
   Failed code sign-ins for addresses without a user row are audited once per 15 min (review M-3).
5. **Cloudflare Email Service** binding `EMAIL`, from `no-reply@em.affinity.ai.in`. The send result is
   recorded (`{outcome: "sent", messageId}` or `{outcome: "send_failed", errorCode}`); a failure never
   changes the HTTP response. WT-12 is adding a provider registry behind `sendOtpEmail`; the masking
   above stays in the auth layer, not in the email module.
6. **Dev mode:** `OTP_DEV_ECHO=1` (only with `ENVIRONMENT !== "production"`) logs `[otp-dev-echo]
   <email> <code>`; with `ENVIRONMENT=production` it makes `createAuth` throw. `createAuth` also throws
   without `BETTER_AUTH_SECRET`.
7. **Surface:** only the endpoints the product uses answer under `/api/auth/*` (exact allowlist in
   `src/index.ts`); everything else is 404. Every POST there needs a same-origin `Origin`.

## Alternatives considered

- **Open sign-up** (the first implementation): uniform by construction, but every probe for an
  address wrote a `user` row and any verified address became a principal. Rejected by the owner.
- **429 on a per-email cap:** lets anyone lock any address out (review H-1). Rejected.
- **Resend, SMTP relay, custom OTP:** see the original ADR text in git history; unchanged reasons.

## Consequences

- An address can sign in only after an administrator created it; the UI copy never states that a
  code was sent ("If this address can sign in, a code is on its way").
- The audit log records sends and failures per address (bounded as above); it is only visible to
  staff with `audit.view`.
- Timing: the email is sent after the response (`waitUntil`), so known and unknown addresses answer
  in similar time; no artificial delays.

## See also

- ADR 0009 (staff: password + authenticator; customers: codes only)
- `docs/handoffs/wt-p1-auth.md`, `docs/reviews/phase-1-security.md` (H-1, H-2, M-3)
