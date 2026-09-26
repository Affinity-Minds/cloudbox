# Phase 2 onboarding security review (WT-8)

Reviewed commit: `origin/phase-2/devices` @ `9398c32`, merged into `review/phase-1-security`. Phase 1 is already on main.

**Scope:**
- **WT-14 onboarding:**
  - start path: `src/onboarding/auth-routes.ts` `/api/auth/start/*`
  - tenant self-creation, redemption, activation grants and Connect devices: `src/routes/v1/self-service.ts`
  - licence keys: `src/onboarding/license-keys.ts`
  - activation and plan redemption: `src/onboarding/activation.ts`
- **Connect sign-in:** `/api/auth/connect/*`
- **Turnstile changes:** `src/auth/challenge.ts`
- **Auto-issuance:** the `agent.ts` enroll and heartbeat paths, plus WT-5's `issueForDevice`
- **WT-2:** primary contact becomes owner (`routes/v1/tenants.ts`)
- **Migration:** `0010_self_onboarding.sql`

Negative tests: `apps/worker-api/test/review/phase-2-onboarding.test.ts`. Each test asserts the secure behaviour, so a failing test is an open finding.

```
pnpm --filter @cloudbox/worker-api test
Test Files  2 failed | 29 passed (31)
Tests       6 failed | 548 passed (554)
```
Five of the failures are the P2 findings below. The sixth is W-1 from the Phase 1 fifth pass (Low, `OPS_BASE_PATH` accepts `/api`), which is still open. **W-1 fixed in `8c388e1` (WT-14):** `opsBasePath` rejects `/api`, `/assets`, `/login`, `/portal` and `/start` and falls back to `/ops`.

**Re-run after the fixes (`8c388e1`):** `corepack pnpm run verify` exits 0. worker-api: 31 files, 560 tests. Every review test passes unmodified. P2-7 and P2-9 stay open (WT-0 and WT-2).

**Merge blocker (High): P2-1.**

---

## High

### P2-1 Servers activated in parallel get more licences than the plan's `max_devices`
- **Where:**
  - `src/entitlement/service.ts:79-166` (`issueForDevice`): it counts the licensed devices in one query, then signs the licence, then inserts it in a separate batch. The only unique index is `(device_id, generation)`, so nothing stops two different devices from both passing the count.
  - WT-14 now runs this automatically: `activateLicense` is called on every `/agent/enroll` and on every heartbeat that has no live entitlement (`src/onboarding/activation.ts:105-163`, `src/routes/v1/agent.ts`).
- **Exploit path:**
  1. A tenant Owner/Admin mints several activation grants (20 an hour, `self-service.ts:176-217`).
  2. They enrol N servers.
  3. They let the servers heartbeat at the same moment. Each auto-issuance sees `licensed < max_devices` before any of the others inserts, so all N get a licence.

  Before WT-14 the path only ran from a staff click. Now any customer can trigger it, and it bypasses the plan's main commercial limit (`cloudbox-6` allows 1 device).
- **Evidence:** test `P2-1 … three servers activating at once on a 1-device plan get at most one licence` fails with `expected 3 to be less than or equal to 1`.
- **Fix:** make the limit part of the write.
  - Insert the entitlement with `INSERT … SELECT … WHERE (SELECT count(DISTINCT device_id) FROM entitlements WHERE subscription_id = ? AND revoked_at IS NULL AND valid_until > ? AND device_id <> ?) < ?max`, and treat `meta.changes = 0` as `device_limit_reached`. D1 runs each statement on its own, so the check and the insert cannot interleave. The audit row must then be written only after a successful insert.
  - Alternatively, claim a per-subscription slot row with a conditional upsert before signing, and release it if the batch fails (agent-notes "a transaction cannot be made conditional on one row changed").
- **Negative test:** P2-1.
- **Fixed in `8c388e1` (WT-14).** Inside `issueForDevice` only (WT-5's function; noted in the WT-14 handoff). The entitlement is written by one `INSERT … SELECT … WHERE (count of other enrolled devices of the tenant with a live entitlement on a non-cancelled subscription) < max_devices`. `meta.changes !== 1` becomes `device_limit_reached`. `LICENSE_ISSUED`/`RENEWED` is audited only after a successful insert. UNIQUE(device_id, generation) stays the last defence. This covers both the activation path and the heartbeat catch-up, since both call it. The P2-1 test passes unmodified.

## Medium

### P2-2 Connect sign-in tells a tenant member apart from a non-member
- **Where:** `src/onboarding/auth-routes.ts:278-341`.
  - A non-member gets a response built by our code: `{success:true}` on send, `CONNECT_INVALID` on verify. Nothing is sent to Better Auth.
  - A member's request goes to Better Auth, whose per-IP limiter (3 / 60 s) and error serialisation apply.
- **Oracle, verified:**
  - **verify:** the first wrong code already differs byte for byte. For a member, Better Auth answers `{"message":"Invalid OTP","code":"INVALID_OTP"}`. For a non-member, `CONNECT_INVALID` answers `{"code":"INVALID_OTP","message":"Invalid OTP"}` (same keys, different order). The 4th request is also 429 for a member and 400 for a non-member.
  - **send-code:** from one client, 4 requests give `[200,200,200,429]` for a member and `[200,200,200,200]` for a non-member.
- **Impact:** it confirms that an email belongs to tenant `CBX-#####` and exposes customer relationships. Public codes are sequential, so the tenant codes an attacker has to try form a small, known set. It does not give anyone access. It does break the stated rule (ADR 0002 / the Connect contract) that unknown tenant, unknown email and non-member all get identical answers.
- **Evidence:**
  - test `P2-2 … send-code` fails with `[200,200,200,429]` vs `[200,200,200,200]`.
  - test `P2-2 … verify` fails on the response bodies and the 4th status.
- **Fix:**
  - For both flows, apply our own per-client limit to `/api/auth/connect/*` **before** the membership lookup, set no looser than Better Auth's (3 / 60 s), so that for everyone our limit is the one that fires first.
  - On verify, map every Better Auth 4xx from the member path to exactly `CONNECT_INVALID`, with our serialisation. Use one shared constant for the answer, so key order cannot differ.
  - Keep the member send's mail in `waitUntil` so timing stays level.
- **Negative test:** both P2-2 tests.
- **Fixed in `8c388e1` (WT-14).**
  - Our own per-client limit (3 / 60 s per path) now runs on `/api/auth/connect/*` before the membership lookup.
  - On a member send, whatever Better Auth answers, the caller gets `{success:true}`.
  - Every non-2xx on the member verify path is re-serialised as the one `CONNECT_INVALID` constant.
  - Both P2-2 tests pass unmodified, and WT-14 added a byte-exact body test.

### P2-5 The start path can mail-bomb any address; only Turnstile's per-token cost stops it
- **Where:** `src/onboarding/auth-routes.ts:234-247` and `src/onboarding/common.ts:40-41`. The limits are 5 per (email, client) per 15 min and 20 per client per hour. There is no per-address ceiling (on purpose after S-2, but that reasoning applies to accounts that exist). Every send needs a fresh Turnstile token.
- **Path:** a victim address that has no customer row can be sent unlimited code emails. The attacker only needs Turnstile-solving tokens (commercial solvers charge about $1–3 per 1,000) and a pool of IPs. The cost to the product is sender-domain reputation and Email Service quota; the victim gets a flood of mail.
- **Fix:** put a per-address daily ceiling on start-path sends for addresses **without** a customer row (for example 10 per 24 h). Above it, answer the same `{success:true}` and send nothing. There is no account to lock out, and a real person can retry the next day or use the code already in their inbox (`resendStrategy: "reuse"`).
- **Test to add:** 11 start sends for one new address, each from a new client with a mocked-valid Turnstile token, deliver at most 10 emails. Not added in this pass, because the ceiling value is a product decision.
- **Fixed in `8c388e1` (WT-14).**
  - The ceiling is 10 start-path code emails per 24 h to an address with no customer row, counted from `AUTH_OTP_SENT` audit rows (outcome sent / send_failed).
  - Above it the answer is the same `{success:true}` and nothing is sent. `AUTH_START_CEILING` is audited once per 24 h.
  - Test: `onboarding.test.ts` "P2-5" sends 12 from 12 clients and gets 10 mails, 1 audit row.

## Low
- **P2-3: testing keys are accepted whenever `ENVIRONMENT` is not `production`, including when it is unset.** Location: `src/auth/challenge.ts` `verifyTurnstile`. Accept `result_with_testing_key` only when `ENVIRONMENT === "development"`, so the check fails closed. Production is safe today, because `wrangler.jsonc` defaults to `production` and WT-14's own test checks it. Test: `P2-3` (fails). **Fixed in `8c388e1`:** testing keys are accepted only when `ENVIRONMENT === "development"`.
- **P2-4: an Owner or Admin of a `suspended` or `past_due` tenant can still mint activation grants.** Only `archived` and `cancelled` are refused (`self-service.ts:192-194`). No licence is issued without a running subscription, but devices can still be enrolled into a suspended tenant. Decide the policy, then refuse at least `suspended`. Test: `P2-4` (fails). **Fixed in `8c388e1`:** grants are allowed only for `provisioning`, `active` and `trial` tenants. `suspended`, `past_due`, `cancelled` and `archived` get 403 `tenant_not_active`.
- **P2-6: tenant self-creation has no overall cap and reveals the tenant count.** The limit is 10 per customer per hour (`common.ts:46`), with no lifetime cap, so one throwaway identity can create 240 tenants a day. Because each one takes the next sequential `CBX-#####` code, any customer who creates a tenant learns roughly how many tenants exist. Add a lifetime cap per customer (for example 5 tenants without a subscription). Consider a non-sequential public code, or accept the leak and document it. **Fixed in `8c388e1`:**
  - Lifetime cap: 5 self-created tenants per customer that have no non-cancelled subscription (409 `tenant_limit_reached`). Attaching a plan frees the slot. The 10 / h limit stays.
  - The sequential-code count leak is accepted and documented in ADR 0011: codes are public by design (people type them into Connect).
- **P2-7: Drizzle metadata is out of date for 0010.**
  - `drizzle-kit generate` still emits a `subscriptions` rebuild (the `pending` status and the date check), because `meta/` was not regenerated after the hand-written 0010.
  - `license_keys` is defined outside `db/schema.ts` (`onboarding/license-keys-table.ts`), so drizzle-kit does not see it.

  The SQL in 0010 itself matches the schema, and it rebuilds `subscriptions` correctly under `defer_foreign_keys`. Regenerate the snapshot and add the license-keys table to the drizzle-kit schema list, or the next `db:generate` will emit a duplicate migration. I ran the probe and deleted what it generated; nothing was committed.
- **P2-8: licence keys typed in lower case or with spaces are rejected.** `LICENSE_KEY_PATTERN` is tested on the raw input (`license-keys.ts:257`) before the normalisation that `hashLicenseKey` applies. This is a usability issue, not a security one: normalise first, then test. **Fixed in `8c388e1`:** `canonicalLicenseKey` upper-cases the input, drops spaces and dashes, and re-groups it before the format check and the hash.
- **P2-9: a typo in the primary contact hands the tenant to that address.** WT-2's primary contact becomes owner, so a mistyped `primaryContactEmail` on a staff-created tenant makes that address the Owner (`routes/v1/tenants.ts`). The new owner still has to prove the address with a code, so only the real holder of that mailbox gets in. Show the contact back in the create confirmation, and consider a "pending owner" state until their first sign-in.

## Checked and holding
- **Licence keys:**
  - 20 Crockford symbols (100 bits) from `crypto.getRandomValues`, stored only as SHA-256 plus the last four symbols.
  - The plaintext appears once, in a `no-store` response. It is never audited: the test scans every audit row for the key body.
  - Every refusal answers the same `invalid_license_key`.
  - Guessing is infeasible regardless of rate limits (2¹⁰⁰ keys; limits of 20 per client and 10 per user per hour).
- **Redeem race:** the same key redeemed twice at once produces exactly one tenant. The claim is one conditional `UPDATE … WHERE status='unredeemed' … RETURNING`, and it is given back if the batch fails (test passes).
- **Activation grants:**
  - A `user`-standing member gets 403. An Owner of tenant A asking for tenant B gets 403, because `getTenantStanding` re-resolves the body's `tenantId` against live memberships.
  - A staff session gets 401 (customer-only route).
  - The grant token never appears in audit rows (test passes).
  - Grants expire after 15 minutes and are single use through WT-3's enrollment tokens.
- **Plan redemption:** only the first activation redeems, through a single conditional `UPDATE … WHERE status='pending'`. The loser re-reads the dates, and `SUBSCRIPTION_REDEEMED` is audited once, with actor `system`. A redeemed licence key always creates a **new** tenant, so it cannot land on a tenant that already has an active subscription.
- **Start path:**
  - Customer rows are created only after a code has been verified (`disableSignUp` is false only for `flow: "start"`), and only behind a Turnstile token on both calls.
  - In production, Turnstile checks that the hostname is ours.
  - A new customer row is audited `CUSTOMER_SIGNUP`.
  - An existing customer who signs in through the start path still meets WT-1's per-client and foreign-guess checks.
- **Connect session pinning:** `setActiveTenant` runs only after Better Auth accepts the code, and only for the tenant where membership was just resolved. `/connect/devices` re-resolves membership on every request (`?tenantId=` of another tenant gets 403).
- **Migration 0010 SQL:** it matches `db/schema.ts` and `license-keys-table.ts`, and `subscriptions` data is preserved (INSERT … SELECT of every column).

## Blocking list
1. **P2-1:** `max_devices` is exceeded by concurrent activation or auto-issuance.

Recommended before merge: P2-2 and P2-5 (Medium). The rest can follow.

## Not tested and why
- **P2-5 mail-bomb economics** (Turnstile solver cost) and the real siteverify behaviour are outside the Workers pool.
- **Timing side channels on Connect:** not measured. The status and body oracles above are already enough to make the point.
- **P2-1 at production concurrency:** the reproduction runs three concurrent in-process activations against local D1. Production D1 has more latency between the steps, which makes the race window wider, not narrower.

---

# Phase 2 verdict

Reviewed commit: `origin/phase-2/devices` @ `694b495`, which includes WT-14's fix commit `8c388e1` and WT-13's plan designer. It is merged into `review/phase-1-security`.
New test file: `apps/worker-api/test/review/phase-2-verdict.test.ts`. None of the earlier review tests were modified (`git diff af7a749..HEAD -- test/review` is empty).

```
pnpm --filter @cloudbox/worker-api test
Test Files  1 failed | 32 passed (33)
Tests       1 failed | 606 passed (607)
```
Every earlier review test now passes, including P2-1…P2-4 and W-1. The single failure is V2-4's timezone case (Low, below).

## Fix verification
| Finding | Verdict | Evidence |
|---|---|---|
| **P2-1** `max_devices` race | **Closed.** The device-limit count is now inside a single `INSERT … SELECT … WHERE (count of other live, enrolled devices on the tenant) < max_devices`, `meta.changes` is checked, and the audit is written only after a successful insert. | V2-1: 8 servers activating at once on a 1-device plan gives exactly 1 `licensed` and 7 `device_limit_reached`. On a 3-device plan, exactly 3 and 5. The count of distinct licensed devices and the `LICENSE_ISSUED` rows both equal `max_devices`. |
| **P2-2** Connect oracle | **Closed** (status and body). Our per-client limit (3 / 60 s) is checked before the membership lookup on both paths. Member-path failures, including Better Auth's own 429, are rewritten to the shared `CONNECT_INVALID`. A member's send answers `{success:true}` whatever Better Auth returned. | V2-2, for send-code and for verify: 5 calls from one client after first draining Better Auth's per-IP buckets on that client. Member and stranger get identical `status + body` byte strings, across the 429 boundary. |
| **P2-5** start-path mail bombing | **Closed.** New addresses get at most 10 code emails per 24 h across all clients. Above that, the same 200 and no mail. `AUTH_START_CEILING` is audited once per day. | V2-3: 12 sends from 12 clients with valid tokens deliver ≤ 10 mails and write exactly 1 ceiling row. |
| **P2-3** testing keys | Closed: accepted only when `ENVIRONMENT === "development"`. | P2-3 test passes |
| **P2-4** grants for inactive tenants | Closed: grants only for `provisioning`, `active` and `trial`; any other status gets 403 `tenant_not_active`. | P2-4 test passes |
| **P2-6** tenant sprawl | Closed: at most 5 self-created tenants without a plan per customer. The sequential-code leak remains and is accepted. | V2-4: the 6th creation gets 409 |
| **P2-8** typed keys | Closed: the key is canonicalised (case, spaces and dashes) before the pattern check and the hash. | V2-4: a lower-case, space-separated key redeems (201) |
| **W-1** (Phase 1) `OPS_BASE_PATH` | Closed: `/api`, `/assets`, `/login`, `/portal` and `/start` are reserved. | fifth-pass V-2 passes |
| **P2-7** Drizzle metadata | Not re-checked in this pass. |  |

## WT-13 plan routes: spot check (holds)
V2-5 checks the following:
- A `read_only` staff member gets 403 on `POST /plans`.
- `termDays` 0 and 3651 get 400; the contracts allow 1…3650, and the 0009 triggers repeat that range in the database.
- `PATCH` cannot change `code`: the row keeps its code, because the field is not in `UpdatePlanRequest` and the `UPDATE` never sets it.
- After retiring, `POST /tenants/:id/subscriptions` on that plan gets 409 `plan_retired` (tenant create and PATCH have the same check).
- A tenant that already had a subscription on the retired plan still activates and gets its licence.
- Listing retired plans (`GET /plans?include=retired`) additionally needs `subscription.manage`.

Note: a plan's `maxDevices` is read live through the join in `issueForDevice`. Lowering it in the plan designer does not revoke existing licences, but it blocks new ones for every tenant on that plan. This looks intended; the plan designer UI should say so.

## New finding
- **V2-L1 (Low): self-service tenant timezone is not validated.**
  - **Where:** `TimeZone` in `packages/contracts/src/onboarding.ts` is only a trimmed string of 1–64 characters, used by `POST /onboarding/tenants` and `/onboarding/redeem`. The staff routes, by contrast, check against `Intl.supportedValuesOf("timeZone")` (`routes/v1/tenants.ts:42-51`).
  - **Impact:** a customer can store `Not/AZone`. That is a data-integrity problem, and it could break any later code that formats dates with the tenant's timezone.
  - **Fix:** reuse `isValidTimezone` in the contract or in the handler.
  - **Test:** `V2-4 (Low) a self-created tenant with a non-IANA timezone is refused` fails (201).
- **Not measured:** response timing on Connect. The member path does Better Auth work and the stranger path does two counter writes. Status and body now match byte for byte. For timing parity, pad both paths to a fixed floor or move the member work into `waitUntil`. Not blocking.

## Verdict
**Phase 2 may merge to main. No Critical or High findings are open.** P2-1, the only blocker, is closed and holds at 8-way concurrency on both 1- and 3-device plans. Follow-ups, none blocking:
- V2-L1 timezone validation.
- Regenerating the P2-7 Drizzle metadata, if not already done.
- Connect timing parity.
