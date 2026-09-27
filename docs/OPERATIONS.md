# CloudBox Operations

This document describes the routine operational procedures for CloudBox staff.

## Deploy pipeline

The production deploy is triggered on every push to `main` branch via GitHub Actions.

**Workflow file:** `.github/workflows/deploy-cloudflare.yml`

**Steps:**
1. **Checkout and setup** — Clone repository, install pnpm and Node.js 22.
2. **Frozen lockfile install** — `pnpm install --frozen-lockfile` (no semver ranges at deploy time).
3. **Verify** — `pnpm run verify` (runs tests and builds all packages).
4. **Stamp build** — Inject commit SHA and timestamp into `wrangler.jsonc`.
5. **Deploy to Cloudflare** — `wrangler deploy` (worker code, D1 migrations, R2 bindings).
6. **Publish admin web** — Upload compiled React app to R2 (served from CDN).
7. **Validate** — Health check on `https://box.affinity.ai.in/api/health`.
8. **Cleanup** — Delete temporary build artifacts and secrets.

**Deployment is atomic:** The entire job runs in a single GitHub Environments deployment; rollback is a revert commit + re-push to main.

**Secrets isolation:** Cloudflare API token and account ID are scoped to the deploy steps only; they are not available during install or verify, reducing blast radius of build-time code execution.

**Pre-deploy checks:**
- CI must pass all tests.
- No uncommitted code on main.
- All migrations must be in `apps/worker-api/src/migrations/*.sql`.

## Staff management

### Adding a staff member

**Endpoint:** `POST /api/ops/staff`

**Request:**
```json
{
  "email": "alice@example.com",
  "role": "admin"
}
```

**Process:**
1. Staff issues request (requires `super_admin` role).
2. Cloud creates `staff_users` row with email and random ID.
3. Cloud creates `staff_members` row with `role` and `mustChangePassword=true`.
4. Cloud sends "set password" email with a link to `/login`.
5. On first login, Alice enters a password (any sufficiently long string).
6. Cloud sets `mustChangePassword=false`.
7. If 2FA is enabled for her role, Alice is prompted to set up TOTP on first login.

**Response:** `{userId, email, role, mustChangePassword}`

**Audit:** Event `STAFF_MEMBER_ADDED` with actor=super_admin, entity=staff_member, action=add.

### Revoking a staff member

**Endpoint:** `DELETE /api/ops/staff/{userId}`

**Process:**
1. Staff issues request (requires `super_admin` role).
2. Cloud checks if this is the last super_admin (race-free conditional DELETE).
3. If yes, returns 409 `last_super_admin_cannot_be_deleted`.
4. If no, deletes the staff_members row; staff_users row is orphaned but kept (for audit trail).
5. Existing sessions are not revoked automatically; they expire naturally.

**Audit:** Event `STAFF_MEMBER_REVOKED` with actor=super_admin, entity=staff_member, action=revoke.

### Changing staff roles

**Endpoint:** `PATCH /api/ops/staff/{userId}`

**Request:**
```json
{
  "role": "support"
}
```

**Process:**
1. Staff issues request (requires `super_admin` role).
2. Cloud checks if this is a demotion of the last super_admin.
3. If yes, returns 409 `last_super_admin_cannot_be_demoted`.
4. If no, updates `staff_members.role`.

**Audit:** Event `STAFF_MEMBER_UPDATED` with actor=super_admin, entity=staff_member, action=update, beforeJson (old role), afterJson (new role).

## License key management

### Generating license keys

**Endpoint:** `POST /api/ops/licenses/generate`

**Request:**
```json
{
  "planCode": "cloudbox-6",
  "quantity": 100,
  "batchLabel": "Q4 2026 batch 1",
  "expiresAt": "2027-12-31T23:59:59Z"
}
```

**Response:**
```json
{
  "batchId": "batch-uuid",
  "keys": [
    "CLOUDBOX-A1B2-C3D4-E5F6",
    "CLOUDBOX-A1B2-C3D4-E5F7",
    ...
  ],
  "count": 100
}
```

**Process:**
1. Staff issues request (requires `staff:license:generate` permission).
2. Cloud validates `planCode` exists and is active.
3. Cloud generates N random keys (format: `CLOUDBOX-XXXX-XXXX-XXXX`).
4. Cloud stores hashes (SHA-256) and last-4 in `license_keys` table, status=unredeemed.
5. Cloud returns plaintext keys only in this response (never stored in database).
6. Plaintext keys should be copied to a secure distribution channel (e.g., encrypted email, secure sheet).

**Audit:** Event `LICENSE_BATCH_GENERATED` with actor=staff_user, entity=license_batch, action=generate, count=N.

### Searching license keys

**Endpoint:** `GET /api/ops/licenses?last4=E5F6&status=unredeemed`

**Process:**
1. Staff issues request (requires `staff:license:read` permission).
2. Cloud returns paginated list of keys matching the search.
3. Keys are returned with: `last4`, `planCode`, `batchLabel`, `status`, `createdAt`, `expiresAt`, `redeemedAt` (if redeemed), `redeemedTenantId`, `redeemedByEmail`.
4. Plaintext key codes are never returned in responses.

### Revoking license keys

**Endpoint:** `POST /api/ops/licenses/{keyId}/revoke`

**Request:**
```json
{
  "reason": "issued in error, customer requested cancellation"
}
```

**Process:**
1. Staff issues request (requires `staff:license:revoke` permission).
2. Cloud sets `status=revoked`, `revokedAt=now()`, `revokeReason=reason`.
3. If the key was already redeemed, the customer's subscription is NOT affected (revocation does not retroactively invalidate keys).

**Audit:** Event `LICENSE_KEY_REVOKED` with actor=staff_user, entity=license_key, action=revoke.

### Batch price freezing (to verify)

Per `docs/OPEN_QUESTIONS.md`, pricing of add-on users can vary by batch. Implementation approach: to verify whether batch-level pricing is captured or only plan-level pricing is used. Link: see license-keys and entitlement format decisions in handoff and ADRs.

## Plan management

### Creating a plan

**Endpoint:** `POST /api/ops/plans`

**Request:**
```json
{
  "code": "cloudbox-6",
  "name": "CloudBox 6",
  "description": "Up to 6 devices",
  "maxDevices": 6,
  "maxManagedUsers": 10,
  "features": ["remote-access", "backup", "updates"],
  "offlineGraceDays": 14,
  "renewalWarningDays": 30,
  "termDays": 365,
  "priceAmount": 500000,
  "currency": "INR",
  "addonUserPriceAmount": 10000,
  "maxAddonUsers": 5
}
```

**Process:**
1. Staff issues request (requires `staff:plan:create` permission).
2. Cloud creates `plans` row with status=active.
3. Prices are in minor units (e.g., paise for INR, cents for USD).

**Audit:** Event `PLAN_CREATED` with actor=staff_user, entity=plan, action=create.

### Retiring a plan

**Endpoint:** `PATCH /api/ops/plans/{planCode}`

**Request:**
```json
{
  "status": "retired"
}
```

**Process:**
1. Staff issues request (requires `staff:plan:update` permission).
2. Cloud sets `status=retired`.
3. Existing subscriptions on this plan remain active; new subscriptions cannot be created on retired plans.

## Tenant management

### Viewing a tenant

**Endpoint:** `GET /api/ops/tenants/{tenantId}`

**Response:**
```json
{
  "id": "tenant-uuid",
  "publicCode": "CBX-00001",
  "displayName": "Acme Corp",
  "legalName": "Acme Corporation Inc.",
  "status": "active",
  "primaryContactEmail": "alice@acme.com",
  "supportContactEmail": "support@acme.com",
  "billingContactEmail": "billing@acme.com",
  "timezone": "UTC",
  "subscriptionStatus": "active",
  "subscriptionPlanCode": "cloudbox-6",
  "subscriptionMaxDevices": 6,
  "enrolledDevices": 2,
  "createdAt": "2026-01-15T10:00:00Z"
}
```

### Assigning a plan to a tenant

**Endpoint:** `POST /api/ops/tenants/{tenantId}/subscriptions`

**Request:**
```json
{
  "planCode": "cloudbox-6"
}
```

**Process:**
1. Staff issues request (requires `staff:tenant:update` permission).
2. Cloud creates `subscriptions` row with status=pending (no dates yet).
3. Dates are filled in when the first device enrolls and activates.

**Audit:** Event `SUBSCRIPTION_CREATED` with actor=staff_user, entity=subscription, status=pending.

### Revoking a device

**Endpoint:** `DELETE /api/ops/devices/{deviceId}`

**Process:**
1. Staff issues request (requires `staff:device:revoke` permission).
2. Cloud sets device status=revoked, revokedAt=now().
3. Cloud revokes all live entitlements for this device (sets revokedAt).
4. On next heartbeat, device detects revocation and stops accepting work.
5. Admin can re-enroll the device by issuing a new enrollment token.

**Audit:** Event `DEVICE_REVOKED` with actor=staff_user, entity=device, action=revoke.

## Reading the audit log

### Endpoint

`GET /api/ops/audit-log?entity_type=device&entity_id=dev-123&limit=50&after=cursor`

### Response

```json
{
  "events": [
    {
      "id": "event-uuid",
      "eventType": "DEVICE_ENROLLED",
      "entityType": "device",
      "entityId": "dev-123",
      "actorType": "customer_user",
      "actorId": "customer-uuid",
      "action": "enroll",
      "beforeJson": null,
      "afterJson": {
        "id": "dev-123",
        "tenantId": "tenant-uuid",
        "status": "enrolled",
        "hostname": "OFFICE-PC-01",
        "enrolledAt": "2026-09-20T10:00:00Z"
      },
      "createdAt": "2026-09-20T10:00:00Z",
      "actorTenantId": "tenant-uuid",
      "correlationId": "req-abc123",
      "source": "api"
    },
    ...
  ],
  "nextCursor": "after=2026-09-20T09:00:00Z",
  "hasMore": true
}
```

### Queries

**By device:**
```
GET /api/ops/audit-log?entity_type=device&entity_id=dev-123
```

**By tenant:**
```
GET /api/ops/audit-log?actor_tenant_id=tenant-uuid
```

**By staff user (who made the change):**
```
GET /api/ops/audit-log?actor_type=staff_user&actor_id=staff-uuid
```

**By event type:**
```
GET /api/ops/audit-log?event_type=LICENSE_KEY_REDEEMED
```

**Time range:**
```
GET /api/ops/audit-log?created_after=2026-01-01T00:00:00Z&created_before=2026-01-31T23:59:59Z
```

All queries are paginated (limit max 100, default 50) and sorted newest-first.

## Key rotation (licensing)

**Runbook:** `docs/runbooks/licensing-key-rotation.md`

**Schedule:** Quarterly (before each major release or when Cloudflare API token expires).

**Process:**
1. Generate new Cloudflare API token with scoped permissions (Workers, D1, R2 only).
2. Update GitHub repository secret `CLOUDFLARE_API_TOKEN`.
3. Trigger a manual deploy (`workflow_dispatch`) to test new token.
4. Delete old token from Cloudflare console.
5. Document rotation in `docs/ISSUE_LOG.md`.

## Troubleshooting

### Tenant cannot sign in

**Audit log query:**
```
GET /api/ops/audit-log?entity_type=customer_user&entity_id={userId}&event_type=AUTH_LOGIN_FAILED
```

**Common causes:**
- Email not verified (no customer user row created).
- Too many failed OTP attempts (rate-limited for 15 minutes).
- Outdated session (expired after 30 days).
- Session revoked by admin.

**Fix:** Issue a new OTP code; if still failing, check rate-limit state in `customer_rate_limit` table.

### Device not heartbeating

**Audit log queries:**
```
GET /api/ops/audit-log?entity_type=device&entity_id={deviceId}
GET /api/ops/audit-log?event_type=ENTITLEMENT_ISSUED&entity_id={deviceId}
```

**Common causes:**
- Device revoked (status=revoked).
- No live entitlement (expired or revoked).
- Network connectivity issue (check Windows event log on device).
- Outdated device credentials (ask device to re-authenticate).

**Fix:** Check entitlement validity with `GET /api/v1/devices/{deviceId}/entitlements`. If expired, trigger new issuance by admin heartbeat request or device reboot.

### High audit log volume

**Mitigation:** Audit log is append-only and never deleted. Storage is managed by D1 backup and retention policies. Monitor D1 usage in Cloudflare dashboard.

**Queries to identify noise:**
```
GET /api/ops/audit-log?event_type=DEVICE_HEARTBEAT (use a time window)
GET /api/ops/audit-log?actor_id={systemServiceId} (identify background jobs)
```

## Related documents

- **Architecture:** `docs/ARCHITECTURE.md`
- **Security:** `docs/SECURITY.md`
- **Runbooks:** `docs/runbooks/` directory
  - Device enrollment: `docs/runbooks/enrollment.md`
  - License key rotation: `docs/runbooks/licensing-key-rotation.md`
  - Email provider setup: `docs/runbooks/email-providers.md`
  - Server setup lab: `docs/runbooks/server-setup-lab.md`
- **ADRs:** `docs/decisions/` directory (especially ADR 0002–0011 for architectural decisions)
- **Issue log:** `docs/ISSUE_LOG.md`
- **Deployment:** `.github/workflows/deploy-cloudflare.yml`
