# Handoff: WT-5 — Plans, subscriptions, entitlement issuance (Slices 3.1, 3.2 cloud side)

**Status:** Ready for review (draft PR against `phase-1/identity`)
**Date:** 2026-09-27
**Branch:** `wt/p3-entitlement` (from `phase-1/identity` @ `7d8a76d`, merged forward to `21efc1a`)

---

## Mission

**Slices:** 3.1 (subscriptions, plans), 3.2 (entitlement format, cloud issuer + reference verifier).

**Success criterion:** a super admin creates a `cloudbox-6` subscription for a tenant, issues a device-bound entitlement (ES256 JWS nested in an RSA-OAEP-256/A256GCM JWE to the device key), renews it (generation strictly increases), revokes it with a typed reason; every write audited, the token never leaves D1 except to the device, and the format is pinned by tests and a test vector the Windows verifier can use.

---

## Current status

- Branch: `wt/p3-entitlement`, parent `phase-1/identity`
- Commits: 4 feature commits + 2 merges of `origin/phase-1/identity` (WT-1 spine, WT-0 biome fix)
- `corepack pnpm run verify`: **green** (see exact results below)
- Real WT-1 middleware on every route; permission-boundary tests live (no `test.todo` left)

---

## Commits ready for merge

```
edf3268 feat(licensing): @cloudbox/licensing-contracts — ES256 JWS nested in RSA-OAEP-256/A256GCM JWE, reference verifier, signing-key generator
e6b7964 feat(subscriptions): plans, subscriptions CRUD, entitlement issue/renew/revoke, subscription screens
2325784 test(subscriptions): real WT-1 sessions; permission boundary per key and role; stub test drops filled modules
5a5aa64 feat(subscriptions-ui): Subscriptions table with expiry pills, detail drawer with entitlement history, Issue/Renew/Revoke dialogs; docs: ADR 0004, key runbook, slice 3.1/3.2 as-built, test vector, evidence
(+ this handoff)
```

---

## Files and contracts changed

- **New package `packages/licensing-contracts`** (`@cloudbox/licensing-contracts`, dependency `jose` 6.2.12 only; dev `typescript`, `vitest` 5.0.2, `@types/node`):
  - `src/entitlement.ts`: `issueEntitlement({claims, serverPrivateJwk, kid, devicePublicJwk})`, `verifyEntitlement({token, devicePrivateJwk, serverPublicJwks})`, `EntitlementError{code}`, `ENTITLEMENT_FORMAT`, `EntitlementClaims` type
  - `src/keys.ts`: `generateServerSigningKey()` (P-256, `kid` = RFC 7638 thumbprint), `parseSigningSecret()`
  - `scripts/generate-signing-key.ts` (owner one-off), `scripts/inspect-entitlement.ts` (demo decrypt), `scripts/make-test-vector.ts`
  - `test/entitlement.test.ts`, `test/vector.test.ts`, `test/vectors/v1.json` (throwaway keys)
  - Source files import each other with `.ts` extensions so the scripts run under Node 24 type stripping; `apps/worker-api/tsconfig.json` gained `allowImportingTsExtensions` + a `paths` entry.
- **worker-api:** `src/entitlement/{service,signing-key,status}.ts`; `src/routes/v1/subscriptions.ts` (three routers), `src/routes/v1/entitlements.ts`, `src/routes/v1/screens/subscriptions.ts` (+ import and one route line in `screens/index.ts`); `test/subscriptions.test.ts`; `test/foundation.test.ts` drops `subscriptions`/`entitlements` from the "still a stub" list.
- **contracts:** `subscriptions.ts` (create status limited to `trial|active`; `UpdateSubscriptionRequest` spelled out, see ISSUE_LOG; `SubscriptionExpiry`, `SubscriptionDevice`, `SubscriptionListItem`, `SubscriptionsScreen`); `entitlement.ts` (`EntitlementClaims` + `kid`,`jti`,`iat`; `ENTITLEMENT_JOSE.cty`; `EntitlementHistoryItem`, `IssueEntitlementRequest/Response`, `RevokeEntitlementRequest/Response`, `SubscriptionDetailScreen`).
- **admin-web:** `routes/_app/subscriptions.tsx`, `routes/_app/subscriptions.$id.tsx` (drawer), `api/subscriptions.ts`, `components/subscription-bits.tsx` (pills, native select, key/value table).
- **docs:** `decisions/0004-entitlement-format.md`, `runbooks/licensing-key-rotation.md`, `slices/3.1-subscriptions.md` + `3.2-entitlement-format.md` (as built, .NET calls), `ISSUE_LOG.md` (2 entries), `evidence/wt-p3-entitlement/*`.
- **Configuration:** Wrangler secret `ENTITLEMENT_SIGNING_JWK` (already typed in `env.ts`). No new vars, bindings or tables.

---

## Migrations

- Reserved `0007`: **not used.** Everything fits the foundation schema.

---

## API changes (`/api/v1`)

| Method | Path | Permission | Request | Response | Audit |
|---|---|---|---|---|---|
| GET | `/plans` | subscription.view | — | `{items: Plan[]}` | — |
| GET | `/tenants/:tenantId/subscriptions` | subscription.view | — | `{items: Subscription[]}` / 404 | — |
| POST | `/tenants/:tenantId/subscriptions` | subscription.manage | `CreateSubscriptionRequest` | 201 `{subscription}`; 400 dates/plan; 404 tenant; 409 `subscription_exists` / `tenant_archived` | `SUBSCRIPTION_CHANGED` (created) |
| PATCH | `/subscriptions/:id` | subscription.manage | `UpdateSubscriptionRequest` (≥1 field) | `{subscription}`; 409 `subscription_cancelled` | `SUBSCRIPTION_CHANGED` (updated/cancelled, before/after) |
| GET | `/devices/:deviceId/entitlements` | subscription.view | — | `{items: EntitlementRecord[]}` (never token) | — |
| POST | `/devices/:deviceId/entitlements/issue` | license.issue | `{validUntil?}` | 201 `{entitlement, claims}`; 404; 409 `no_active_subscription` / `device_not_enrolled` / `device_limit_reached` / `generation_conflict`; 422 `device_key_unusable`; 503 `signing_key_unavailable` / `_retired` / `_mismatch` | `LICENSE_ISSUED` (record + claims) |
| POST | `/devices/:deviceId/entitlements/renew` | license.renew | `{validUntil?}` | as issue + 409 `no_entitlement_to_renew` | `LICENSE_RENEWED` |
| POST | `/devices/:deviceId/entitlements/revoke` | license.revoke | `{reason}` (3–500) | `{deviceId, revokedGenerations, revokedAt}`; 409 `no_active_entitlement` | `LICENSE_REVOKED` (reason, generations) |
| GET | `/screens/subscriptions` | subscription.view | — | `SubscriptionsScreen` (1 D1 round trip + auth) | — |
| GET | `/screens/subscriptions/:id` | subscription.view | — | `SubscriptionDetailScreen` (1 D1 round trip + auth) | — |

Rules: "active subscription" = status `trial|active` and `valid_from ≤ now < valid_until`; one non-cancelled subscription per tenant; `cancelled` terminal; entitlement `valid_until` capped at the subscription's; `generation = max+1` per device under `UNIQUE(device_id, generation)`; plan `max_devices` counts other enrolled devices holding a live entitlement on the tenant's open subscription; revoke marks every live generation; expiry/days remaining derived at read time; tenant status never written here.

---

## Security assumptions

- Server-side authorization on every route via WT-1 `requirePermission` (staff role → `role_permissions` rows). Refusals happen before validation and before any handler query (asserted: 0 handler round trips on 403).
- The compact JWE is the confidential artefact: stored in `entitlements.token`, never in responses to the admin UI, never in audit rows, never logged (tests assert the token string is absent from the response body and audit JSON). Claims are not secret and are audited.
- Private signing key only in the Wrangler secret; the public half is written to `signing_keys` by `ensureSigningKey` (idempotent, primary-key arbitrated). A retired or mismatched kid refuses to sign.
- Device key import uses only `kty/n/e` (a stray `d` can never make the issuer import a private key).
- Verifier accepts exactly RSA-OAEP-256/A256GCM/cty JWT outside and ES256/`cbx-entitlement+jwt`/pinned kid inside; anything else is a named `EntitlementError`.
- No `exp`/`nbf` in the token by design (ADR 0004): the agent's trusted-time logic decides validity + grace.
- Known accepted race: two concurrent "create subscription" calls for the same tenant can both pass the one-open-subscription pre-check (staff-only, rare; no partial unique index without a migration). Generation races are closed by the UNIQUE index.

---

## Tests run and results

### `corepack pnpm run verify` (worktree, after merging `origin/phase-1/identity` @ `21efc1a`)

```
$ biome check .                      Checked 115 files. No fixes applied.
$ pnpm typecheck                     licensing-contracts, contracts, worker-api, admin-web: Done
$ pnpm test
  packages/licensing-contracts       Test Files 2 passed (2)   Tests 16 passed (16)
  apps/admin-web                     Test Files 2 passed (2)   Tests 3 passed (3)
  apps/worker-api                    Test Files 7 passed (7)   Tests 124 passed (124)
$ pnpm build                         admin-web ✓ built; worker-api dry-run Total Upload 2924.57 KiB / gzip 497.04 KiB
EXIT 0
```

### Coverage by file

- `packages/licensing-contracts/test/entitlement.test.ts` — 14: key generation/secret parsing; round trip (claims equal, JWE header exact); one-character tamper in each of the 5 JWE segments; encrypt to A / decrypt with B → `decryption_failed`; claims re-encrypted to B → `device_mismatch`; forged signature under a pinned kid → `signature_invalid`; stale kid (pinned → ok, unpinned → `unknown_kid`); HS256 and ES384 inner JWS, RSA-OAEP and A128GCM outer JWE → `unsupported_algorithm`; wrong `typ`; issuer refuses inconsistent kid/iss/jti; malformed token.
- `packages/licensing-contracts/test/vector.test.ts` — 2: committed vector decrypts to `expectedClaims`; other device key fails.
- `apps/worker-api/test/subscriptions.test.ts` — 73 (workerd + D1, real Better Auth sessions via `signInAs`): plans; create with plan defaults + audit; date/plan/tenant/one-open rules; PATCH audit before/after, empty PATCH 400, cancelled terminal; **issuance without an active subscription → 409** (none, expired, suspended, other tenant's); issue stores a JWE that verifies with the device key to the response claims, audit has claims and no token, `signing_keys` row inserted once; **generation strictly increases** 1→2→3 across issue/renew/issue, renew capped at subscription end; revoke needs a typed reason, revokes all live generations, `currentEntitlementForDevice` → null (what WT-3's route serves), re-issue continues at 3; revoked device, unknown device, over-limit device, missing key (503), retired key (503); list and detail screens ≤ 1 + auth round trips, detail never contains `"token"`; **permission boundary per key × role** (anonymous 401 on all 10 routes; super_admin/admin/support/read_only/non-staff against the seed matrix: admin lacks `license.revoke`, support/read_only view only) with 0 handler round trips on 403; cross-site write with a valid session → 403.
- Todo tests: **none**. Cross-worktree test still open: "revoke then `GET /api/v1/agent/entitlement` → 404" end-to-end needs WT-3's route; the helper it must call is tested here.

---

## Demo path

Local (what the evidence shows):

```
1. apps/worker-api/.dev.vars: OTP_DEV_ECHO="1", BETTER_AUTH_SECRET=<random>, ENTITLEMENT_SIGNING_JWK='<output of generate-signing-key.ts>'
2. wrangler d1 migrations apply cloudbox-db --local; wrangler dev (8787); vite (5173)
3. Seed tenants CBX-00001 "Example Org" (+2) and one device per tenant with a locally generated RSA key (SQL; WT-2/WT-3 APIs not merged yet)
4. Sign in as BOOTSTRAP_SUPER_ADMIN_EMAIL (OTP echoed in the wrangler log) → super_admin
5. POST /api/v1/tenants/ten_example-org/subscriptions {planCode:"cloudbox-6", validFrom:today, validUntil:+1y}
6. POST /api/v1/devices/dev_example-01/entitlements/issue → 201, generation 1, entitlements.token is a 5-part JWE
7. node packages/licensing-contracts/scripts/inspect-entitlement.ts device-private.jwk.json server-public.jwk.json < token
   → claims show device_id dev_example-01, max_managed_users 6; another device's key → rejected: decryption_failed
8. Subscriptions → Example Org → Renew (g2, g3) → Revoke with typed reason → history shows all revoked; audit log shows
   SUBSCRIPTION_CHANGED, LICENSE_ISSUED, LICENSE_RENEWED, LICENSE_REVOKED
```

Target demo once WT-2/WT-3 merge: Tenants → Example Org → Subscriptions → create `cloudbox-6` for 1 year → Subscriptions detail (or Fleet → device → License tab, if WT-3 links it) → Issue → `curl -H "Authorization: Bearer <deviceToken>" /api/v1/agent/entitlement` returns `{entitlement:<JWE>, generation:1}` → decrypt as in step 7 → Revoke → the same curl answers 404.

Evidence: `docs/evidence/wt-p3-entitlement/01-subscriptions-list.png`, `02-new-subscription-dialog.png`, `03-detail-example-org.png`, `04-renew-dialog.png`, `05-after-renew.png`, `06-revoke-dialog.png`, `07-after-revoke-history.png`, `08-audit-log.png`, `09-list-after-revoke.png`, `decrypt-demo.txt`.

---

## One-off key generation (owner)

```bash
node packages/licensing-contracts/scripts/generate-signing-key.ts \
  | gh secret set ENTITLEMENT_SIGNING_JWK --env production --repo Affinity-Minds/cloudbox
```

stdout (the private JWK) goes only into the pipe; the script refuses a terminal. stderr prints the `kid` and public JWK for the key register in `docs/runbooks/licensing-key-rotation.md`. The public half needs no manual step: the Worker inserts it into `signing_keys` on first issuance. Until the deploy workflow copies the secret into Wrangler (request below), production issuance answers `503 signing_key_unavailable` and the detail drawer shows a banner.

---

## What WT-3's `GET /api/v1/agent/entitlement` must return

- Auth: device Bearer token (ADR 0005) → `c.var.device.id`.
- Call `currentEntitlementForDevice(db, deviceId)` from `apps/worker-api/src/entitlement/service.ts`: the **highest generation** for the device; `null` when there is none **or the highest one is revoked** (never fall back to an older generation).
- `null` → `404 {"error":"not_found"}`. Otherwise `200 {"entitlement": "<compact JWE>", "generation": <int>}` (`AgentEntitlementResponse` in contracts). Do not log the token; set `Cache-Control: no-store`.
- Heartbeat `entitlementGeneration`: the same helper's `generation`, or null.
- A device whose status is not `enrolled` should already be refused by the bearer middleware.
- Agents also need the pinned server public key(s): either ship them in the agent build (WT-4) or expose `GET /api/v1/agent/signing-keys` returning `signing_keys` rows with `status='active'` plus retired ones still in their overlap window (public JWKs only). Decision below.

---

## Known failures

- [ ] Production `ENTITLEMENT_SIGNING_JWK` not provisioned (owner step + WT-0 workflow step).
- [ ] End-to-end "revoke → agent 404" awaits WT-3's route.
- [ ] Demo seeded tenants/devices via SQL (their APIs are WT-2/WT-3); subscriptions/entitlements via the WT-5 API.

---

## Deviations from the brief

- `packages/licensing-contracts` is a new workspace package, which required editing `apps/worker-api/package.json` (workspace dependency) and `pnpm-lock.yaml` (importer entries only; no new third-party package versions) — both normally WT-0-only; instructed by the orchestrator.
- JWE `cty` is `"JWT"` (orchestrator instruction; RFC 7519 §5.2 recommends uppercase); the verifier compares case-insensitively.
- `kid` also appears as a claim, and `jti` = `license_id` (brief asked for `kid`/`jti`; the contract comment said kid only in the header; updated).
- Revoke revokes every live generation of the device, not one row, so the agent can never fall back to an older lease.
- Plan `max_devices` enforced at issuance (not explicit in the brief; §9.1 "Devices: 1").
- The issue/renew/revoke actions live in the Subscriptions detail drawer rather than a Fleet "License" tab (Fleet detail is WT-3's file).
- `SUBSCRIPTION_CHANGED` carries `action` created/updated/cancelled instead of three event types (slice doc listed `SUBSCRIPTION_CREATED/UPDATED/CANCELLED`).
- `test/foundation.test.ts` (WT-0) edited to drop the two modules that are no longer stubs.
- Admin forms use controlled state instead of react-hook-form (small forms, no shared schema benefit).

---

## Decisions needed

- [ ] Owner: run the one-off key command (above) once the workflow step exists.
- [ ] WT-3/WT-4: pinned server keys — baked into the agent build (safer, needs a rebuild per rotation) or fetched from a public `GET /agent/signing-keys` and pinned on first use? ADR 0004 assumes baked + additive rotation.
- [ ] Whether cancelling/suspending a subscription should auto-revoke its devices' entitlements (today: no; revocation is explicit, leases lapse at `valid_until` + grace).

---

## Requests to another worktree

- [ ] **WT-0:** deploy-workflow step to copy GitHub environment secret `ENTITLEMENT_SIGNING_JWK` into Wrangler when set (snippet in the runbook, "Wiring the secret"); `docs/BUILD_STATE.md` open item can then close.
- [ ] **WT-3:** implement `GET /agent/entitlement` exactly as above using `currentEntitlementForDevice`; add the end-to-end revoke → 404 test; optionally link the Fleet device License tab to `/subscriptions/$id` or reuse `GET /devices/:deviceId/entitlements`.
- [ ] **WT-4 / WT-10:** implement the .NET verifier per `docs/slices/3.2-entitlement-format.md`; acceptance = `packages/licensing-contracts/test/vectors/v1.json`; confirm RSA-OAEP-256 + A256GCM support in Microsoft.IdentityModel on `windows-latest`, else use `jose-jwt` for the decrypt step only.
- [ ] **WT-2:** tenant detail can show the subscription by reading `GET /tenants/:tenantId/subscriptions`; tenant status must stay independent of subscription state (derived at read time).
- [ ] **WT-8:** review ADR 0004 and `apps/worker-api/src/entitlement/*`.

---

## Safe next action

Review and merge this draft into `phase-1/identity` after WT-3's agent route lands (or before: nothing here depends on WT-3), then have WT-0 add the secret-sync step and the owner run the one-off key command before the first production issuance.
