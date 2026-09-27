# Handoff — WT-10 `wt/p5-server-setup` (Server Setup, RDP runtime, managed users, licence gate, local verifier, Status)

## Mission

**Slices:** 5.1 (Server Setup), 5.2 (RDP runtime adapter), 5.3 (parent account policy), 5.4 (managed users), 5.5 (licence
gate), 3.3 (local verifier), 3.5 (licence UI / Status app).

**Done means:** one customer-facing `CloudBox.Server.Setup.exe` turns a clean Windows 11 Pro PC into a licensed CloudBox
server through self-service sign-in and activation; two RDP sessions (cloud01, cloud02) work at once; the licence gate
blocks new sessions when the lease is expired/revoked/tampered; uninstall returns the PC to its original state and
`verify-clean` exits 0 with ServiceDll back at `termsrv.dll`.

## Current status

- Branch `wt/p5-server-setup` from `phase-2/devices` @ 33862a5. Draft PR
  https://github.com/Affinity-Minds/cloudbox/pull/26 (base `phase-2/devices`).
- **Build Windows components: green** (see Tests). Everything below that needs a real PC, a TPM, a LAN or a second
  computer is **not proven** until the owner's lab run (`docs/runbooks/server-setup-lab.md`).
- `corepack pnpm run verify`: see Tests.

## Commits ready for integration

```
8700e47 feat(worker): agent signing-keys endpoint and Server Setup WebView2 hand-off page (WT-10, additive)
f6dfbc5 feat(server): Server Setup, RDP runtime adapter, managed users, licence gate, local verifier, Status app (WT-10)
aa2934d test(server): key the fake machine by kind; detailed test log for CI evidence; ADR 0012
887efae fix(server): cache lease verification, pin keys when missing, 401-only device revocation, close Status before uninstall; …
8a89dcc ci(windows): UI screenshots of Status (sample pipe documents) and Setup welcome as evidence
(+ docs/handoff commits)
```

## Files and contracts changed

**Mine (new):**
- `apps/cloudbox-server-setup/**` — WPF Setup: `App.xaml(.cs)` (wizard / silent `/S`), `MainWindow.xaml(.cs)` (Welcome →
  Sign in → Organisation → Confirm → Install → Summary), `SignInWindow.xaml(.cs)` (WebView2 `/start` hand-off),
  `SetupApi.cs` (customer endpoints), `SetupEngine.cs` (payload, prerequisites, host, rollback, cleanup),
  `app.manifest` (`requireAdministrator`), `third-party.lock.json` (pinned URL + SHA-256).
- `apps/cloudbox-status/**` — WPF Status app (replaces the console stub), `samples/*.json` + `screenshots.ps1` (CI
  evidence only).
- `apps/cloudbox-agent/Licensing/` (verifier, evaluator, lease acceptance), `Rdp/` (probe, runtime driver, manifest
  handler), `ManagedUsers/` (AccountManagement accounts, reconciler, DPAPI credential store, WTS sessions), `Gate/`
  (licence gate, watchdog/task XML), `Install/ServerInstall.cs` (the install plan), `Install/ServerComponents.cs`
  (Defender exclusion, VC++ runtime), `Service/ServerRuntime.cs` (per-cycle enforcement).
- Tests: `EntitlementVerifierTests.cs`, `LicenseAndGateTests.cs`, `RdpAndUsersTests.cs`, `ServerInstallTests.cs`,
  `WindowsServerIntegrationTests.cs`; the test project copies `packages/licensing-contracts/test/vectors/v1.json`.
- Worker: `apps/worker-api/src/routes/v1/setup.ts`, `apps/worker-api/test/server-setup.test.ts`.
- Docs: ADR `0012-rdp-runtime-sergiye-rdpwrapper.md`, runbooks `rdp-runtime.md`, `server-setup-lab.md`, slices
  `5.1-server-setup.md`, `5.2-rdp-runtime-adapter.md`, `5.4-managed-users.md` (5.3 + 5.4), `5.5-licence-gate.md`
  (5.5 + 3.3 + 3.5), this handoff.

**Edited outside my own directories (all additive; listed for review):**

| File | Owner | Change |
|---|---|---|
| `apps/worker-api/src/routes/v1/index.ts` | WT-0 | one line: `v1.route("/onboarding/setup", setup)` |
| `apps/worker-api/src/routes/v1/agent.ts` | WT-3 | `GET /signing-keys` (device Bearer; public JWK members only; records the configured key via WT-5's idempotent `ensureSigningKey`) |
| `apps/cloudbox-agent/Install/Manifest.cs` | WT-4 | kind `local_group` (+ `Kinds.All`); `Apply` merges entries another process persisted (Setup and the service both append) |
| `apps/cloudbox-agent/Install/WindowsSteps.cs` | WT-4 | `local_user`/`local_group_membership` via AccountManagement (was `net user`/`net localgroup` parsing); `LocalGroupStep`; `file` step `spec.resource` (Setup payload); `scheduled_task` step `spec.xml`; `third_party_component` handlers (`IComponentHandler`, retain-on-uninstall) |
| `apps/cloudbox-agent/Install/Uninstaller.cs` | WT-4 | `WellKnown` gains CloudBox-named Server artefacts (Status dir/task, vendor dir, CloudBoxUsers, 2 firewall rules, watchdog task) |
| `apps/cloudbox-agent/Cli.cs` | WT-4 | `install` pins signing keys; `uninstall` stops the service and Status windows first; `repair` no longer copies the Agent exe over other files, skips runtime/users entries and runs RDP `Repair()`; `WindowsBuild()` public |
| `apps/cloudbox-agent/Service/{HeartbeatCycle,Workers,AgentStatus}.cs`, `Program.cs` | WT-4 | optional `ServerRuntime`: evaluate/enforce before and after each heartbeat, health `license`/`rdp`/`users`/`network`, pipe fields (`license`, `gate`, `users`, `rdp`, `network`, `supportAccessActive`, `renewalUrl`); gate blocked at start and stop; revocation from heartbeat (`entitlementGeneration: null` while holding one, or 401) |
| `apps/cloudbox-agent/State/AgentState.cs` | WT-4 | `HighestEntitlementGeneration`, `EntitlementRevoked`, `DeviceRevoked`, `CloudLicenseState`, `CloudMessage`, `PinnedSigningKeys` (all defaulted: old state files load) |
| `apps/cloudbox-agent/Cloud/{Contracts,AgentApiClient}.cs`, `Identity/DeviceKey.cs` | WT-4 | optional `licenseState`/`message` on enroll/heartbeat responses; `ISigningKeysClient`; `IDeviceKeyStore.OpenPrivateKey()` |
| `apps/cloudbox-agent.tests/Fakes.cs` | WT-4 | fake key store from a given RSA key; fake step handles numeric values, optional kind-keyed machine |
| `.github/workflows/build-windows.yml` | WT-0 (brief grants the Setup steps) | separate publish folders, pinned download + SHA-256 check, payload staging, Setup publish, screenshots, artifacts `CloudBox.Agent-win-x64` and `CloudBox.Server-win-x64`; `detailed` test log; path filter adds the vector and notices. `scripts/check-workflows.py` ok |
| `THIRD_PARTY_NOTICES.md` | WT-7 | corrected upstream repo (sergiye/rdpWrapper 2.15) and DLL names; added the five NuGet packages above |

## Migrations

None (reserved `0008` unused).

## API changes

| Method | Path | Gate | Response |
|---|---|---|---|
| GET | `/api/v1/agent/signing-keys` | device Bearer (401 otherwise) | `200 {keys:[{kid, alg, status, jwk:{kty,crv,x,y,kid,alg,use}}]}`, `Cache-Control: no-store` |
| GET | `/api/v1/onboarding/setup/complete` | customer session (401 without; staff session 401) | HTML; `postMessage({type:"cloudbox.setup.signed-in", email})`; `no-store`, nonce CSP, `frame-ancestors 'none'` |

The brief named `/setup/complete`; it is mounted under `/onboarding/setup` so the existing route sweeps classify it as
customer-only without editing WT-6/WT-8 tests.

## Security assumptions

- No secrets in the manifest, logs, pipe or command lines: enrollment grants, codes, licence keys, session cookies,
  device token and managed passwords are never written there (test asserts the grant and token are absent from the
  manifest JSON). Managed passwords: random 24 chars, DPAPI machine scope, `ProgramData\CloudBox\credentials`
  (SYSTEM + Administrators), never shown (ADR 0009); the lab sets its own with `net user cloud01 *`.
- WebView2: isolated per-run profile in `%TEMP%`, deleted after exit; top-level navigation confined to the CloudBox
  origin; no pop-ups/devtools; `postMessage` accepted only from the CloudBox origin; the HttpOnly session cookie is taken
  from the cookie manager, never from page script; Setup signs the session out once the grant is issued.
- Lease verification exactly per slice 3.2 (header gate, pinned kid, typ/issuer, thumbprint), then generation
  monotonic and device/tenant match; any failure → `TAMPER` → gate blocked; no lifetime rules from the JWT library.
- Pinned server keys: trust-on-first-use over the authenticated device channel (TLS + device token), then additive only.
  Local administrators are trusted (spec §11), as for the DPAPI state.
- Gate fails closed: rule created blocking; blocked at service start/stop; watchdog each minute and at boot; unknown
  states block. It never deletes runtime, users or data.
- Accounts named `cloudNN` that CloudBox did not create are never touched. The parent account is never managed.
- Third-party binaries: pinned URL + SHA-256, verified on every CI build; never committed.

## Tests run + exact results

- **Build Windows components** (windows-latest, .NET 10): build 0 warnings (TreatWarningsAsErrors), **91/91 tests
  passed** (run https://github.com/Affinity-Minds/cloudbox/actions/runs/36316631718; final run: see the PR). Publish
  sizes: `CloudBox.Agent.exe` 39,386,826 B; `CloudBox.Status.exe` 61,215,549 B (+ 5 WPF native DLLs, 8.2 MB);
  `CloudBox.Server.Setup.exe` 201,581,555 B. Artifacts: `CloudBox.Agent-win-x64` (93.5 MB zip),
  `CloudBox.Server-win-x64` (Setup + Status + Agent), `ui-screenshots`.
- Pinned downloads re-hashed by CI: `rdpWrapper_x64.exe` sha256
  `bcd0286dbf22bf38fa18010598a19fff476b82150c0199741eb3af37b699e048` (454,376 B; equals GitHub's asset digest);
  `vc_redist.x64.exe` `cc0ff0eb…b713b` (25,635,768 B).
- IdentityModel probe on the runner: `IsValid=False SecurityTokenDecryptionFailedException: IDX10609: Decryption failed.
  No Keys tried` for RSA-OAEP-256 → jose-jwt decrypt justified.
- Vector: exact claims; tamper per segment → `malformed` (header) / `decryption_failed` (key, IV, ciphertext, tag).
- Real Windows on the runner: AccountManagement group/user/memberships through the manifest (Remote Desktop Users
  resolved by SID), firewall rule created blocking → toggled → removed, watchdog and Status task XML accepted by Task
  Scheduler, RDP probe `wrapper_missing` (ServiceDll `termsrv.dll`), WTS session enumeration, VC++ runtime 14.51 read.
- Worker: `test/server-setup.test.ts` 6 tests + route sweeps (`permission-matrix`, `phase-1-hardening`,
  `phase-1-second-pass`, `agent`) green locally; full `pnpm run verify`: see below.

## Screenshots

Reviewed the `ui-screenshots` artifact from the green Windows run (36317227265); all five render fully — no blank
windows, no missing/clipped text.

- `setup-welcome.png` — CloudBox Server Setup wizard, Welcome step: title, body copy, "Advanced" toggle and "Next"
  button all render correctly.
- `status-licensed.png` — Status app, licence Active (287 days remaining), Remote Users 6/6, Remote Access Healthy;
  all fields populated.
- `status-no-plan.png` — Status app, licence "No active plan" (red), Remote Users "Waiting for the licence"; correct
  error-state copy, nothing blank.
- `status-renewal-due.png` — Status app, licence "Expires in 21 days" with QR code and "Scan to renew" rendered;
  Remote Users 6/6. With the QR shown the window is taller than the 1024×768 runner screen, so the Agent card and
  footer are cut off at the bottom edge of the capture (the window itself renders; it fits on a 1080p screen).

Status is rendered against fictional sample pipe documents (`apps/cloudbox-status/samples/`), not a live Agent.
- `status-revoked.png` — Status app, licence "Revoked" (red) with contact-admin copy; Remote Users 6/6, Remote Access
  Healthy.

## What CI could not prove (owner lab run; fill in from `docs/runbooks/server-setup-lab.md`)

| Item | CI | Owner lab result |
|---|---|---|
| rdpWrapper `-install -offline` on Windows 11 Pro: ServiceDll → TermWrap, no MessageBox/hang, no reboot | not run (fake + registry reads only) | _pending_ |
| Defender exclusions added before extraction; no quarantine; Tamper Protection behaviour | not run | _pending_ |
| VC++ silent install on a PC without it | not run (runner has 14.51) | _pending_ |
| Listener up after `fDenyTSConnections=0`; NLA logon as cloud01/cloud02; two sessions at once | not run | _pending_ |
| TPM key decrypts RSA-OAEP-256 (PCP key usage allows decrypt) | software key only (runner has no TPM) | _pending_ |
| Enroll → licence → gate open against production; revoke → REVOKED → gate blocks new sessions, existing kept | fakes only | _pending_ |
| `WTSActive` count of real RDP sessions → Fleet "Active sessions 2" | enumeration only | _pending_ |
| Watchdog re-blocks after `Stop-Service`; service recovery after `taskkill` | XML accepted only | _pending_ |
| WebView2 `/start` hand-off (Turnstile in WebView2, cookie lift) | not run | _pending_ |
| Status autostart at parent logon (InteractiveToken task), unelevated pipe read | XML accepted only | _pending_ |
| ARP uninstall → verify-clean 0, ServiceDll back to termsrv.dll, settings restored | fake machine only | _pending_ |
| Setup single-file self-extraction cleanup of `%TEMP%\.net\CloudBox.Server.Setup` | not run | _pending_ |

## Demo path

`docs/runbooks/server-setup-lab.md`: clean Windows 11 Pro → `CloudBox.Server.Setup.exe` → sign in (email + code) →
organisation → "Activate this machine as a server for tenant CBX-xxxxx? Are you sure?" → 11 steps → summary (Tenant ID,
licence) → `net user cloud01 *`, `net user cloud02 *` (lab only) → two `mstsc` sessions from the second PC → Status and
Fleet show 2 active → suspend the subscription + revoke the licence → new session refused, existing ones and the console
untouched → Apps & Features uninstall → `CloudBox.Agent.exe verify-clean` exit 0, ServiceDll `termsrv.dll`.

## Known failures / limits

- **Revoke alone is undone within a minute** while the tenant's plan is active: `/agent/heartbeat` auto-issues a new
  generation whenever the device holds no live entitlement (WT-14 `activateLicense`). The lab path suspends the plan
  first. See Requests.
- Setup is ~200 MB (it embeds the self-contained Agent 39 MB, Status 61 MB, VC++ 25 MB, plus its own WPF/WebView2
  runtime). Shrinking (shared framework-dependent payload, trimmed Status) is a release task.
- Profile folders `C:\Users\cloudNN` remain after uninstall by design (customer data); verify-clean does not check them.
- The VC++ runtime stays installed after uninstall (shared); reported `restored`, excluded from verify-clean.
- Unsigned dev build (Unblock-File in the runbook); code signing is a release task.
- `docs/BUILD_STATE.md` not edited (WT-0).

## Deviations

- ADR number 0012 (the brief's 0009 is the sign-in ADR). Hand-off route under `/onboarding/setup/complete` (see API).
- JWE decrypt with `jose-jwt` (IdentityModel lacks RSA-OAEP-256, proved in CI); JWS with IdentityModel.
- New manifest kind `local_group`; `WindowsSteps` user/group steps moved to AccountManagement.
- Managed users are created by the Agent service after the first verified lease (Setup creates the group): the
  allowance exists only after activation. Setup's health check waits for them.
- Listener missing after the settings step is a warning (summary + Status show `listener_missing`), not a rollback.
- Gate = allow rule + blocking rule toggled by the Agent (the block rule's *enabled* state is the gate), plus a
  per-minute watchdog task, rather than one rule.
- Task names are at the Task Scheduler root (`CloudBox Status`, `CloudBox RDP Gate Watchdog`) so no empty folder is left.
- Server artifact also carries `CloudBox.Agent.exe` (for `verify-clean` after uninstall).

## Decisions needed

- Owner: should an explicit licence **revoke** stop heartbeat auto-issuance for that device until staff re-issue (see
  Requests to WT-14/WT-5)? Today revoke only sticks when the plan is also stopped.
- Owner: accept the ~200 MB Setup for alpha?

## Requests to another worktree

- **WT-14 / WT-5:** `activateLicense` (heartbeat, source `auto`) re-issues right after a staff revoke when the plan is
  active. Suggest: skip auto-issuance when the device's latest entitlement row is revoked (staff re-issue stays manual).
- **WT-11 (Connect / credential broker):** managed passwords are in `C:\ProgramData\CloudBox\credentials\cloudNN.bin`
  (DPAPI machine scope, entropy `CloudBox.Agent.ManagedUserCredential.v1`, UTF-8). A lab that ran `net user cloudNN *`
  leaves that file stale: rotate on first broker use.
- **WT-9 (NetBird):** fill the `network` step in `ServerInstall.Steps`; narrow `remoteip` of both firewall rules to the
  overlay; publish `network` on the pipe (Status shows "Connected" when it is `connected`).
- **WT-3:** Fleet health already renders `license.state`, `rdp.state`, `users.active_sessions`; the Agent now sends
  real values (`VALID…`, `healthy…`).
- **WT-7:** complete the .NET inventory in `THIRD_PARTY_NOTICES.md`; ship notices inside Setup (payload carries the file).
- **WT-0:** integrate after the owner's lab report; `BUILD_STATE.md` rows for 5.1–5.5, 3.3, 3.5.

## Safe next action

Owner downloads `CloudBox.Server-win-x64` from the latest green run on PR #26 and follows
`docs/runbooks/server-setup-lab.md`, pasting the evidence list into the table above.
