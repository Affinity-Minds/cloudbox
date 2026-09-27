# Runbook — RDP runtime (sergiye/rdpWrapper 2.15, TermWrap)

Decision: `docs/decisions/0012-rdp-runtime-sergiye-rdpwrapper.md`. Code: `apps/cloudbox-agent/Rdp/`,
`apps/cloudbox-agent/Install/ServerInstall.cs`, `apps/cloudbox-server-setup/third-party.lock.json`.

Customers never see this component. Support and the owner use this page.

## What is on a CloudBox server

| Item | Where | Owner | Removed by uninstall |
|---|---|---|---|
| Runtime package | `C:\Program Files\CloudBox\vendor\rdpWrapper_x64.exe` (+ its own `*.log`) | CloudBox (manifest `file`) | yes |
| Wrapper DLLs | `C:\Program Files\RDP Wrapper\TermWrap.dll`, `zydis.dll`, `UmWrap.dll`, `EndpWrap.dll` | upstream `-install` | yes (upstream `-uninstall`) |
| TermService hook | `HKLM\SYSTEM\CurrentControlSet\Services\TermService\Parameters\ServiceDll` → `...\RDP Wrapper\TermWrap.dll` | upstream | restored to `%SystemRoot%\System32\termsrv.dll`, verified |
| Defender exclusions | `C:\Program Files\RDP Wrapper`, `C:\Program Files\CloudBox\vendor` | CloudBox (manifest `third_party_component defender-exclusion:…`) | yes |
| Remote Desktop on | `...\Control\Terminal Server\fDenyTSConnections = 0` | CloudBox (`windows_setting`, prior value kept) | restored |
| NLA | `...\WinStations\RDP-Tcp\UserAuthentication = 1`, `SecurityLayer = 2` | CloudBox (`windows_setting`) | restored |
| VC++ 2015–2022 x64 runtime | Windows Installer product | CloudBox installs if missing or older than 14.40 | **kept** (shared runtime) |

## Health states (Agent → health document `rdp.state`, Status app, Fleet)

| State | Meaning | What to do |
|---|---|---|
| `healthy` | ServiceDll is TermWrap, DLLs present, TermService running, listener on the RDP port | — |
| `wrapper_missing` | ServiceDll is `termsrv.dll` (runtime not installed, or removed by someone) | `CloudBox.Agent.exe repair` |
| `repair_required` | ServiceDll points at TermWrap but the DLL (or `zydis.dll`) is gone: usually antivirus quarantine | check Defender history, restore, then `repair` |
| `service_stopped` | TermService not running | `repair` (starts it) or reboot |
| `listener_missing` | TermService running but nothing listens on the RDP port (usually `fDenyTSConnections=1`) | check the setting; `repair`; reboot |
| `unsupported_runtime` | not x64 Windows 10+, TermService not in svchost, or a legacy `rdpwrap.dll` / third-party ServiceDll | do not force; escalate |

Listener check: `PortNumber` under `WinStations\RDP-Tcp` (default 3389) must be in the TCP listener table.

## Commands (elevated PowerShell on the server)

```powershell
& "C:\Program Files\CloudBox\Agent\CloudBox.Agent.exe" status        # pipe document incl. rdp.state / rdp.detail
& "C:\Program Files\CloudBox\Agent\CloudBox.Agent.exe" repair        # re-applies manifest items, then RDP repair
reg query "HKLM\SYSTEM\CurrentControlSet\Services\TermService\Parameters" /v ServiceDll
Get-Service TermService
Get-NetTCPConnection -LocalPort 3389 -State Listen
Get-MpThreatDetection | Where-Object { $_.Resources -match 'RDP Wrapper' }   # quarantine evidence
```

`repair` never downloads anything: it re-runs the package kept in `vendor\`. If that file was quarantined too, run
CloudBox Server Setup again after uninstalling, or restore the file from Defender quarantine.

## How Setup drives the runtime (and why)

1. Add Defender exclusions (manifest entries) **before** writing or running the package.
2. Write `vendor\rdpWrapper_x64.exe` from Setup's embedded payload (SHA-256 pinned at build time).
3. Kill stray `rdpWrapper*` processes (a second instance shows a MessageBox even in console mode and would hang).
4. Run `rdpWrapper_x64.exe -install -offline` (`-offline` last: no update check), 120 s timeout, exit code ignored
   (it exits 0 even when its own OS check refuses).
5. Verify within 30 s: ServiceDll ends with `TermWrap.dll`, the DLL exists, TermService running. Otherwise the step
   fails with the probe result and Setup rolls everything back.
6. Windows settings step sets `fDenyTSConnections=0`, NLA; then waits up to 30 s for the listener (warning, not
   failure, if it does not come up: Status shows `listener_missing`).

Uninstall runs `-uninstall -offline` the same way and requires ServiceDll back at `termsrv.dll` (else the entry is
reported `failed` and `verify-clean` exits 1).

## Updating the pinned runtime

1. Read the upstream release notes and diff; confirm the console verbs and `ServiceDll` behaviour are unchanged.
2. `gh api repos/sergiye/rdpWrapper/releases/tags/<tag> --jq '.assets[] | select(.name=="rdpWrapper_x64.exe") | .digest'`
3. Update `url`, `tag`, `released`, `size`, `sha256` in `apps/cloudbox-server-setup/third-party.lock.json` in one
   commit; CI recomputes the hash and refuses a mismatch.
4. Lab-test with `docs/runbooks/server-setup-lab.md` before release; record it in the ADR.

## Known risks

- Antivirus false positives (Defender, others). Organisation-managed Tamper Protection can refuse exclusions.
- Windows feature updates: TermWrap finds offsets automatically; if a build breaks it, state becomes
  `listener_missing`/`service_stopped` and new sessions fail while the console keeps working. Pause feature updates on
  alpha servers.
- The runtime writes a log next to its exe; it lives in `vendor\` and is removed with it.
