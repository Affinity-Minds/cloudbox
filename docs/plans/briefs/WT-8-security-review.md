# WT-8 — Adversarial security review of Phase 1 (and Phase 2/3 cloud) before merge to main
Model: **Opus 5.5**. Read-only on code. Branch: none; check out `phase-1/identity` (and later `phase-2/devices`, `phase-3/entitlement`) at the SHA WT-0 names. Writes only `docs/reviews/phase-1-security.md` (then `phase-2…`, `phase-3…`) and negative-test requests.

Starter prompt (from spec Section H): act as an adversarial reviewer, not the original implementer. Review the diff against the security invariants in spec §0.11, §6, §7, §9, §35, §37, §38, §39. Prefer concrete exploit or failure paths over style. Add or request a negative test for every material finding. Do not approve on passing happy-path tests.

Checklist to drive it:
- OTP: single use, expiry, resend supersedes, per-email and per-IP rate limit; identical responses for known/unknown email; `OTP_DEV_ECHO` cannot be on in production (prove with a test that asserts the guard); codes never logged.
- Sessions: host-only cookie, `trustedOrigins` correct, logout invalidates server-side, Better Auth CSRF/origin check exercised **with** a cookie in the repro.
- Authorisation: every `/api/v1/*` route except `agent/enroll` and `auth/*` has `requireUser` and a permission or standing check; grep the route files and list any that do not. Super Admin permissions are rows; removing a row denies. Tenant id is taken from the path and re-resolved against `tenant_memberships`, never from the body.
- Tenant boundary: Tenant A member → Tenant B tenant/device/subscription/entitlement/audit reads → 403/404 with no data. Fleet loader filtered for tenant-standing callers.
- Enrollment: token hash only, single use atomic (batch), expired/revoked rejected, thumbprint uniqueness, response leaks nothing about other tenants; device bearer token hash only, revocation stops heartbeat within one request.
- Entitlement: `ENTITLEMENT_SIGNING_JWK` only via secret, public half in `signing_keys`, `kid` pinned, unsupported alg rejected, token never audited or logged, generation monotonic, revoked entitlement not served.
- Audit: every consequential write audited with before/after; audit rows immutable (triggers from 0002 still present after 0003).
- Secrets: nothing in `wrangler.jsonc` `vars` that authenticates; `.dev.vars` gitignored.
- Deploy workflow: version-stamp equality check present; no piped gating commands masking exit codes (`set -o pipefail`).
- Email: OTP body contains only the code; `E_SENDER_NOT_VERIFIED` and other send failures do not change the HTTP response; `OTP_DEV_ECHO` guard tested.
- Windows uninstall (WT-4): no path deletes customer data without `--purge-data` plus typed confirmation; manifest cannot be edited by a standard user (ACL SYSTEM/Administrators); uninstall revokes the device token on the cloud and deletes the CNG key so a re-enrolled machine cannot reuse the old identity; `verify-clean` is exhaustive over every manifest kind; self-delete step cannot be pointed at an arbitrary path.

Output: findings ranked Critical/High/Medium/Low with file:line, exploit path, and the exact negative test to add. WT-0 blocks the Phase 1 merge on any unresolved Critical/High.
