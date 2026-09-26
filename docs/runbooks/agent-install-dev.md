# Runbook — install the CloudBox Agent on a lab PC (dev build)

Owner: WT-4. Applies to: `CloudBox.Agent.exe` built by `.github/workflows/build-windows.yml`
(artifact **`CloudBox.Agent-win-x64`**). Cloud: `https://box.affinityminds.in`.

> Everything the Agent changes on the machine is recorded in `C:\ProgramData\CloudBox\install-manifest.json`
> (plus a DPAPI copy in `HKLM\SOFTWARE\CloudBox\ManifestBackup`) **before** it happens, so `uninstall` returns the
> machine to its original state. Later slices (RDP Wrapper, Netclient, managed users, firewall gate, Status
> autostart) install through the same manifest steps; see `docs/runbooks/uninstall.md`.

## Prerequisites

- Windows 10/11 or Server 2019+ x64, a local administrator account, outbound HTTPS to `box.affinityminds.in`.
- A fresh enrollment token (single use, short TTL) from the console **Enrollment** page. Every install needs a new
  token; a token that was already used returns "invalid, expired or already used".
- No .NET install is needed: the exe is self-contained.

## Demo path (do these in order, paste the evidence listed at the end)

1. **Download the build.** GitHub → Affinity-Minds/cloudbox → PR "WT-4: Windows Agent service…" → Checks →
   *Build Windows components* → run summary → Artifacts → `CloudBox.Agent-win-x64` (zip). Extract to
   `C:\Users\<you>\Downloads\CloudBox.Agent-win-x64\`. It contains `CloudBox.Agent.exe` and `CloudBox.Status.exe`.
   If SmartScreen/Mark-of-the-Web blocks it: right-click → Properties → Unblock (the dev build is unsigned).
2. **Open an elevated PowerShell** (Start → type `PowerShell` → *Run as administrator*) and go to the folder:
   ```powershell
   cd $env:USERPROFILE\Downloads\CloudBox.Agent-win-x64
   .\CloudBox.Agent.exe verify-clean     # should print CLEAN before the first install
   ```
3. **Install and enroll:**
   ```powershell
   .\CloudBox.Agent.exe install --base-url https://box.affinityminds.in --enroll-token <token from the Enrollment page>
   ```
   Expected: `device key: tpm` (or `software … DEGRADED` when the PC has no usable TPM), `enrolled: CLOUDBOX-000NN
   (dev_…) tenant CBX-…`, `CloudBox Agent installed. Service CloudBoxAgent is running (Automatic, Delayed Start).`
   If anything fails, install rolls itself back and prints the uninstall report.
4. **Status:**
   ```powershell
   .\CloudBox.Agent.exe status
   ```
   Expected: `Service CloudBoxAgent: Running` and the live JSON with `"enrolled": true`, `"cloud": "connected"`,
   `"keyProtection": "tpm"|"software"`, `"lastHeartbeatAt"` within the last minute (the first heartbeat is sent at
   service start; allow ~10 s).
   Pipe ACL check (read-only for interactive users): open a **non-elevated** PowerShell in the same folder and run
   `.\CloudBox.Status.exe` — it must print the same JSON.
5. **Fleet:** console → Fleet shows the device **Online** with key protection `tpm` or `software` (DEGRADED pill).
6. **Issue an entitlement** for the device in the console. Within ~60 s (next heartbeat):
   ```powershell
   .\CloudBox.Agent.exe status
   ```
   Expected: `"entitlementGeneration": 1` and `"entitlementFetchedAt"` set.
7. **Crash recovery:**
   ```powershell
   taskkill /f /im CloudBox.Agent.exe
   Start-Sleep 10
   sc.exe query CloudBoxAgent        # STATE: RUNNING again (recovery: restart after 5 s)
   sc.exe qfailure CloudBoxAgent     # RESTART 5000 / 10000 / 60000, reset 86400
   ```
   Note: `taskkill /im` also matches the copy in the download folder only if it is running; it is not.
8. **Reboot (optional, Slice 2.1 acceptance):** reboot, sign in, wait ~2 min (Delayed Start), run `status` again.
9. **Uninstall** (from the download folder, still elevated):
   ```powershell
   .\CloudBox.Agent.exe uninstall
   ```
   Expected: a per-entry report (`removed` / `restored` / `missing`; `scheduled` only when run from Program Files),
   `cloud notification: notified`, `Result: Completed`, report saved to `%TEMP%\CloudBox-uninstall-report.json`.
10. **Verify clean** (from the download folder, because `C:\Program Files\CloudBox` is gone):
    ```powershell
    Start-Sleep 5
    .\CloudBox.Agent.exe verify-clean ; "exit code: $LASTEXITCODE"
    ```
    Expected: every line `clean`, `CLEAN: no CloudBox artefacts remain.`, `exit code: 0`.
11. **Fleet/Audit:** the device shows **revoked**, and Audit has `DEVICE_UNINSTALLED` (actor: device).

Alternative uninstall path: Settings → Apps → Installed apps (or Control Panel → Programs and Features) →
**CloudBox Agent** → Uninstall. That runs `"C:\Program Files\CloudBox\Agent\CloudBox.Agent.exe" uninstall`
(UAC prompt), and the Program Files folder is removed ~3 s after the window closes.

## Evidence to paste back

1. Full console output of steps 3, 4 (elevated and `CloudBox.Status.exe` unelevated), 7, 9 and 10, including
   `exit code: 0`.
2. Screenshot of Settings → Apps showing **CloudBox Agent** after step 3, and a second one after step 9 showing it gone.
3. Screenshot of Fleet (Online + key protection) and of Audit (`DEVICE_UNINSTALLED`).
4. `%TEMP%\CloudBox-uninstall-report.json`.
5. Whether the PC has a TPM: `Get-Tpm` output (TpmPresent / TpmReady).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `This command must run from an elevated … prompt` | Not elevated | Run PowerShell as administrator. |
| `Enrollment token is invalid, expired or already used` | Token single-use/TTL | Create a new token; install already rolled back. |
| `This device key is already enrolled` (409) | Key reused from a previous install | `uninstall`, then install with a new token (uninstall deletes the key). |
| `Leftover CloudBox artefacts found` | Earlier install partially removed | Run `uninstall` (cleans well-known artefacts even without a manifest), then install. |
| `cloud: network_unavailable` | No network/DNS on the PC | Check connectivity. |
| `cloud: cloud_unavailable` | Network fine, cloud 5xx/unreachable | Check `https://box.affinityminds.in/api/health`. |
| `cloud: unauthorized` | Device revoked in console | Uninstall and re-enroll. |
| `Tamper: DEVICE_BINDING_FAILED` | State file does not match this machine's key | Uninstall and re-enroll. |

Logs: `C:\ProgramData\CloudBox\logs\agent-YYYYMMDD.log` (SYSTEM/Administrators only; `[SECURITY]` lines are
security events).
