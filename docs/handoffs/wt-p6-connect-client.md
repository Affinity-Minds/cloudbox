# Handoff — WT-11 `wt/p6-connect-client` (CloudBox Connect client)

## Mission

**Slices:** 6.4 (`docs/slices/6.4-connect-client.md`). Decision record: ADR 0013
(`docs/decisions/0013-rdp-credential-broker.md`).

**Success criterion:** a tenant member signs in with Tenant ID + email + one-time code (no
password, ADR 0009), sees only their authorized CloudBoxes, and presses one CONNECT button to open
an RDP session with no password ever on a command line, in a file, or in a log — on the alpha's
same-LAN network only (`LanDirect`; the real private overlay is WT-9's `NetBird` build-out).

## Current status

- Branch `wt/p6-connect-client`, parent `phase-2/devices` (based on `main` 33862a5).
- Cloud side (`apps/worker-api`, `packages/contracts`): `pnpm run verify` — **green, exit 0** (see
  Tests). Fully verified locally; this box has Node/pnpm but no `dotnet`.
- Windows client (`apps/cloudbox-connect`, `apps/cloudbox-connect.tests`): **not yet built or run
  anywhere** — this box has no .NET SDK. Draft PR opened specifically to get a first
  `Build Connect client` CI run; iterate from there (see Safe next action / Known failures).

## Commits ready for merge

See the PR's commit list (this box's `git log` — same branch).

## Files and contracts changed

**New (mine):**
- `apps/cloudbox-connect/**` — the whole WPF client: `Cloud/` (contracts + `ConnectApiClient`),
  `State/SessionStore.cs` (DPAPI current-user), `SignIn/ConnectFlow.cs` (the sign-in + device-list
  state machine), `Devices/` (`DeviceListPresenter`, `DeviceRowView`, `DeviceConnector`), `Network/`
  (`IPrivateNetwork`, `LanDirect`, `NetBirdPlaceholder`), `Rdp/` (`CredentialBroker`,
  `RdpLauncher`), `App.xaml(.cs)`, `MainWindow.xaml(.cs)`, `Json.cs`, `ConnectPaths.cs`,
  `ObservableObject.cs`.
- `apps/cloudbox-connect.tests/**` — new xUnit project (added to `CloudBox.slnx`, alongside the
  existing `cloudbox-agent.tests` entry).
- `apps/worker-api/src/rdp/session.ts`, `session-grants-table.ts` — the RDP credential broker's
  cloud half (ADR 0013).
- `apps/worker-api/test/rdp-session.test.ts`.
- `infra/cloudflare/migrations/0013_rdp_session_grants.sql` (+ `meta/_journal.json` entry).
- `.github/workflows/build-connect.yml` (separate job file, per the brief — does not touch
  `build-windows.yml`, which WT-10 owns).
- `docs/decisions/0013-rdp-credential-broker.md`, `docs/slices/6.4-connect-client.md`,
  `docs/runbooks/connect-lab.md`, this handoff.

**Edited outside my own files (all small, additive; listed so owners can review):**

| File | Owner | Change |
|---|---|---|
| `packages/contracts/src/connect.ts` | WT-14 | additive: `ConnectDevice.lanAddress` (optional); new `RdpSessionRequest`/`RdpSessionResponse`/`SetManagedUserPasswordCommand`/`managedUserName` (ADR 0013) |
| `packages/contracts/src/agent.ts` | WT-3/WT-4 | additive: `AgentHealth.network.lan_address` (optional, nullable) |
| `packages/contracts/src/common.ts` | WT-0 | one new `ID_PREFIX` entry, `rdpSessionGrant: "rdpg_"` |
| `apps/worker-api/src/routes/v1/self-service.ts` | WT-14 | additive: `lanAddress` surfaced on `GET /connect/devices`; new route `POST /connect/devices/:deviceId/session` |
| `apps/worker-api/src/routes/v1/screens/fleet.ts` | WT-3 | additive: `lanAddress` column in `loadFleet`, derived via `json_extract` on the stored health JSON — no new DB column |
| `apps/worker-api/src/routes/v1/agent.ts` | WT-3 | `recordHeartbeat`'s `commands: []` is now `commands` from `pendingCommandsForDevice(db, device.id)` — additive, empty unless an RDP grant is pending |
| `apps/worker-api/test/permission-matrix.test.ts` | WT-6 | one new entry in `SELF_SERVICE_ROUTES` for the new route, with the same justification pattern as the existing onboarding entries |
| `CloudBox.slnx` | shared | two new project lines (`cloudbox-connect` already existed as a stub; added `cloudbox-connect.tests`) |

**Explicitly not touched, per the brief:** `apps/cloudbox-agent/**`, `apps/cloudbox-status/**`,
`apps/cloudbox-server-setup/**`, `.github/workflows/build-windows.yml`, `apps/worker-api/src/db/schema.ts`,
migration `0003`, `apps/admin-web/src/nav.ts`, any `package.json`, `pnpm-lock.yaml`,
`docs/BUILD_STATE.md`.

**Reused, not duplicated:** the customer Connect auth contract and `GET /connect/devices` (WT-14,
built already); the entitlement envelope's exact key-management scheme (`RSA-OAEP-256`/`A256GCM`,
`jose`) for the new RDP-credential ciphertext, rather than inventing a second crypto format; the
Agent's own DPAPI/state-store and single-file-publish conventions (adapted to current-user scope).

## Migrations

- **Reserved number:** `0013` (per the brief).
- **Filename:** `infra/cloudflare/migrations/0013_rdp_session_grants.sql`.
- New table `rdp_session_grants`, defined in its own Drizzle file
  (`apps/worker-api/src/rdp/session-grants-table.ts`), **not** added to `db/schema.ts` — the brief
  reserves that file for WT-0; this follows the same pattern the `license_keys` table used before
  WT-0 folded it in (`docs/handoffs/wt-p2-self-onboarding.md`). **Request to WT-0:** fold
  `rdpSessionGrants` into `db/schema.ts` when convenient, the same way `licenseKeys` was folded in.
- Journal (`meta/_journal.json`): appended entry `idx 4, tag 0013_rdp_session_grants`. No Drizzle
  snapshot regenerated, for the same reason WT-14 didn't for 0010/0011 (avoids conflicting with
  parallel schema work) — this migration only adds a table, so a snapshot regen is low-risk
  whenever WT-0 wants to do it.
- Applied locally via the real D1 test harness (`readD1Migrations` + `applyD1Migrations`,
  `apps/worker-api/test/apply-migrations.ts`) — every worker-api test in the suite ran against a
  database that includes this migration; **643/643 passed.**

## API changes

| Method | Path | Auth | Request | Response | Audit event |
|---|---|---|---|---|---|
| POST | `/api/v1/connect/devices/:deviceId/session` | customer session, active membership in the device's own tenant | — | 201 `{deviceId, user, password, expiresAt}`; 403 `forbidden`; 404 `not_found`; 409 `device_not_enrolled`\|`no_active_subscription`\|`no_free_slot` | `RDP_SESSION_GRANTED` |
| GET | `/api/v1/connect/devices` | unchanged (WT-14) | — | **additive** field `devices[].lanAddress: string \| null` | — |
| POST | `/api/v1/agent/heartbeat` | unchanged (WT-3) | — | **additive**: `commands` may now contain `{type:"SET_MANAGED_USER_PASSWORD", user, passwordCiphertext}` | — |

Full narrative and the exact wire shape: `packages/contracts/src/connect.ts`'s header comment and
ADR 0013.

## Security assumptions

- The RDP session grant's plaintext password exists in cloud memory only for the duration of the
  request that mints it (never written to any table); only its SHA-256 hash (identification/audit)
  and a JWE encrypted to the target device's own RSA public key (delivery to the Agent) are stored.
- Slot assignment (`grantSession` in `apps/worker-api/src/rdp/session.ts`) re-derives "currently
  occupied slots" from live (unexpired, unrevoked) grant rows on every call — no separate counter
  that could drift.
- Membership is re-resolved from `tenant_memberships` on every call to the new route, same as the
  existing `GET /connect/devices` — a membership revoked a moment ago is refused immediately, not
  just hidden from a cached device list.
- `HeartbeatResponse.commands` is a new, non-empty possibility for every Agent build ever deployed;
  any Agent that doesn't yet understand a command type must ignore unknown ones (this is a
  forward-compatibility requirement on WT-10's implementation, not something this worktree can
  enforce from the cloud side).
- Client side: the session cookie is captured once (the raw `Set-Cookie` value, name-agnostic —
  works whether the cookie is `cbx_session` or `__Secure-cbx_session`) and sent back explicitly per
  request; `HttpClient`'s cookie container is disabled (`UseCookies = false`) so there is exactly
  one place the cookie value exists in this process. DPAPI is **current-user** scope (not machine
  scope, unlike the Agent) because Connect is a per-user install with no admin.
- The managed-user password is in this process' memory only between the `POST .../session` response
  and the `CredWrite` call a few lines later; it is never logged, written to a file, or put on a
  process command line (`mstsc` is launched with only a temp `.rdp` file path and `/f`).

## Tests run + exact results

### Cloud (`apps/worker-api`, `packages/contracts`) — run on this box

```
$ pnpm run verify
biome check .            Checked 212 files. No fixes applied. (1 pre-existing warning, unrelated: tests/e2e-cloud)
tsc --noEmit              (worker-api, admin-web, contracts, licensing-contracts) — clean
vitest run                Test Files  35 passed (35)  |  Tests  643 passed (643)
                           (includes apps/worker-api/test/rdp-session.test.ts: 7/7 — membership
                            boundary, tenant boundary, slot assignment lowest-free/skip-occupied,
                            409 once full, re-grant after expiry, 401 unauthenticated, audit with
                            no secret in before/after)
vite build (admin-web) + wrangler deploy --dry-run (worker-api) — both clean
```

### Windows client (`apps/cloudbox-connect`, `apps/cloudbox-connect.tests`) — **not run yet**

No `dotnet` on this box (per the brief). 30 xUnit tests written, covering exactly what the brief
asked for:
- **Sign-in flow state machine** (`SignInFlowTests.cs`): send-code normalises and moves to the code
  screen; empty fields refused client-side; resend blocked until the 30 s cooldown elapses; verify
  success persists the session and immediately loads devices using the stored cookie; every verify
  failure (wrong code, unknown tenant/email, rate limit) surfaces without ever revealing which of
  tenant/email/code was wrong; a session expiring mid device-load signs the user back out
  automatically; an existing session for the same base URL is restored on startup; sign-out clears
  the stored session.
- **Session persistence round trip** (`SessionPersistenceTests.cs`): real DPAPI (current-user scope,
  not a fake) save→load equality; the file on disk never contains the cookie or email in the clear;
  clear deletes the file; a missing or corrupt file is treated as signed-out, not a crash.
- **Device list rendering** (`DeviceListRenderingTests.cs`): every state from the brief — online +
  licensed (nothing to explain, can connect), offline, no active plan, expired licence, offline +
  no plan together, the empty-list message, and the tenant-level "no active plan" banner.
- **Network abstraction** (`NetworkTests.cs`): `LanDirect` resolves the reported address or explains
  a missing one in plain English; `NetBirdPlaceholder` always throws "not configured" for both
  methods, per the brief ("interface only, throws").
- **Credential write/delete sequence around a fake `mstsc`** (`RdpLauncherTests.cs`): write happens
  before launch, delete happens after — including when the launch itself throws; the password never
  appears in any launch argument; the `.rdp` file has no password field and never contains the
  password.
- **Real Win32 credential store round trip** (`Win32CredentialBrokerTests.cs`, no fake): write→delete
  against the CI runner's own Credential Manager; deleting a never-written target is not an error;
  writing the same target twice overwrites.
- **End-to-end orchestration with fakes** (`DeviceConnectorTests.cs`): a full connect grants a
  session, writes the credential, and launches `mstsc`; a missing LAN address fails *before* ever
  asking the cloud for a credential; a 409 from the session endpoint surfaces the same plain-English
  message either way.

**None of this has been compiled.** The code was written against `apps/cloudbox-agent`'s established
patterns (DPAPI store, `Json` options, `ProcessRunner`-style launcher abstraction, xUnit + fakes
project shape) and cross-checked by hand against the actual contract files
(`packages/contracts/src/connect.ts`, `devices.ts`), but a first `dotnet build` is very likely to
surface real compile errors (namespaces, nullable-reference warnings promoted to errors by
`TreatWarningsAsErrors`, WPF XAML/code-behind name mismatches). That is expected — see Safe next
action.

## Demo path

`docs/runbooks/connect-lab.md` (two Windows PCs on one LAN). Not run — needs the artifact to exist
first (see Known failures) and, per the brief, a second physical Windows machine.

## Known failures / what is unproven without hardware

| Item | Status |
|---|---|
| `dotnet build`/`dotnet test` for `apps/cloudbox-connect(.tests)` | **Not run anywhere yet.** First CI run is the first real signal. |
| WPF XAML compiles and binds correctly (`MainWindow.xaml` ↔ `.xaml.cs` names/types) | Not run. Highest-risk area given no local Windows/dotnet. |
| `mstsc` actually authenticates silently against a real `TERMSRV/<address>` target | Needs a second physical machine (spec's own acceptance bar, §61) — not provable in CI. |
| The Agent applying `SET_MANAGED_USER_PASSWORD` | **Not implemented anywhere.** This worktree only defines and queues the command (ADR 0013); WT-10 owns applying it. Until then, `mstsc` will only skip the credential prompt if the managed account's real Windows password happens to already match what Connect just wrote to Credential Manager. |
| The Agent reporting `network.lan_address` | **Not implemented anywhere either.** `LanDirect` reads a field nobody populates yet; the runbook includes a manual SQL seed step to unblock the demo in the meantime. |
| Two simultaneous independent RDP sessions (spec §61) | Cloud side is ready (each grant gets its own slot); unproven end-to-end without hardware and without the two items above. |

## Decisions needed

- None blocking. Worth a quick owner confirmation: the RDP session grant TTL (15 minutes, matching
  the existing activation-grant TTL) and the managed password's character set/length (20 chars, 3-of-4
  Windows default complexity classes) are this worktree's own choices, not specified in the brief.

## Requests to another worktree

- **WT-10 (Agent):** implement `SET_MANAGED_USER_PASSWORD` — decrypt `passwordCiphertext` (compact
  JWE, `RSA-OAEP-256`/`A256GCM`, to the device's own enrolled key pair) from
  `HeartbeatResponse.commands`, parse `{"password": "..."}`, and set the named local Windows
  account's password to match. Full contract and rationale: ADR 0013. Please also add
  `network.lan_address` to the health document you already build (`packages/contracts/src/agent.ts`
  — the field is additive and already merged) so `LanDirect` has something real to resolve.
- **WT-0:** fold `rdpSessionGrants` (`apps/worker-api/src/rdp/session-grants-table.ts`) into
  `db/schema.ts` when convenient; regenerate the Drizzle snapshot for migration `0013` whenever it's
  safe to do so alongside other structural schema work.
- **WT-9 (NetBird):** `NetBirdPlaceholder` (`apps/cloudbox-connect/Network/IPrivateNetwork.cs`) is
  interface-only and always throws; implement `IPrivateNetwork` for real once the overlay exists —
  `EnsureConnectedAsync` should bring the client's overlay interface up, `ResolveAddress` should
  return the device's overlay address instead of `lanAddress`.

## Safe next action

This PR is opened as a **draft** specifically so the `Build Connect client` workflow runs for the
first time. The very next action is: read that run's log (`gh run view --log-failed`), fix whatever
the compiler says (expect WPF/XAML and nullable-reference issues first), push, and repeat until
green — then move on to a real two-machine lab run using `docs/runbooks/connect-lab.md`, which
itself is blocked on WT-10's two items above.

## Appendix: Evidence

- Cloud test output: captured above (this handoff), reproducible with `pnpm run verify` from the
  repo root.
- Windows CI run: see the PR's checks tab once `Build Connect client` has run at least once.
