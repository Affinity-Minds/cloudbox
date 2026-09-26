# Handoff — WT-4 `wt/p2-agent` (Windows Agent, Slices 2.1 / 2.2 / 2.3 client / 2.5)

## Mission
Deliver the .NET 10 CloudBox Agent Windows service with TPM/CNG device identity, DPAPI state, a read-only status
pipe, enrollment/heartbeat/entitlement clients against the fixed PLAN_5AM §7 contract, and a manifest-driven
uninstaller that returns the machine to its original state (PLAN_5AM §10), built and tested on `windows-latest`,
published as one downloadable exe for the owner's lab PC.

## Current status
- Code complete for the brief; draft PR https://github.com/Affinity-Minds/cloudbox/pull/2 (base `phase-0/bootstrap`, not merged).
- Windows workflow **green**: build, 37/37 tests, single-file self-contained publish, artifact `CloudBox.Agent-win-x64`.
- **Not yet physically verified.** Owner lab run pending (`docs/runbooks/agent-install-dev.md`). Nothing below
  about TPM, service recovery, pipe ACL from a real interactive user, or uninstall completeness on a real install is
  claimed until the owner reports it.

## Commits ready for integration
Branch `wt/p2-agent` (author Soren Singh Dary), on top of `phase-0/bootstrap` 584aa9e:
- feat(agent): Windows service, device identity, enrollment client, manifest uninstaller
- fix(agent): remove double hyphen from csproj comment
- fix(agent): explicit PCP provider name, ignore computed manifest field; add runbooks and slice 2.5 note
- fix(agent): wait for service process exit and retry deletes on uninstall; no native self-extract; 1 h clock tolerance
- fix(agent): send a User-Agent; runbook unblock step
- test(agent): import xunit abstractions for test output
- docs(handoff): WT-4 handoff (this file)

## Files/contracts changed
- `apps/cloudbox-agent/**` — service + CLI (`Program.cs`, `Cli.cs`), `Identity/DeviceKey.cs` (`IDeviceKeyStore`,
  `CngDeviceKeyStore`, RFC 7638 thumbprint), `State/AgentState.cs` (`ILocalStateStore`, `FileStateStore`+`DpapiProtector`,
  `TrustedTimeState`, `StateBinding`), `Cloud/*` (`IEnrollmentClient`, `IHeartbeatClient`, `IEntitlementClient`,
  `IUninstallNotifier`, `AgentApiClient`, `Backoff`, §29 `AgentHealth`), `Service/*` (`HeartbeatCycle`, `AgentWorker`,
  `StatusPipeServer`, `AgentStatus`), `Install/*` (manifest, `IInstallStep` + 14 kinds, `ManifestRunner`, `Uninstaller`,
  `CleanVerifier`, `WellKnown`), `app.manifest` (`requireAdministrator`).
- `apps/cloudbox-agent.tests/**` — new xUnit project (added to `CloudBox.slnx`).
- `apps/cloudbox-status/` — console stub that prints the pipe JSON.
- `.github/workflows/build-windows.yml` — `dotnet test`, publish both exes win-x64 single-file self-contained,
  list publish output, upload artifact `CloudBox.Agent-win-x64`; workflow file added to the path filter.
- `docs/runbooks/agent-install-dev.md`, `docs/runbooks/uninstall.md`, `docs/slices/2.5-uninstall.md`.

Machine footprint (all recorded in the manifest before creation): service `CloudBoxAgent` (LocalSystem, Automatic
Delayed Start, recovery restart 5 s / 10 s / 60 s, reset 1 day, failureflag 1), `C:\ProgramData\CloudBox` (ACL SYSTEM +
Administrators only; `agent-state.bin`, `install-manifest.json`, `logs\agent-YYYYMMDD.log`), `C:\Program Files\CloudBox\Agent\CloudBox.Agent.exe`,
`HKLM\SOFTWARE\CloudBox` (DPAPI manifest backup), CNG machine key `CloudBox.Agent.DeviceKey`, event log source
`CloudBoxAgent`, ARP key `HKLM\...\Uninstall\CloudBoxAgent`. Pipe `\\.\pipe\CloudBoxAgent` (no persistent artefact).

## Migrations
None.

## API/event/schema changes
None to the fixed contract. Client uses exactly: `POST /api/v1/agent/enroll`, `POST /api/v1/agent/heartbeat`,
`GET /api/v1/agent/entitlement`, and `POST /api/v1/agent/uninstalled` (Bearer device token, no body, best effort).
Manifest entry JSON: contract fields `kind, id, createdAt, priorState` plus additive `spec` and `status`
(`pending|applied`).

## Security assumptions
- Device key: CNG RSA 2048 machine key; TPM via "Microsoft Platform Crypto Provider", else "Microsoft Software Key
  Storage Provider" with export policy none, reported `keyProtection: "software"`. No custom crypto; thumbprint is
  RFC 7638 (verified against the RFC example vector in tests).
- State (incl. `deviceToken`, entitlement JWE) is DPAPI **machine** scope with app entropy, in a folder ACL'd to
  SYSTEM/Administrators, and bound to the key thumbprint: a copied/undecryptable state file gives
  `DEVICE_BINDING_FAILED` and no heartbeat. Local admins are trusted (spec §11: no claim against full local admin).
- Enrollment token and device token are never logged or printed; `spec` never holds secrets.
- Pipe ACL: SYSTEM + Administrators full, Interactive `Read|Synchronize` only; server uses `FirstPipeInstance` so a
  squatted pipe name is detected and logged `SECURITY`. The Status client does not yet verify the server PID
  (Slice 2.4).
- Trusted time: server time only raises the high-water mark; rollback tolerance 1 h tonight (Slice 4.1 tunes).
- `--purge-data` is the only path to customer data and needs the typed machine name; logged `SECURITY`.
- Single-file publish does **not** self-extract native libraries (publish output = exe + pdb only), so nothing is
  left in `%TEMP%\.net`.

## Tests run + exact results
- CI run https://github.com/Affinity-Minds/cloudbox/actions/runs/36263201788 (commit c45e922, `windows-latest`,
  .NET 10): `dotnet build` 0 warnings; `dotnet test`: **Total tests: 37, Passed: 37**; publish listing
  `CloudBox.Agent.exe 38,545,474 B`, `CloudBox.Status.exe 37,587,210 B` (+ pdbs); artifact `CloudBox.Agent-win-x64`
  (65,379,134 B zip).
- Covered: enroll payload key-by-key vs contract; 400/409/503 mapping; heartbeat Bearer + §29 document shape
  (snake_case); entitlement 404; 401 = `unauthorized`; network vs cloud classification; JWK base64url and RFC 7638
  vector; DPAPI state round trip (not plaintext); copied state rejected; undecryptable state = binding failure;
  trusted-time monotonic + rollback; backoff 60 s ±10 % and growth to 15 min cap; heartbeat cycle backs off, recovers,
  persists `serverTime`, downloads entitlement generation 1; manifest reverse order + prior restore; failed mid-install
  still cleaned; verify-clean exits 1 while an entry remains; orphan cleanup; purge refused for empty/wrong name;
  purge proceeds with name; data untouched without flag; cloud notify best-effort/offline; all 14 kinds have a
  step; real directory/file/registry value/windows setting/registry key apply → revert → clean → idempotent
  re-revert; running exe scheduled for self-delete; real CNG software key create/open/delete; TPM-preferred
  store falls back cleanly on the runner; real pipe serves JSON; pipe ACL rules.
- `pnpm run verify` not run: no web code changed (the CI `web` job passes on this PR).

## What CI could not prove (owner lab run required; fill in verbatim from the owner's report)
| Item | CI | Owner lab result |
|---|---|---|
| TPM provider availability (`keyProtection: tpm`) and PCP key creation | Not proven (runner provider not recorded) | _pending_ |
| Service install, Delayed Start, survives reboot | Not proven | _pending_ |
| Service recovery after `taskkill /f` | Not proven | _pending_ |
| Pipe ACL: unelevated interactive user can read via `CloudBox.Status.exe` | Rules asserted only | _pending_ |
| Enrollment/heartbeat/entitlement against live WT-3 endpoints | Fakes only | _pending_ |
| Uninstall completeness + `verify-clean` exit 0 on a real install | Real steps on temp dirs/HKCU only | _pending_ |
| ARP entry shown/removed in Apps & Features; uninstall from ARP self-deletes Program Files | Not proven | _pending_ |

## Demo path
`docs/runbooks/agent-install-dev.md` (owner, lab PC, elevated PowerShell in the extracted artifact folder):
`verify-clean` → `install --base-url https://box.affinityminds.in --enroll-token <token>` → `status` (enrolled,
service Running; `CloudBox.Status.exe` unelevated) → Fleet Online with key protection → issue entitlement → `status`
shows `entitlementGeneration: 1` → `taskkill /f /im CloudBox.Agent.exe`, `sc.exe query CloudBoxAgent` RUNNING again →
`uninstall` → `verify-clean` prints CLEAN, exit 0 → Fleet revoked, Audit `DEVICE_UNINSTALLED`.

## Known failures/TODO
- Heartbeat sends `null` for unknown numeric/boolean §29 fields (`days_remaining`, `listener`, `configured`, `limit`,
  `active_sessions`, `last_success`, `free_bytes` if unreadable, `reboot_required`) and `"unknown"` for unknown
  states. If WT-3's `AgentHealth` schema rejects nulls, heartbeat gets 400 and status shows `error` (see Requests).
- Entitlement JWE is stored, not verified (Slice 3.3).
- `local_user`, `local_group_membership`, `firewall_rule`, `scheduled_task`, `third_party_component` steps are
  implemented but unused tonight and not exercised on real Windows in CI (they shell out to `net`, `netsh`,
  `schtasks`; membership check parses `net localgroup` output).
- `registry_value`/`windows_setting` restore String, ExpandString and DWORD prior values exactly; other prior types
  are refused before any change.
- The uninstall report is left at `%TEMP%\CloudBox-uninstall-report.json` by design (evidence for verify-clean).
- Dev build is unsigned (Unblock-File step in the runbook). Code signing is a release task.
- `docs/BUILD_STATE.md` not edited (WT-0 owns it).

## Decisions needed
- None blocking. Optional: confirm `null` for unknown numeric health fields is the agreed §29 encoding.

## Requests to another worktree
- **WT-3:** `AgentHealth` validation must accept `null` for the unknown numeric/boolean/date fields listed above and
  `"unknown"` for `license.state`, `network.state`, `rdp.state`, `backup.state`, `updates.state`.
  `POST /api/v1/agent/uninstalled` is called with the Bearer device token and **no body**; respond 204 (any 2xx is fine).
  The agent sends `User-Agent: CloudBox.Agent/0.1.0`; make sure edge bot rules do not block it.
- **WT-0:** integrate PR #2 after the owner's lab report; add Slice 2.1/2.2/2.3/2.5 rows to `BUILD_STATE.md` with the
  owner's evidence.
- **Later Windows slices (RDP Wrapper, Netclient, managed users, firewall gate, Status autostart):** install only via
  `ManifestRunner.Apply` (see header of `apps/cloudbox-agent/Install/Manifest.cs` and `docs/runbooks/uninstall.md`).

## Safe next action
Owner downloads artifact `CloudBox.Agent-win-x64` from the latest green run on PR #2 and follows
`docs/runbooks/agent-install-dev.md`, pasting back the evidence list; then paste the results into the table above.
