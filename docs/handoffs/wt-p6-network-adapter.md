# Handoff: WT-9 — NetBird controller adapter (cloud side, mocked server)

**Status:** Ready for review (draft PR against `phase-2/devices`)
**Date:** 2026-09-27
**Branch:** `wt/p6-network-adapter` (from `phase-2/devices` @ `33862a5`)

---

## Mission

**Slice:** 6.1 (`docs/slices/6.1-netbird-adapter.md`). Decision records: ADR 0007 (NetBird
selected over spec §4.8's Netmaker), ADR 0008 (standing support access).

Build the cloud-side NetBird REST client and desired-state reconciliation (D1 → NetBird): one
isolated network per tenant, a standing support-access policy, one-off setup keys minted on
enroll and on Connect network requests, revocation wired into the existing device/membership
revoke paths — all tested against a fake NetBird server, since the real self-hosted VPS does not
exist yet. When `NETBIRD_API_URL` is unset (true in production today), every controller call is a
no-op and the enroll response omits `network` — nothing about existing behaviour changes.

---

## Current status

- Branch `wt/p6-network-adapter`, parent `phase-2/devices` @ `33862a5`.
- `corepack pnpm run verify`: **green, exit 0** (see Tests below).
- Draft PR against `phase-2/devices` (see report for URL). Not merged.

---

## Commits ready for merge

```
feat(wt-9): NetBird controller adapter — client, reconciliation, migration 0014, wiring
test(wt-9): network controller tests against a fake NetBird server
docs(wt-9): netbird-server runbook, slice 6.1, handoff
```

---

## Files and contracts changed

**New (mine):**
- `apps/worker-api/src/network/netbird.ts` — thin REST client: zod shapes for groups, policies
  (with rules), setup keys, peers; retry-with-backoff on 5xx only; the token appears solely in the
  `Authorization: Token <token>` header, never logged or in a thrown error; `fetchImpl` is
  injectable (defaults to the global `fetch`), same seam as `email/providers/smtp.ts`.
- `apps/worker-api/src/network/controller.ts` — reconciliation: `ensureTenantNetwork`,
  `ensureSupportAccess`, `mintServerSetupKey`, `mintClientSetupKey`, `revokeDevicePeer`,
  `revokeClientPeer`, `assertDefaultPolicyAbsent`, `resolveController`, `deviceNetworkPeersQuery`.
  Every public function takes an optional trailing `fetchImpl` for tests; every route handler
  omits it (defaults to the real `fetch`), so production is unaffected by the seam's existence.
- `packages/contracts/src/network.ts` — `AgentNetworkInfo`, `ClientNetworkResponse`,
  `FleetNetworkPeer`, `NetworkPeerKind`/`NetworkPeerStatus`.
- `apps/worker-api/test/network/`: `fake-netbird-server.ts` (in-memory NetBird replaying the
  documented shapes), `netbird-client.test.ts`, `network-controller.test.ts`,
  `network-wiring.test.ts`.
- Docs: `docs/runbooks/netbird-server.md`, `docs/slices/6.1-netbird-adapter.md`, this handoff.

**Edited (additive only):**
| File | Change |
|---|---|
| `apps/worker-api/src/db/schema.ts` | `networkPeers` table (migration 0014, my reserved number — brief explicitly authorised this table) |
| `apps/worker-api/src/env.ts` | `NETBIRD_API_URL?`, `NETBIRD_API_TOKEN?` on `Bindings` |
| `apps/worker-api/src/routes/v1/agent.ts` | `enrollDevice`'s route calls `mintServerSetupKey` (best-effort) and adds `network` to the 201 body; `uninstallDevice` gains an `env` param and calls `revokeDevicePeer` (best-effort) |
| `apps/worker-api/src/routes/v1/devices.ts` | `revokeDevice` gains an `env` param and calls `revokeDevicePeer` (best-effort) |
| `apps/worker-api/src/routes/v1/memberships.ts` | `DELETE /:id` calls `revokeClientPeer` (best-effort) after its existing `USER_REMOVED` audit |
| `apps/worker-api/src/routes/v1/self-service.ts` | new route `GET /connect/devices/:deviceId/network` |
| `apps/worker-api/src/routes/v1/screens/fleet.ts` | `loadFleetDetail`'s existing `db.batch` gains one query (`deviceNetworkPeersQuery`), result exposed as `network` |
| `packages/contracts/src/agent.ts` | `EnrollResponse.network?: AgentNetworkInfo` |
| `packages/contracts/src/devices.ts` | `FleetDetailScreen.network?: FleetNetworkPeer[]` |
| `packages/contracts/src/common.ts` | `ID_PREFIX.networkPeer = "npeer_"` |
| `packages/contracts/src/index.ts` | one export line for `network.ts` |
| `apps/worker-api/test/devices.test.ts` | `revokeDevice(...)` call sites updated for its new `env` parameter |
| `apps/worker-api/test/queries.ts` | 4 registry entries for the new table's query shapes |
| `apps/worker-api/test/query-plans.test.ts` | `network_peers` added to `GUARDED_TABLES` |

**Reused, not duplicated:** `audit()`, `newId`/`nowIso`, `createDb`, the fixtures contract
(`seedTenant`/`seedDevice`/`seedMembership`/`signInAs`), the smtp provider's dependency-injection
pattern for a testable HTTP client.

**Not touched:** `apps/worker-api/wrangler.jsonc` (WT-0-owned per `docs/handoffs/foundation.md`
"Shared-file rules" — `NETBIRD_API_URL`/`NETBIRD_API_TOKEN` need adding there before this does
anything in production; see "Requests to WT-0"), `routes/v1/index.ts` (no new top-level mount —
the one new route lives inside WT-14's existing `self-service.ts` router).

---

## Migrations

- **0014** (reserved, used): `network_peers(id, kind, tenant_id, device_id, user_id,
  netbird_peer_id, netbird_setup_key_id, group_ids_json, status, created_at, updated_at)` + 4
  indexes (one plain, three partial-unique: one row per device, one per (tenant, user) client, one
  per tenant support marker). Generated with `drizzle-kit generate` from the current schema tip; a
  second `db:generate` reports **"No schema changes, nothing to migrate"** (verified).

---

## API changes (`/api/v1`, all additive)

| Method | Path | Auth | Change |
|---|---|---|---|
| POST | `/agent/enroll` | token | 201 body gains optional `network: {setupKey, managementUrl}` |
| GET | `/connect/devices/:deviceId/network` (new) | customer session, active membership in the device's tenant | 200 `{setupKey, managementUrl, expiresAt}`; 403 not a member; 404 unknown device or `network_not_configured`. Audited `NETWORK_CLIENT_KEY_ISSUED` |
| GET | `/screens/fleet/:deviceId` | unchanged | response gains `network: FleetNetworkPeer[]` |
| POST | `/devices/:deviceId/revoke` | unchanged | now also revokes the NetBird peer/key (best-effort) |
| POST | `/agent/uninstalled` | unchanged | same |
| DELETE | `/tenants/:tenantId/memberships/:id` | unchanged | now also revokes the member's client peer/key (best-effort) |

"Best-effort" means: wrapped in `.catch()`, logged, never changes the HTTP status of the action it
rides along with. An unreachable NetBird server cannot block enrolling, revoking a device, or
removing a member.

---

## Security assumptions

- **The token never leaves the Worker.** `Authorization: Token <token>` is the only place it
  appears on the wire; `netbird.ts` never puts it in a URL, a log line, or a thrown error message
  (asserted by a test). It is a Wrangler secret (`NETBIRD_API_TOKEN`), never in `wrangler.jsonc`.
- **Setup keys are one-off and 24 h**, both server and client — `usage_limit: 1` in addition to
  `type: "one-off"` (belt-and-suspenders; NetBird's own one-off type already enforces single use).
  Never logged, never audited in the clear (the audit row's `after` carries the tenant/expiry, not
  the key itself), never returned again after the mint response (a re-mint replaces the row and
  hands back a fresh key; the old one is left to expire unused).
- **Tenant isolation is enforced at the NetBird policy level**, not just believed: the generated
  tenant policy's `sources`/`destinations` are exactly that tenant's own two group ids, and a test
  asserts directly on the fake server's stored policy that neither tenant's ids appear in the
  other's rule. `assertDefaultPolicyAbsent` makes the isolation invariant fail closed — every
  `ensureTenantNetwork`/`ensureSupportAccess` call refuses to proceed while NetBird's built-in
  allow-all policy still exists, rather than silently layering isolation rules on top of an
  allow-all.
- **The Connect network route's gate is membership, re-resolved per request** from
  `tenant_memberships` (same pattern as `GET /connect/devices`), not a static claim from the
  session or a cached role.
- **`network_peers` never stores a setup key or a peer's real address** — only ids
  (`netbird_setup_key_id`, `netbird_peer_id`) and a JSON array of NetBird group ids. The plaintext
  key exists only in the mint response, once.
- **Membership/device revoke wiring is best-effort by design** (see API changes table) — a
  NetBird outage must not turn "revoke this device's cloud access" into a failed, half-applied
  write. The controller's own no-op path (unconfigured) and this best-effort wiring share the same
  philosophy: NetBird is infrastructure plumbing, never a dependency the business-critical paths
  (enroll, licensing, revocation) can be blocked by.

---

## Tests run and exact results

### `corepack pnpm run verify`

```
$ biome check .                Checked 216 files. No fixes applied. (1 pre-existing warning, tests/e2e-cloud)
$ pnpm typecheck                contracts, licensing-contracts, worker-api, admin-web, tests/e2e-cloud: Done
$ pnpm test
  packages/licensing-contracts  Test Files 2 passed (2)    Tests 16 passed (16)
  apps/admin-web                Test Files 3 passed (3)    Tests 13 passed (13)
  apps/worker-api                Test Files 37 passed (37)  Tests 678 passed (678)
$ pnpm build                    admin-web ✓ built; worker-api wrangler deploy --dry-run OK (Total Upload 3211.43 KiB / gzip 555.38 KiB)
EXIT 0
```

### Coverage by file (`apps/worker-api/test/network/`, mine — 38 tests)

- **`netbird-client.test.ts`** (9) — `netbirdConfig` null when `NETBIRD_API_URL` unset; request
  shape (`Authorization: Token <token>`, `createSetupKey`'s exact body incl. `usage_limit: 1` for
  one-off); `findGroupByName` exact-match (not substring); retries a 5xx twice then succeeds;
  gives up after exhausting retries on a persistent 5xx; no retry on a 4xx and the token never
  appears in the thrown error; a network error (`fetch` throwing) is retried then surfaced as
  `NetbirdApiError`.
- **`network-controller.test.ts`** (20) — `ensureTenantNetwork` idempotent (one group pair, one
  policy, same result on a second call); the generated policy's sources/destinations reference
  only that tenant's own groups, never another tenant's (asserted directly against two tenants'
  policies); the rule carries TCP 3389 + the reserved management port, one-directional; Default
  policy detection throws and `ensureTenantNetwork` propagates it; `ensureSupportAccess` creates
  the group + policy with no tenants yet, folds a newly provisioned tenant's server group in, and
  is idempotent; `mintServerSetupKey`/`mintClientSetupKey` mint one-off keys scoped to exactly one
  group with the right expiry, write the `network_peers` row, audit
  `NETWORK_SERVER_KEY_ISSUED`/`NETWORK_CLIENT_KEY_ISSUED`, and re-minting updates the existing row
  rather than duplicating it; the not-configured path makes zero NetBird calls (`resolveController`
  itself, and both mint/revoke functions) and records `status: 'not_configured'`; revocation
  deletes the peer once joined, revokes the unused setup key when not, and is safe to call twice
  (no second NetBird call).
- **`network-wiring.test.ts`** (9) — the enroll response's `network` field present when configured,
  absent when not; the Connect network route's 401/403/404/200 boundaries, its
  `network_not_configured` 404, and its `NETWORK_CLIENT_KEY_ISSUED` audit row; device revoke and
  membership revoke each flip the corresponding `network_peers` row to `revoked` through the real
  HTTP routes (global `fetch` stubbed for the duration, since route handlers have no `fetchImpl`
  seam of their own — see the file's header comment).

Todo tests: **none.**

---

## Demo path

Local (`wrangler dev` + fresh local D1; the fake-server tests above are the load-bearing proof
since the real VPS does not exist — this is the same flow, manually, against a real or local
NetBird dev instance):

```
1. .dev.vars: the usual (BETTER_AUTH secrets etc.) + NETBIRD_API_URL=<your NetBird dev instance>,
   NETBIRD_API_TOKEN=<its service-user token>
2. wrangler d1 migrations apply cloudbox-db --local
3. Staff → Enrollment → new token for a tenant
4. curl -X POST /api/v1/agent/enroll -d '{"token":"...","device":{...}}'
   → 201 {..., network: {setupKey: "...", managementUrl: "https://..."}}
5. On a test machine: netbird up --setup-key <that key> --management-url <that URL>
   → joins, shows up in the NetBird dashboard under cbx-server-<tenant code>
6. Fleet → device detail → Network tab → one row, kind "server", status "pending"
7. Connect (customer session, member of that tenant) → GET /connect/devices/:id/network
   → 200 {setupKey, managementUrl, expiresAt}
8. Device detail → Revoke → Network tab shows "revoked"; the setup key is revoked in NetBird too
   (or the peer is removed, if it had already joined)
```

Full verification checklist for the real VPS: `docs/runbooks/netbird-server.md` §6.

---

## Known failures

- None in `verify`. The real self-hosted NetBird server does not exist yet — everything here is
  proven against the fake server and the documented API shapes, not a live install. That is the
  brief's own scope ("built and tested against a mocked NetBird API now; the real self-hosted
  server comes last").

---

## Deviations from the brief

- **Group/policy naming uses the tenant's public code** (`CBX-00001`), not the internal `ten_…`
  id ADR 0007's own shorthand (`cbx-<tenant-id>`) implies — this slice's Deliver bullet writes
  `cbx-client-<code>`/`cbx-server-<code>`, read as the public code for NetBird-dashboard
  readability. One-line change (`serverGroupName`/`clientGroupName` in `controller.ts`) if the
  owner wants the internal id instead.
- **The Agent management port (`AGENT_MANAGEMENT_PORT = "7391"` in `controller.ts`) is a reserved
  placeholder, not a real listener.** Searched the master spec, ADRs, WT-4's brief and every slice
  doc for an existing "Agent management port" — none exists; the Windows Agent (Slices 2.1–2.5) has
  no network-listening surface at all today, only local named-pipe IPC and outbound HTTPS calls to
  the cloud. The brief for this slice explicitly asks for "TCP 3389 + the Agent management port" on
  both the tenant and the support policy, so a port is reserved and wired into both rules exactly
  as asked, flagged here rather than guessed silently.
- **`fetchImpl` threaded through every controller export** as an optional trailing parameter
  (defaulting to the global `fetch`) rather than a global mock — not in the original file list, but
  needed for the controller-level tests to inject a fake server without monkey-patching
  `globalThis.fetch` in the unit tests (the HTTP-level wiring tests still do monkey-patch it,
  since route handlers have no such seam — documented in that test file's header).
- **`wrangler.jsonc` and `routes/v1/index.ts` left untouched.** The brief's own `docs/plans/briefs/
  _COMMON.md` reserves `wrangler.jsonc` for WT-0; `NETBIRD_API_URL` simply being absent from `vars`
  already produces the correct "not configured" behaviour (an unset optional `Bindings` field), so
  no code change needed either to demonstrate the no-op path. `routes/v1/index.ts` needed no new
  line — the one new route (`/connect/devices/:deviceId/network`) lives inside WT-14's existing
  `self-service.ts` router, already mounted at `/`.

---

## Decisions needed

- **The Agent management port.** Confirm `7391` (or supply the real value) once WT-4/WT-10 build an
  in-mesh management surface for the Agent. Until then it is inert.
- **Group naming: tenant public code vs. internal id** (see Deviations) — either is a one-line
  change; flagging so the owner can pick before the real VPS is provisioned and dashboard muscle
  memory forms around whichever name shows up first.

---

## Requests to another worktree

- [ ] **WT-0:** add `NETBIRD_API_URL` (empty-string default) to `apps/worker-api/wrangler.jsonc`'s
  `vars`, and run `wrangler secret put NETBIRD_API_TOKEN` once the VPS from
  `docs/runbooks/netbird-server.md` exists. Neither is needed for this PR to be safe to merge —
  the feature stays off until both are set.
- [ ] **WT-4 (Windows Agent):** the enroll response's `network` field is additive; nothing to do
  until the Agent embeds the NetBird Netclient (Slice 6.3). When it does, confirm/replace the
  reserved management port.
- [ ] **WT-10 (Server Setup):** same — `network.setupKey`/`network.managementUrl` are ready to
  hand to a silently-installed NetBird client whenever that slice is built.
- [ ] **WT-11 (Connect client):** `GET /api/v1/connect/devices/:deviceId/network` is ready; call it
  after a successful Connect sign-in to get a client setup key for whichever device the user wants
  to reach.

---

## Safe next action

Review and merge this draft into `phase-2/devices`; nothing here is blocked by or blocks anything
else outstanding. The real NetBird VPS provisioning (`docs/runbooks/netbird-server.md` §1–5) and
its verification checklist (§6) are the safe next action for whoever owns that infrastructure step
next — this PR does not require it to merge.
