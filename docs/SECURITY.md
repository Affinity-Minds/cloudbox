# Security Architecture

This document describes the security boundaries, enforcement mechanisms, limits, and audit trail for CloudBox.

## Invariants and boundaries

- **No secrets in repository:** Credentials, API keys, and tokens stay in GitHub and Cloudflare secret stores only.
- **D1 is authoritative:** Cloud state is the single source of truth; the VPN controller has no independent authority.
- **Server-side enforcement:** Every permission check, tenant boundary, and rate limit is enforced on the cloud API, not delegated to clients.
- **No custom cryptography:** Entitlement tokens use JWE (RFC 7516); all cryptographic operations use standard libraries (jose, .NET framework).
- **Versioned API contract:** `/api/v1/*` is the public API version; internal routes start with `/api/ops/*` or `/api/auth/*`.
- **Audit trail:** Every consequential state change is logged immutably with actor, entity, action, before/after state, timestamp, and tenant scope.

## Trust boundaries

### 1. Customer identity ↔ Staff identity
- Completely separate tables and login flows (ADR 0002).
- No shared secrets or credentials.
- Staff authenticates via password + TOTP; customers via email-OTP only.
- Enforced: `POST /api/ops/auth/*` routes reject customer sessions; customer routes reject staff sessions.

### 2. Customer ↔ Tenant
- A `customer_user` may belong to multiple tenants as a `tenant_membership`.
- Tenant membership grants `standing` (owner/admin/user).
- Enforced: Every `/api/v1/tenants/{tenantId}/*` route checks that the caller is an active member of that tenant.
- Enforced: A caller cannot impersonate another tenant by passing a different tenant ID in the request body (path tenant ID is authoritative).

### 3. Tenant ↔ Device
- Devices belong to a single tenant and cannot move between tenants (revoke + re-enroll only).
- Enforced: Device heartbeat auth is bearer-token on a credential issued at enrollment; credentials are tenant-scoped and cannot be reused elsewhere.

### 4. Device ↔ Entitlement
- Entitlements are issued per-device, per-subscription, per-generation.
- Tokens are JWE-encrypted and never stored or logged in plaintext (ADR 0004).
- Token claims include: device ID, generation, subscription ID, plan limits (maxDevices, maxManagedUsers), valid-from/until timestamps.
- Enforced: Devices verify tokens offline using a public key deployed at enrollment; tokens are not trusted after expiry or revocation.

### 5. Rate limiting
- Per-email / per-IP limits on OTP sends and verifications (H-1 fix, c573cc2):
  - OTP send: 5 per (email, client IP /64) per 15 min, 30 per email per hour, 10 per 24 h to new addresses.
  - OTP verify: 3 failed attempts per IP per 60 s, code is burned after 3 failures.
- Per-IP limits on staff password sign-in (3 failures per 10 s) and `/two-factor/*` endpoints (3 per 10 s).
- Per-client (IP + path) limit on Connect sign-in: 3 per 60 s per path per IP.
- Enforced: Rate-limit state is stored in per-key rows in `staff_rate_limit` / `customer_rate_limit` tables; state is cleared and buckets are rotated.

## Security enforcement details

### Authentication and session management

**Staff flow (password + TOTP):**
1. Staff enters email + password at `/api/ops/auth/sign-in/credential`.
2. If correct, staff gets an OTP code via email.
3. Staff enters OTP + (optional) TOTP secret at `/api/ops/auth/sign-in/email-otp`.
4. Cloud issues a session token (stored in `staff_sessions` table).
5. Session expires after 7 days (configurable).
6. Enforced: Password must be changed on first sign-in (mustChangePassword flag in `staff_members`).
7. Enforced: 2FA (TOTP) is optional but recommended for super_admin role.

**Customer flow (email-OTP only):**
1. Customer enters email at `POST /api/auth/start/send-code`.
2. Cloud checks if email is known (customer_users); if not, issues code for account creation.
3. Cloud sends OTP via email (subject to rate limits above).
4. Customer enters code at `POST /api/auth/start/verify-code`.
5. Code is consumed atomically (single `DELETE … RETURNING` statement).
6. On success, cloud issues a session token (stored in `customer_sessions` table).
7. Session expires after 30 days (configurable).
8. Enforced: Codes are hashed in the database; plaintext codes exist only in the email.
9. Enforced: Resends reuse the existing code if still valid (no code multiplication).

**Connect client sign-in:**
1. Employee runs Connect client, selects tenant (public code) and enters email.
2. Client sends `POST /api/auth/connect/send-code` with tenant code + email.
3. Cloud checks if email is a member of that tenant (P2-2 fix, 8c388e1).
4. If yes (member): sends code, answers `{success:true}`.
5. If no (non-member): answers identical `{success:true}` (no membership oracle via timing).
6. Employee enters code at `POST /api/auth/connect/verify-code`.
7. Cloud verifies code and issues a session token.
8. Enforced: Per-path rate limit (3 / 60 s per client IP) runs before membership check.
9. Enforced: All 4xx responses from verification are re-serialized to identical `CONNECT_INVALID` message.

### Authorization and permissions

**Staff roles and permissions:**
- Roles: `super_admin`, `admin`, `support`, `read_only`.
- Permissions are rows in the `permissions` table; role → permission mapping is in `role_permissions`.
- Enforced: Every protected route calls `requireStaff(role)` or `requirePermission(key)` middleware.
- Enforced: Route paths (not body) are the source of truth for tenant scope (can't overrride by sending a different tenant ID in body).

**Bootstrap:**
- On first staff sign-in with the bootstrap email (e.g., `soren@affinityminds.net`), a single `INSERT … SELECT … WHERE NOT EXISTS` grants `super_admin` role.
- D1 serializes writes, so two concurrent isolates cannot both grant.
- Enforced: All other role grants are explicit admin actions, audited.

**Tenant membership:**
- Membership rows: `(tenantId, userId, standing, status)`.
- Standing: `owner` > `admin` > `user` (permission hierarchy).
- Status: `active` or `revoked`.
- Enforced: Ownership is sticky — only the last owner cannot be demoted (checked with a race-free conditional UPDATE).
- Enforced: Revoking a membership sets `status='revoked'` and removes all permissions for that user in that tenant on the next request.

### Device enrollment and key management

**Enrollment:**
1. Tenant admin calls `POST /api/v1/tenants/{tenantId}/activation-grants` to mint an activation code.
2. Code is valid for 7 days.
3. Server installer displays an enrollment code (token derived from a randomly generated key).
4. Admin enters activation code into a web form; server displays enrollment code.
5. On server boot, installer retrieves enrollment code from registry and calls `POST /api/v1/agent/enroll`.
6. Request: activation code + enrollment code (hashed for storage) + public key (JWK format).
7. Cloud validates: enrollment token matches, not already redeemed.
8. Cloud issues `devices` row and first `device_credentials` row.
9. Cloud issues first `entitlements` row (auto-activates pending subscription).
10. Enforced: Enrollment code is single-use and expires after 7 days.
11. Enforced: Activation code is single-use and expires after 7 days.

**Device credentials and rotation:**
- Credentials are bearer tokens issued at enrollment and rotated on every successful heartbeat.
- Tokens are hashed in `device_credentials` table.
- Enforced: Each credential has a unique hash; a device can have multiple active credentials (old + new during rotation).
- Enforced: Revocation sets `revokedAt` and prevents future use.

### Licensing and entitlements

**License key generation (staff operation):**
1. Staff calls `POST /api/ops/licenses/generate` with plan code, quantity, batch label, optional expiry.
2. Cloud generates N random keys (format: `CLOUDBOX-XXXX-XXXX-XXXX` where X is alphanumeric, case-insensitive).
3. Plaintext keys are returned only once (in response).
4. Hashes (SHA-256) and last-4 are stored in `license_keys` table.
5. Each key row includes: `batchId` (groups one call), `planCode`, `status` (unredeemed/redeemed/revoked), `createdBy`, `createdAt`, `expiresAt`.
6. Enforced: No key is stored in plaintext in the database.

**License key redemption (customer operation):**
1. Customer calls `POST /api/v1/licenses/redeem` with key code (normalized: uppercase, no spaces/dashes).
2. Cloud hashes the code, looks up the key by code_hash.
3. Validates: status is `unredeemed`, not expired.
4. Updates license_keys row: `status='redeemed'`, `redeemedAt`, `redeemedTenantId`, `redeemedByEmail`.
5. Updates `subscriptions` row: plan code and term from the key's plan, status from `pending` to `active`, dates filled in.
6. Enforced: One key redeems one subscription; multiple keys can be redeemed by the same tenant across different subscriptions.

**Entitlement issuance:**
1. On device enrollment (first heartbeat), cloud calls `issueForDevice`.
2. Checks: subscription exists, subscription is active, subscription.maxDevices is not exceeded.
3. Enforced: Entitlement count is checked atomically with insertion (`INSERT … SELECT … WHERE count < max`), preventing race condition (P2-1 fix, 8c388e1).
4. Creates `entitlements` row with: subscriptionId, deviceId, generation=1, claimsJson (features, limits), token (JWE), issuedBy, issuedAt, validUntil.
5. Token is JWE-encrypted; plaintext is never logged or displayed.
6. Token claims: `{device_id, generation, subscription_id, max_devices, max_managed_users, valid_from, valid_until, issuer}`.

**Entitlement revocation:**
1. Tenant admin or staff calls `POST /api/v1/devices/{deviceId}/entitlements/revoke`.
2. Cloud sets `revokedAt` on the current generation's entitlements.
3. Increments `generation` counter in the `devices` row.
4. On next heartbeat, device's generation mismatch triggers new entitlement issuance.
5. Enforced: Revocation is immediate (no grace period); device loses access on next heartbeat.

### Audit trail

Every audit event includes:
- `id` — unique event ID.
- `eventType` — action type (e.g., `DEVICE_ENROLLED`, `ENTITLEMENT_ISSUED`, `STAFF_MEMBER_ADDED`, `LICENSE_KEY_REDEEMED`).
- `entityType` — entity being audited (e.g., `device`, `subscription`, `staff_member`).
- `entityId` — ID of the entity.
- `actorType` — who triggered the action (e.g., `staff_user`, `customer_user`, `service`).
- `actorId` — ID of the actor.
- `action` — human-readable verb (e.g., `"enroll"`, `"revoke"`, `"redeem"`).
- `beforeJson` — JSON snapshot of entity state before the change (or null for creates).
- `afterJson` — JSON snapshot of entity state after the change (or null for deletes).
- `createdAt` — ISO-8601 timestamp (server time).
- `actorTenantId` — tenant scope (if applicable).
- `correlationId` — request trace ID (minted server-side).
- `source` — origin of the action (e.g., `api`, `webhook`, `background_job`).

Enforcement:
- **Immutability:** Trigger `audit_log_no_delete` prevents any DELETE on audit log.
- **Audit retention:** Audit log is not truncated or aged out (append-only).
- **Indexed for queries:** Indexes on `(createdAt)`, `(entityType, entityId, createdAt)`, `(actorTenantId, createdAt)`.

## Open findings (Phase 1 and Phase 2 reviews)

### Low-priority items

From the Phase 1 security review (`docs/reviews/phase-1-security.md`), the following Low-level findings are still open:

- **P2-7:** Drizzle metadata is out of date for migration 0010. `drizzle-kit generate` still emits a rebuild for `subscriptions` because the `meta/` snapshot was not regenerated. Regenerate the snapshot and add `license_keys` table to drizzle-kit schema list to prevent duplicate migration on next `db:generate`.

- **P2-9:** Tenant creation via staff route (WT-2) can mistype the `primaryContactEmail`. If the email is typo'd, that address becomes the Owner. No account access is granted until they verify the email with a code, so only the real holder of that mailbox gains access. Recommendation: show contact back in creation confirmation and consider a "pending owner" state until first sign-in.

### Fixed in prior commits

The following findings were reported as open but have been resolved:

- **H-1** (OTP send rate-limit lockout): Fixed in commit `c573cc2` (WT-1). OTP send caps keyed on `(email, client IP /64)` 5 per 15 min plus per-email ceiling 30 per h; resends reuse valid codes.

- **H-2** (Unused Better Auth endpoints): Fixed in `c573cc2` (WT-1). Exact-match allowlist in `src/index.ts`; every other `/api/auth/*` path answers 404.

- **M-1** (Unguarded `/api/v1` routes): Fixed in `c573cc2` (WT-1). Stubs that remain have `requireStaff()` guard; owners delete their line when real handler lands.

- **M-2** (Unpinned dependencies at deploy time): Fixed in `dc4a98a` (WT-0). Deploy uses `--frozen-lockfile`, secrets scoped to steps only, third-party actions pinned by SHA.

- **M-3** (Unbounded audit log growth and mail): Fixed in `c573cc2` (WT-1). Sign-in no longer creates users (closed sign-up); sends are bounded by per-IP limits; failed verifies for unknowns are aggregated.

- **L-1** (Localhost origin in production): Fixed in `c573cc2`. `trustedOrigins(env)` adds Vite origin only outside production.

- **L-2** (Login CSRF on email-OTP): Fixed in `c573cc2`. Every POST under `/api/auth/*` requires trusted Origin or `Sec-Fetch-Site: same-origin`.

- **L-3** (Client-supplied correlation ID): Fixed in `c573cc2`. Correlation ID always minted server-side; client value only echoed on response.

- **L-4** (`PHASE0_ADMIN_KEY` persistence): Fixed in `dc4a98a`. Key deleted at deploy end; comparison is via HMAC.

- **L-5** (`workers_dev: true`): Fixed in `dc4a98a`. Set to false.

- **L-6** (Dev values in production config): Fixed in `dc4a98a`. Route moved to env.production; CI grep enforces no OTP_DEV_ECHO in wrangler.jsonc.

- **L-7** (Unaudited state changes): Fixed in `c573cc2` / `7ebffc8`. Unaudited endpoints removed; every state change is audited.

- **L-8** (Race in last-super-admin check): Fixed in `c573cc2`. Demotion and revoke carry the "another remains" condition inside the statement.

- **L-9** (`safeRedirect` accepts backslash): Fixed in `c573cc2`. Resolved URL must keep our origin; backslashes refused.

- **L-10** (Missing `BETTER_AUTH_SECRET` not fail-closed): Fixed in `c573cc2`. `assertAuthConfig` throws when secret is missing in any environment.

- **L-11** (Sign-in rate limit documentation): Fixed in handoff WT-1. Corrected to 3 / 60 s per IP.

- **P2-1** (Parallel device activation race): Fixed in `8c388e1` (WT-14). Entitlement insertion uses `INSERT … SELECT … WHERE count < max` with atomic check.

- **P2-2** (Connect timing leak): Fixed in `8c388e1`. Per-client rate limit runs first; all responses identical.

- **P2-3** (Testing keys outside dev): Fixed in `8c388e1`. Turnstile testing keys accepted only when `ENVIRONMENT === "development"`.

- **P2-4** (Suspended tenant can mint grants): Fixed in `8c388e1`. Grants allowed only for provisioning, active, trial tenants.

- **P2-5** (Mail-bomb on start path): Fixed in `8c388e1`. Per-address ceiling: 10 per 24 h to addresses without a customer row.

- **P2-6** (Tenant count revealed by sequential codes): Fixed in `8c388e1`. Lifetime cap: 5 self-created tenants per customer; sequential codes accepted as documented in ADR 0011.

- **P2-8** (Licence key normalization): Fixed in `8c388e1`. `canonicalLicenseKey` normalizes input before format check.

- **W-1** (`opsBasePath` accepts `/api`): Fixed in `8c388e1`. Rejects reserved paths; falls back to `/ops`.

## Secrets inventory

Secrets stored in GitHub and Cloudflare only:

- **CLOUDFLARE_API_TOKEN** — Cloudflare account-wide API token (Workers, D1, R2 scope). Stored in GitHub as repo secret. Used at deploy time only.
- **ACCOUNT_ID** — Cloudflare account numeric ID. Stored in GitHub as repo variable (not secret).
- **TURNSTILE_SITE_KEY** — Cloudflare Turnstile public key. Stored in GitHub as repo variable (public).
- **TURNSTILE_SECRET_KEY** — Cloudflare Turnstile secret key. Stored in GitHub as repo secret. Used at bootstrap time only.
- **BOOTSTRAP_SUPER_ADMIN_EMAIL** — Initial staff email (e.g., `soren@affinityminds.net`). Stored in GitHub as repo variable (public).
- **BETTER_AUTH_SECRET** — Symmetric key for Better Auth session signing. Stored in Cloudflare environment variable (never in repository).
- **OTP_DEV_ECHO** — Flag to enable OTP echo in development (always false in production, enforced by CI).
- **Email provider secrets** (if SMTP): SMTP password / API key. Stored encrypted in D1 `email_providers.secretCiphertext` using AES-256-GCM (key is BETTER_AUTH_SECRET).

Enforcement:
- No secrets in `.env` files committed to git.
- All secrets have a CI step that fails if found in committed code.
- Rotation runbook: `docs/runbooks/licensing-key-rotation.md`.

## Compliance notes

- Phase 1 and Phase 2 security reviews completed and findings documented.
- All High and Medium findings from Phase 1 have been fixed and tested.
- Phase 2 findings P2-1 through P2-6 fixed in WT-14 commit `8c388e1`.
- ADRs 0002–0011 record architectural and security decisions.
- No GPL/AGPL code bundled into CloudBox binaries (see `THIRD_PARTY_NOTICES.md`).
- All third-party licenses identified and compliance verified (to verify: WireGuard, Wintun exact licenses before Phase 6).
