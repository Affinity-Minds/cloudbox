# Handoff: WT-3 — Enrollment tokens, device registry, Agent API, Fleet (Slice 2.3 cloud side + 7.3-lite)

**Status:** Ready for review (draft PR against `phase-1/identity`)
**Date:** 2026-09-27
**Branch:** `wt/p2-enrollment` (from `phase-1/identity` @ `7d8a76d`, merged forward to `21efc1a` (WT-1 auth spine) and `55dd451` (WT-5 subscriptions/entitlement))

---

## Mission

**Slices:** 2.3 (enrollment + device registry + Agent API), 7.3-lite (Fleet operational table + detail).

**Success criterion:** a staff user issues a single-use enrollment token for a tenant; a Windows agent (simulated here with `curl` + a generated RSA key) redeems it exactly once to become a `devices` row with a Bearer credential; the device heartbeats and reports its health, entitlement generation and agent version; staff can see it Online in Fleet with a filterable table, drill into Overview/License/Health/Audit tabs, and revoke it; every consequential change is audited and permission-gated.

---

## Current status

- Branch: `wt/p2-enrollment`, parent `phase-1/identity`
- Commits: 2 feature commits + 1 merge commit (a second and third sync were fast-forwards, so they don't appear as separate commits) since fork
- `corepack pnpm run verify`: **green** (check, typecheck, test — 176 tests across the workspace — build, deploy dry-run)
- Real WT-1 middleware (`requirePermission`, `requireTenantStanding`, `guard`) on every staff route; WT-5's `currentEntitlementForDevice` is the single source the Agent API and Fleet read through, not a duplicated query

---

## Commits ready for merge

```
ce6c18a wip(wt-3): enrollment tokens, agent API, fleet screens, requireDevice (in progress)
3bf1313 merge: pick up WT-5 subscriptions/entitlement issuance from phase-1/identity
ad7b51c feat(wt-3): enrollment tokens, agent enroll/heartbeat/entitlement/uninstalled, fleet screens, requireDevice
9b24117 feat(wt-3): Enrollment and Fleet admin-web pages
(+ this handoff)
```

Two earlier syncs (`origin/phase-1/identity` picking up WT-1's `requirePermission`/`requireTenantStanding`/`guard` implementation, then a Biome worktree fix) landed as fast-forwards before any local commit existed, so they carry no separate commit object on this branch.

---

## Files and contracts changed

- **worker-api:**
  - `src/crypto.ts` (new): `randomCrockfordBase32`, `randomOpaqueToken`, `sha256Hex`, `describeError`/`isUniqueConstraintError` (D1's nested-`cause` unwrap, agent-notes #7).
  - `src/devices/` (new): `require-device.ts` (`requireDevice()`, `resolveDevice()`, `bearerToken()`), `naming.ts` (`nextDeviceName()` — `CLOUDBOX-00001` sequence via the `settings` table, same pattern as `tenants.next_code`), `enroll-rate-limit.ts` (fixed-window per-IP counter, `settings`-backed; documented upgrade to a Durable Object).
  - `src/routes/v1/enrollment.ts`: `createEnrollmentToken`/`listEnrollmentTokens`/`revokeEnrollmentToken` (exported, unit-tested directly) + the Hono routes, gated by a single composed `guard()` check (`device.manage` OR tenant standing `admin`+ on `:tenantId`).
  - `src/routes/v1/devices.ts`: `revokeDevice` + `POST /:deviceId/revoke`, gated `device.manage`.
  - `src/routes/v1/agent.ts`: `enrollDevice`, `recordHeartbeat`, `uninstallDevice` (exported) + the four routes.
  - `src/routes/v1/screens/fleet.ts` (new): `loadFleet`, `loadFleetDetail`, `resolveFleetAccess` + `GET /` and `GET /:deviceId`; one line added to `screens/index.ts`.
  - `test/`: `enrollment.test.ts`, `agent.test.ts`, `devices.test.ts`, `screens-fleet.test.ts`, `wt3-fixtures.ts` (local `insertTenant`/`insertMembership` stand-ins — `seedTenant`/`seedMembership` in `test/fixtures.ts` are still WT-6 `pending()`); `foundation.test.ts` drops `enrollment`/`devices`/`agent` from the "still a stub" list.
- **contracts (`packages/contracts/src/devices.ts`):** `FleetListItem` gained `windowsBuild` and `licenseState` (derived); added `LicenseState`, `FleetFacets`, `FleetTenantOption`, `FleetScreen`, `FleetDeviceDetail`, `FleetEntitlementRow` (now carries `subscriptionId`, for the License-tab link), `FleetDetailScreen`. All additive — nothing the Agent API (`agent.ts`) or WT-4 depends on changed.
- **admin-web:**
  - `api/devices.ts` (new): `fleetQuery`, `fleetDetailQuery`, `revokeDevice`, `enrollmentTokensQuery`, `createEnrollmentToken`, `revokeEnrollmentToken`.
  - `components/device-bits.tsx` (new): `OnlinePill`, `KeyProtectionPill`, `LicenseStatePill`.
  - `routes/_app/fleet.tsx`, `routes/_app/fleet.$deviceId.tsx`, `routes/_app/enrollment.tsx` (filled in; were `NotBuilt` placeholders).
  - `lib/time.ts`: `formatAgo` fix (see Issue log below) — every existing caller's output is unchanged.
- **docs:** `ISSUE_LOG.md` (+2 entries), `evidence/wt-p2-enrollment/*`, this handoff.
- **Configuration:** none. No new bindings, vars, secrets, dependencies, or migration (reserved `0006` — **not used**; the existing schema already had every column needed).

---

## Migrations

- Reserved `0006`: **not used.** `enrollment_tokens`, `devices`, `device_credentials` already had every column this slice needed.

---

## API changes (`/api/v1`)

| Method | Path | Auth | Request | Response | Audit |
|---|---|---|---|---|---|
| POST | `/tenants/:tenantId/enrollment-tokens` | `device.manage` OR tenant standing `admin`+ | `{label, expiresInHours≤168}` | 201 `{...EnrollmentToken, token}` (shown once) | `ENROLLMENT_TOKEN_CREATED` |
| GET | `/tenants/:tenantId/enrollment-tokens` | same | — | `EnrollmentToken[]` (no `token` field) | — |
| DELETE | `/tenants/:tenantId/enrollment-tokens/:id` | same | — | 204; 404 unknown; 409 `already_redeemed` | `ENROLLMENT_TOKEN_REVOKED` |
| POST | `/agent/enroll` | none (token-gated, per-IP rate-limited) | `EnrollRequest` | 201 `EnrollResponse`; 400 `invalid_request` / `invalid_enrollment_token` (unknown, expired, redeemed, revoked — same message); 409 `device_already_enrolled`; 429 `rate_limited` | `DEVICE_ENROLLED` (actor `device`) |
| POST | `/agent/heartbeat` | Bearer device token | `{health: AgentHealth}` | 200 `{serverTime, entitlementGeneration, commands: []}`; 401 | — |
| GET | `/agent/entitlement` | Bearer device token | — | 200 `{entitlement, generation}` (`Cache-Control: no-store`); 404 `not_found`; 401 | — |
| POST | `/agent/uninstalled` | Bearer device token (tolerates an already-revoked one) | — | 204, idempotent | `DEVICE_UNINSTALLED` (actor `device`) |
| GET | `/devices/:deviceId/revoke` → POST | `device.manage` | — | 204; 404 | `DEVICE_REVOKED` |
| GET | `/screens/fleet?tenant=&online=&q=` | signed-in (staff `device.view` sees every tenant; a tenant member with no staff grant is restricted to their own) | — | `FleetScreen` (≤2 D1 round trips) | — |
| GET | `/screens/fleet/:deviceId` | same | — | `FleetDetailScreen` (≤3 D1 round trips); 403 cross-tenant; 404 | — |

---

## Security assumptions

- **Enrollment tokens:** `CBX-ENROLL-XXXX-XXXX`, 8 Crockford base32 symbols (40 bits) from `crypto.getRandomValues`, byte `& 0x1f` indexing (32-symbol alphabet, zero modulo bias). Only the SHA-256 hash is stored; the plaintext is returned once, at creation, and never again (the GET list omits it; verified by a test asserting the field is absent).
- **Device credentials:** opaque 32-byte hex tokens, same hash-only-at-rest treatment. `requireDevice()` 401s a revoked credential or a non-`enrolled` device; `POST /agent/uninstalled` is the one deliberate exception — it resolves a *revoked* credential too (still requires the real, once-issued token; never a forgery) so a retried uninstall call is idempotently 204, not 401.
- **Redemption race:** the conditional `UPDATE … WHERE redeemed_at IS NULL AND revoked_at IS NULL RETURNING id` runs alone and is checked before the device/credential insert batch (agent-notes cloudflare-workers "a transaction cannot be made conditional on one row changed" — `db.batch` still commits even if that WHERE matches zero rows). A duplicate device-key insert failure inside the batch triggers a compensating un-redeem so a genuine retry with a fresh key can still use the token; verified by a test that the second token is redeemable after a 409.
- **Fleet tenant scoping:** `requireTenantStanding()` reads `:tenantId` from the path, and `/screens/fleet` has none (it's a `?tenant=` query filter), so this route resolves access by hand: staff holding `device.view` see every tenant; a signed-in user with no staff grant is looked up in `tenant_memberships` and restricted to exactly those tenant ids, with a 403 on an explicit `?tenant=` outside that set. The embedded tenant picker (`FleetScreen.tenants`) is scoped the same way — a tenant member never sees another tenant's name or code, even in the picker.
- **Contract extension:** `FleetListItem`/`FleetScreen`/`FleetDetailScreen` gained fields (`windowsBuild`, `licenseState`, embedded `tenants`, `subscriptionId` on entitlement rows) — additive only, and none of it is in `agent.ts`, so WT-4's Windows agent is unaffected. Noted per the brief's "if you must change a field, request WT-0 and tell WT-4" — no request needed since nothing WT-4 reads changed.

---

## Tests run and results

### `corepack pnpm run verify`

```
$ biome check .                      Checked 128 files. No fixes applied.
$ pnpm typecheck                     contracts, licensing-contracts, worker-api, admin-web: Done
$ pnpm test
  packages/licensing-contracts       Test Files 2 passed (2)    Tests 16 passed (16)
  apps/admin-web                     Test Files 2 passed (2)    Tests 3 passed (3)
  apps/worker-api                    Test Files 11 passed (11)  Tests 157 passed (157)
$ pnpm build                         admin-web ✓ built; worker-api dry-run Total Upload 2950.31 KiB / gzip 502.06 KiB
EXIT 0
```

### Coverage by file (`apps/worker-api/test/`)

- **`enrollment.test.ts`** — plaintext format + hash-only storage (token string absent from the stored row's JSON); tenant isolation on list; revoke unredeemed → `already_revoked` → `not_found` for the wrong tenant; revoke a redeemed token → `already_redeemed`; HTTP layer: 401 anonymous, 403 neither `device.manage` nor tenant standing, 201 for staff, **201 for a non-staff tenant member with standing `admin` on their own tenant and 403 on another tenant** (exercises the composed `guard()` gate end to end), GET/DELETE round trip.
- **`agent.test.ts`** — enroll happy path (`deviceName` matches `CLOUDBOX-\d{5}`, `deviceToken` is 64 hex chars); invalid body; unknown/expired/revoked token all answer the same `invalid_enrollment_token`; **redeemed token cannot be redeemed twice**; **duplicate device key → 409, and the second token is handed back for a fresh-key retry**; per-IP rate limit (11 calls → 429); heartbeat accepts every nullable `AgentHealth` field and stores the document verbatim, wrong/missing Bearer → 401; heartbeat's `entitlementGeneration` and `GET /agent/entitlement` both go through WT-5's real issuance HTTP routes end-to-end (**issue → GET returns the token and `Cache-Control: no-store`; revoke → GET 404s again** — the cross-worktree test WT-5 left for me); uninstalled revokes device + credentials, audits `DEVICE_UNINSTALLED`, **is idempotent on a retried call with the same now-revoked token**, and 401s a token that was never issued.
- **`devices.test.ts`** — `revokeDevice` unit tests (revoked → already_revoked → not_found) and the HTTP layer (401/403/204/404, audit row present).
- **`screens-fleet.test.ts`** — 401/403 boundary; a device is Offline until it heartbeats then Online (through the real enroll+heartbeat HTTP path); **loader round trips ≤ 3 beyond auth** (measured the same way `screens.test.ts` does); **a tenant-standing (non-staff) caller is restricted to their own tenant, 403s an explicit cross-tenant `?tenant=`, and never sees the other tenant's name in the embedded picker**; detail 404/403/200 including the license/audit tab data.

Todo tests: **none.**

---

## Demo path

Local (what the evidence shows):

```
1. apps/worker-api/.dev.vars: OTP_DEV_ECHO="1", BETTER_AUTH_SECRET=<random>,
   ENTITLEMENT_SIGNING_JWK=<output of packages/licensing-contracts/scripts/generate-signing-key.ts>,
   PHASE0_ADMIN_KEY=<random>, BOOTSTRAP_SUPER_ADMIN_EMAIL=demo@cloudbox.test
2. wrangler d1 migrations apply cloudbox-db --local
3. Seed one tenant directly (SQL insert — WT-2's tenant-creation API is still a stub):
   CBX-00001 "Example Org"
4. wrangler dev --port 8787 (worker-api); vite --port 5173 (admin-web, proxies /api → 8787)
5. Sign in as demo@cloudbox.test (OTP echoed in the wrangler log) → bootstrapped super_admin
6. Enrollment → Example Org → New token → "Front desk PC" → code shown once,
   CBX-ENROLL-61MG-WDFR, copy button, "expires in 24 hours"
7. curl -X POST /api/v1/agent/enroll -d '{"token":"CBX-ENROLL-61MG-WDFR","device":{"hostname":"front-desk-01",
   "windowsBuild":"10.0.26100.4202","agentVersion":"0.1.0","keyProtection":"software",
   "publicKeyJwk":<RSA JWK generated with jose's generateKeyPair("RS256")>}}'
   → 201 {deviceId, tenantId, tenantCode:"CBX-00001", deviceName:"CLOUDBOX-00001", deviceToken}
8. Fleet → CLOUDBOX-00001 shows Offline, Degraded key (software), Windows build, agent 0.1.0, No license
9. curl -X POST /api/v1/agent/heartbeat -H "Authorization: Bearer <deviceToken>" -d '{"health":{...}}'
   → 200 {serverTime, entitlementGeneration: null, commands: []}
10. Fleet → CLOUDBOX-00001 now shows Online; detail drawer → Health tab shows the document,
    with every field the agent didn't report rendered "unknown" (never 0 or Offline)
11. Replay step 7 with the SAME token → 400 {"error":"invalid_enrollment_token"}
12. curl /api/v1/agent/entitlement with a garbage Bearer token → 401
```

Evidence: `docs/evidence/wt-p2-enrollment/01-overview-signed-in.png`, `02-fleet-empty.png`,
`03-enrollment-code-shown-once.png`, `04-enrollment-list-active-token.png`,
`05-fleet-device-offline.png`, `06-fleet-detail-overview.png`, `07-fleet-detail-health-offline.png`,
`08-fleet-device-online.png`, `09-fleet-detail-health-online.png`, `10-fleet-detail-audit.png`.

---

## Known failures

- None outstanding.

---

## Deviations from the brief

- **Token TTL field:** the brief text said `ttlMinutes≤1440`; the *fixed* contract (`packages/contracts/src/enrollment.ts`, foundation-owned) is `expiresInHours` (int, 1–168). Implemented against the actual contract, which is the source of truth per `docs/handoffs/foundation.md`.
- **Enroll's atomic batch:** the brief says "in one `db.batch`: insert devices, insert device_credentials, mark token redeemed." Following agent-notes' stronger rule ("a transaction cannot be made conditional on one row changed"), the conditional claim (`redeemed_at`) runs alone and is checked first; `redeemed_device_id` (FK to the not-yet-existing device) is set inside the batch, after the device insert. Functionally equivalent, safe under concurrency, and required — the literal ordering hits a foreign-key error (see Issue log).
- **`/screens/fleet` gate:** left ungated by `requirePermission()` like WT-0's own `overview`/`audit` screens were before WT-1 landed, but resolved by hand from `getPrincipal()` + `tenant_memberships` (see Security assumptions) because `requireTenantStanding()` structurally can't gate a route with no `:tenantId` path segment. `/tenants/:tenantId/enrollment-tokens` and `/devices/:deviceId/revoke` use the real fixed gates directly.
- **FleetListItem/FleetScreen/FleetDetailScreen contract fields**: extended beyond the foundation's original shape (`windowsBuild`, `licenseState`, embedded `tenants`, `subscriptionId`) — additive only, doesn't touch anything WT-4 reads; noted rather than requested since the brief's carve-out was specifically about the Agent API.
- **License tab:** links to the Subscriptions detail drawer for Issue/Renew/Revoke rather than duplicating those actions in Fleet (WT-5's handoff explicitly asked for this).
- **Rate limiting:** a `settings`-table fixed-window counter per IP, as the brief calls acceptable "tonight" — documented in `src/devices/enroll-rate-limit.ts` as not safe against a burst racing across isolates; the honest upgrade is a Durable Object.
- **Cross-cutting fixes (not otherwise in scope, but blocking this slice's evidence):**
  - `apps/admin-web/src/lib/time.ts`'s `formatAgo` always appended `" ago"`, including for a future timestamp (an enrollment token's expiry — the first future-dated field any page has shown). Fixed with `addSuffix: true`; every existing caller's output is unchanged (see Issue log).

---

## Decisions needed

- None blocking. Optional: whether a future customer-facing portal (not built here — admin-web is staff-only) should reuse `/screens/fleet`'s tenant-standing path, or whether that access model should eventually move to a separate host per `design/ux-patterns.md` "Two audiences, two front doors".

---

## Requests to another worktree

- [ ] **WT-2:** once `GET /api/v1/tenants` exists, the Fleet and Enrollment pages' embedded tenant picker (`FleetScreen.tenants`) can be replaced by a real tenants list/picker component; not blocking.
- [ ] **WT-4:** the Agent API you're building against is unchanged in shape; `AgentHealth`'s nullable fields (merged from `origin/phase-1/identity`) mean `null` for "cannot determine yet" and the literal string `"unknown"` for an unknown *state* — the Fleet Health tab renders exactly that convention.
- [ ] **WT-0:** none.

---

## Safe next action

Review and merge this draft into `phase-1/identity`; nothing here blocks or is blocked by anything else outstanding. WT-4 can continue building against the unchanged Agent API contract.
