# Handoff: WT-16 — Realtime fleet presence (Slices 7.1–7.2, cloud side)

**Status:** Ready for review (draft PR against `phase-2/devices`)
**Date:** 2026-09-27
**Branch:** `wt/p7-fleet-presence` (from `main` @ `33862a5`)

---

## Mission

**Slices:** 7.1 (Agent WebSocket channel), 7.2 (device presence). Deliver the `FleetPresence`
Durable Object (ephemeral presence, offline detection, transition audit) and the authenticated
`GET /api/v1/realtime/fleet` WebSocket endpoint, and wire the admin-web Fleet **list** screen to
subscribe to it — push, not polling (spec §5.3, §16, §29, §30).

**Success criterion:** a heartbeat flips a device's Fleet row from Offline to Online with no
reload; 180s of silence flips it back, once, with exactly one `DEVICE_ONLINE`/`DEVICE_OFFLINE`
audit row per transition; a staff caller sees every tenant, a customer caller only their own; the
Fleet page still renders correctly if the socket never connects.

---

## Current status

- Branch: `wt/p7-fleet-presence`, parent `main` (merges into `phase-2/devices` per this PR)
- 1 feature commit + this handoff
- `corepack pnpm run verify`: **green**, exit code 0 (tail below)
- No migration. No new dependency. No change to `wrangler.jsonc` (the `FLEET_PRESENCE` binding
  and `exports.FleetPresence` were already reserved by the foundation commit; this slice fills in
  the class that was a 204-stub in `src/index.ts`).

---

## Files and contracts changed

- **worker-api:**
  - `src/realtime/fleet-presence.ts` (new): the `FleetPresence` Durable Object class (moved out of
    `src/index.ts`, which now just imports and re-exports it — `wrangler.jsonc`'s `main`/`exports`
    bind the class from that file), plus `tenantPresenceStub()`/`globalPresenceStub()`.
  - `src/realtime/notify-presence.ts` (new): `notifyHeartbeatPresence()` — the one call
    `agent.ts`'s heartbeat handler makes into this slice.
  - `src/routes/v1/realtime.ts` (new): `GET /fleet` + `resolveRealtimeAccess()` (exported,
    unit-covered via the HTTP layer in `test/realtime.test.ts`).
  - `src/routes/v1/index.ts`: added `import realtime from "./realtime"` + one mount line
    (`v1.route("/realtime", realtime)`) — the only touch to this shared file.
  - `src/routes/v1/agent.ts`: two small additive blocks inside the existing `/heartbeat` handler
    (one per existing branch — licensed vs. auto-issuance), each calling `notifyHeartbeatPresence()`
    after `recordHeartbeat()`/`activateLicense()` already ran. Nothing else in this file changed;
    the `/enroll` route (WT-9's `network` field) is untouched.
  - `test/realtime.test.ts` (new, 13 cases — see "Tests" below).
  - `test/queries.ts`: +1 entry (`resolveRealtimeAccess`'s tenant-membership lookup), for WT-6's
    query-plan regression test.
- **admin-web:**
  - `src/hooks/fleet-presence-reducer.ts` (new): the pure `applyPresenceMessage()` reducer +
    `PresenceState` type.
  - `src/hooks/fleet-presence-reducer.test.ts` (new, 5 cases).
  - `src/hooks/use-fleet-presence.ts` (new): the WebSocket hook (reconnect with backoff, pause on
    `visibilitychange`) — no dependency added, plain `WebSocket`.
  - `src/routes/_app/fleet.tsx`: merges live presence into the REST-loaded rows by `deviceId`
    (fresher `online`/`lastSeenAt`), adds a **Sessions** column (live-only field, spec-listed,
    absent from the REST contract), adds a small `LiveIndicator` badge in the page header, and
    (additive) reapplies the online/offline filter client-side against the merged state so a
    live transition can't leave a device sitting in the wrong filtered view. `fleet.$deviceId.tsx`
    (WT-2's reason-dialog file) is untouched.
  - `vite.config.ts`: dev proxy gained `ws: true` — needed locally only (Vite's proxy does not
    upgrade WebSocket connections by default); production serves admin-web and the API from one
    Worker origin, so this has no effect there.
- **contracts (`packages/contracts/src/realtime.ts`, new):** `PresenceDevice`,
  `PresenceSnapshotMessage`, `PresenceDeltaMessage`, `PresenceMessage`. One additive export line
  in `index.ts`. Nothing in `agent.ts` (WT-11's `lanAddress` file) touched.
- **docs:** `docs/slices/7.1-7.2-presence.md`, `docs/ISSUE_LOG.md` (+1 entry — the WebSocket
  close-code trap below), this handoff.

---

## Migrations

None. Reserved `0018` **not used** — presence is entirely ephemeral (Durable Object SQLite
storage), never the durable record of anything a screen loader reads.

---

## API changes (`/api/v1`)

| Method | Path | Auth | Response | Audit |
|---|---|---|---|---|
| GET | `/realtime/fleet?tenant=` | staff (`device.view`) → global or one tenant; customer with an active membership → their tenant | 101 WebSocket upgrade; 401 no session; 403 `forbidden` (wrong tenant, or no membership); 400 `tenant_required` (ambiguous customer, no default); 426 no `Upgrade` header | — |
| POST | `/agent/heartbeat` | unchanged | unchanged wire shape | `DEVICE_ONLINE`/`DEVICE_OFFLINE` (new, via the DO, actor `system`) — additive, never blocks or changes the heartbeat's own response |

---

## Security assumptions

- **Auth happens in the Worker, never in the Durable Object.** `resolveRealtimeAccess()` reads the
  caller's own session and `tenant_memberships`; the DO's `fetch()` never branches on anything the
  client supplied (there is no tenant/staff id in the request it receives — the Worker has already
  picked the instance by the time it calls `stub.fetch()`).
- **A customer can never reach the global feed or another tenant's feed**, regardless of what they
  send: an explicit `?tenant=` outside their own active memberships is `forbidden`, and there is no
  parameter that means "give me everything."
- **The global mirror never writes an audit row.** Only the tenant instance that first observed a
  transition does, so a device's presence can be double-broadcast (tenant + global, by design —
  both have live subscribers) without ever double-auditing.
- **The DO never becomes a second source of truth.** `devices.last_seen_at` / `last_health_json`
  (D1, WT-3) stay authoritative; if `FleetPresence`'s storage were ever lost, the next heartbeat
  rebuilds it and a snapshot goes out to every subscriber — nothing downstream depends on presence
  history surviving.

---

## Tests run and results

### `corepack pnpm run verify`

```
$ biome check .                      Checked 217 files. No fixes applied. (1 pre-existing,
                                      unrelated warning in tests/e2e-cloud/tests/smoke.spec.ts)
$ pnpm -r --if-present typecheck     contracts, licensing-contracts, e2e-cloud, admin-web,
                                      worker-api: Done
$ pnpm -r --if-present test
  packages/licensing-contracts       Test Files 2 passed (2)    Tests 16 passed (16)
  apps/admin-web                     Test Files 4 passed (4)    Tests 18 passed (18)
  apps/worker-api                    Test Files 35 passed (35)  Tests 649 passed (649)
$ pnpm build                         admin-web ✓ built; worker-api dry-run deploy clean,
                                      FLEET_PRESENCE (FleetPresence) binding resolves
EXIT 0
```

(worker-api's 649 includes the pre-existing 635 — 649-635=14, one more than my 13 new cases,
because `test/queries.ts`'s +1 registry entry runs inside the existing `query-plans.test.ts`
loop, not as a new test file of mine.)

### Coverage (`apps/worker-api/test/realtime.test.ts`, mine)

- Presence upsert reflected in the WebSocket snapshot; a snapshot never leaks `tenantId` to the
  client.
- A connected socket receives a `delta` on the next heartbeat.
- `DEVICE_ONLINE` written exactly once across three repeated heartbeats (never per heartbeat).
- Offline after 3 missed heartbeats via the alarm (`runDurableObjectAlarm()`, storage backdated
  directly with `runInDurableObject()` — no real 180s wait); `DEVICE_OFFLINE` written exactly
  once; the alarm does not reschedule itself once nothing is online (`runDurableObjectAlarm()`
  returns `false` on the next call).
- The global mirror receives a tenant instance's forwarded delta and never writes its own audit
  row (asserted by count, not just absence-in-this-test).
- WebSocket auth boundary end to end: anonymous → 401; a customer with no active membership → 403;
  a customer of tenant A asking for tenant B → 403; a customer of tenant A, no `?tenant=` → 101 on
  their own tenant; staff, no `?tenant=` → 101 global; staff with `?tenant=` → 101 scoped; a
  non-upgrade request from an authorised caller → 426; a real enrolled device's presence reaching
  a customer's snapshot end to end.

admin-web: `hooks/fleet-presence-reducer.test.ts` — snapshot replaces the map; a delta upserts one
device without disturbing others; an unseen device's delta still gets added (an offline→online
delta can arrive before any snapshot has); applying the same delta twice is idempotent.

### Todo tests

None.

---

## Demo path

```
1. wrangler dev (worker-api, :8787) + vite (admin-web, :5173 — the dev proxy now forwards the
   /api/v1/realtime/fleet WebSocket too)
2. Sign in to Fleet as staff → header badge: "Connecting…" → "Live"
3. Enroll + heartbeat a device (curl, same steps as docs/handoffs/wt-p2-enrollment.md's demo,
   include a `users.active_sessions` value in the health body) → the row flips Offline → Online
   with no reload; Sessions column fills in
4. Query the audit screen (or `audit_log` directly) for that device: exactly one DEVICE_ONLINE row
5. Stop heartbeating → within ~60-180s the row flips back to Offline with no reload; exactly one
   DEVICE_OFFLINE row, and the ONLINE row from step 4 is still exactly one (not duplicated)
6. Background the browser tab for a few seconds, then foreground it: badge briefly shows
   "Connecting…", then "Live" again — socket reconnected on its own, no console errors
7. Kill wrangler dev entirely: badge sits on "Offline"; the Fleet table keeps showing whatever the
   REST loader last returned — chrome renders, nothing crashes, nothing spins forever
```

---

## Known failures

None outstanding.

---

## Deviations from the brief

- **`licenseState` on the presence document is coarse** (`none`/`active`, never `expired`): it is
  derived from `entitlementGeneration !== null` in the heartbeat handler (a value already
  computed, no extra query), not from `entitlements.valid_until` the way the Fleet REST screen's
  own `licenseState` is. Adding that second D1 read to the heartbeat hot path for a field the spec
  lists but doesn't insist be exact would cost a round trip the loader-side value already answers
  precisely (agent-notes fast-data-hydration.md). The REST loader stays the source of truth for
  the finer distinction.
- **A customer with several active tenant memberships and no explicit or stored `?tenant=`** gets
  `400 tenant_required` rather than an arbitrary first-match. There is no real customer-facing UI
  reading this endpoint yet (admin-web is staff-only; see wt-p2-enrollment.md's own "Decisions
  needed" about a future customer portal), so this is exercised only by a test today, not a UI
  choice anyone has had to make yet.
- **One merged WebSocket endpoint for both audiences**, not two separate staff/customer routes —
  same precedent as `screens/fleet.ts` (no `:tenantId` path segment to hang the fixed per-tenant
  gate off). The brief's test list named a boundary case as "staff cookie on the customer route
  401"; with one merged endpoint there is no literal separate "customer route" for that phrasing
  to land on. The boundary actually tested is narrower but equivalent in effect: a customer's
  session can never resolve to the global feed or to a tenant that isn't theirs, independent of
  what a staff caller can do on the same endpoint.
- **Fleet list's online/offline filter is re-applied client-side** against the presence-merged
  rows (additive, small `useMemo` change) so a live transition can't leave a row sitting in a
  filtered view it no longer belongs in. Not explicitly asked for, but follows directly from
  "update online pills ... in place."

---

## Decisions needed

None blocking.

---

## Requests to another worktree

- [ ] **WT-0 / whoever owns `sorensd/agent-notes`:** worth adding to
  `platform/cloudflare-workers.md` — calling `ws.close(code, reason)` inside a Hibernation API
  `webSocketClose(ws, code, ...)` handler with the *received* code throws
  `InvalidAccessError: Invalid WebSocket close code: 1005` for the (extremely common) case of a
  client closing with no explicit code. Full writeup in `docs/ISSUE_LOG.md` (2026-09-27, "Echoing
  a Hibernation WebSocket's own close code back to it throws"). Not done from this worktree — out
  of scope for a `cloudbox`-only branch.
- [ ] **A future customer/tenant portal** (not built here, per wt-p2-enrollment.md): when it exists,
  it should call `GET /api/v1/realtime/fleet` with its own active-tenant picker driving `?tenant=`
  rather than relying on the `tenant_required` fallback for a multi-tenant customer.
- [ ] **WT-10 (`apps/cloudbox-agent`):** nothing required now — the brief is explicit that the
  Windows Agent keeps its existing 60s heartbeat unchanged. For later: if the agent ever wants a
  faster-than-60s presence signal (e.g. a session starting/ending immediately, spec Slice 7.5), the
  cleanest extension is a dedicated lightweight `POST /agent/presence-ping` that calls the same
  `notifyHeartbeatPresence()` this slice added, rather than shortening the heartbeat interval
  itself (D1 load scales with heartbeat frequency; the DO push does not need to).

---

## Safe next action

Review and merge this draft into `phase-2/devices`; nothing here blocks or is blocked by anything
else outstanding on that branch. WT-9's `network` field on the enroll response and WT-11's
`lanAddress` contract addition are both untouched by this branch.
