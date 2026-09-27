# Runbook — Server Setup lab demo (owner, physical)

The acceptance path for Phase 5 (Slices 5.1–5.5, 3.3, 3.5). Nothing here has been run on real hardware yet; paste
the evidence list at the end back into `docs/handoffs/wt-p5-server-setup.md`.

## You need

- **Lab PC:** clean Windows 11 Pro x64 (TPM 2.0 on), wired to the LAN, Windows Update feature updates paused, signed in
  with your own local administrator account (this is the *parent* account; it is never a CloudBox user).
- **Second PC** on the same LAN with Remote Desktop Connection (`mstsc`).
- A CloudBox customer account (email) that is Owner/Admin of an organisation with a plan assigned in the console
  (Subscriptions → pending plan is fine: it starts at this first activation), or a server licence key.
- Artifact **`CloudBox.Server-win-x64`** from the latest green "Build Windows components" run on the PR: it contains
  `CloudBox.Server.Setup.exe`, `CloudBox.Status.exe` (+ its WPF DLLs, installed by Setup anyway) and
  `CloudBox.Agent.exe` (only needed for `verify-clean` after uninstall).

Dev builds are unsigned: after extracting, run `Get-ChildItem .\*.exe | Unblock-File` in the folder.

## 0. Before

```powershell
reg query "HKLM\SYSTEM\CurrentControlSet\Services\TermService\Parameters" /v ServiceDll   # ...\termsrv.dll
reg query "HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server" /v fDenyTSConnections    # note the value (1 on a clean PC)
.\CloudBox.Agent.exe verify-clean                                                           # CLEAN, exit 0
```

## 1. Install (wizard)

1. Double-click `CloudBox.Server.Setup.exe` → UAC **Yes**.
2. **Welcome → Next.** (Advanced shows the server address; default `https://box.affinity.ai.in`.)
3. **Sign in:** type your email → **Send code** → type the six digits (auto-submits).
   New customer? **Open the CloudBox sign-up page** → the `/start` page opens inside Setup (Turnstile + code) → it
   closes by itself when you are signed in.
4. **Organisation:** pick your organisation (shows plan state), or **Set up a new organisation** (name, time zone,
   optional licence key `CBX-LIC-…`).
5. **"Activate this machine as a server for tenant CBX-xxxxx? Are you sure?" → Yes, activate.**
6. **Install:** watch the 11 steps turn green: prerequisites (TPM reported), VC++ runtime, Agent service, Status app,
   remote session runtime, Remote Desktop + NLA, managed users, licence gate, private network (placeholder), activation,
   first health check (up to 3 min: it waits until cloud01..cloudNN exist).
7. **Summary:** Tenant ID, server name `CLOUDBOX-000nn`, licence (`Licensed (365 days remaining)`, or
   "No active plan found. Please contact the CloudBox admin.", or the device-limit message), remote users
   `6 of 6 ready`, remote access `Ready`. **CloudBox Status** opens for you.

Screenshot: the summary and the Status window → `docs/evidence/wt-p5-server-setup/`.

Silent alternative (staff-minted code from the console Enrollment page):

```powershell
.\CloudBox.Server.Setup.exe /S --enroll-token CBX-ENROLL-XXXX-XXXX [--base-url https://box.affinity.ai.in]
# exit code 0 ok / 1 failed and rolled back / 2 usage; log: $env:TEMP\CloudBox-Setup-*.log
```

## 2. Check the machine

```powershell
& "C:\Program Files\CloudBox\Agent\CloudBox.Agent.exe" status     # license.state VALID, gate "open", rdp.state healthy, users 6/6
reg query "HKLM\SYSTEM\CurrentControlSet\Services\TermService\Parameters" /v ServiceDll   # ...\RDP Wrapper\TermWrap.dll
Get-LocalGroupMember CloudBoxUsers                                   # cloud01..cloud06
Get-NetFirewallRule -DisplayName "CloudBox RDP Gate" | Select Enabled # False (= gate open) while licensed
Get-ScheduledTask "CloudBox RDP Gate Watchdog","CloudBox Status"
```

## 3. Two sessions at once from the second PC

The managed passwords are random and stored for the credential broker (CloudBox Connect, WT-11); nobody is ever shown
them. For this lab only, set your own on the lab PC (prompts; never on the command line):

```powershell
net user cloud01 *
net user cloud02 *
```

On the second PC: `mstsc /v:<lab-PC-LAN-IP>` → user `.\cloud01` → connect. Open a second `mstsc` → `.\cloud02`. Both
desktops stay up at the same time; the parent account stays signed in at the lab PC's console.

Within about a minute: **CloudBox Status** → Remote users "Active sessions: 2"; console **Fleet → the server →
Health**: Active sessions 2, RDP healthy, licence VALID. Screenshot both.

## 4. Expire / revoke → new sessions blocked

Revoking the licence is enough: a revoke puts the server on a **licence hold**, and automatic issuance (heartbeat
catch-up, activation) never issues to a held server, even while the plan is active. Suspending the plan is
optional (use it to stop the whole tenant).

1. Console → Subscriptions → the tenant's subscription → the server → **Revoke** licence with a typed reason.
2. Optional: set the subscription status **Suspended** (or Cancel) as well.
3. Within ~60 s (one heartbeat) the Agent reports `REVOKED`: the heartbeat answers `licenseState: "revoked"` with
   "Licence revoked by CloudBox. Contact the CloudBox admin."; `status` shows `license.state REVOKED`,
   `gate blocked`; Status shows **Revoked** in red; Fleet → License tab shows **Licence on hold** with the reason.
4. From the second PC start a **new** `mstsc` session → it cannot connect.
5. The two existing sessions keep working; the lab PC console keeps working; no account or file was deleted
   (`Get-LocalUser cloud0*` → all still there).

To restore: **Issue** a new licence for the server in the subscription drawer (this lifts the hold, audited
`LICENSE_HOLD_CLEARED`; if you suspended the plan, set it back to Active first) → next heartbeat `VALID`, gate open.

Fail-closed checks (optional):
- `Stop-Service CloudBoxAgent` → within a minute the watchdog re-enables "CloudBox RDP Gate" (Enabled True); new
  sessions refused. `Start-Service CloudBoxAgent` → gate follows the licence again.
- `taskkill /f /im CloudBox.Agent.exe` → the service recovers in ~5 s and re-validates.

## 5. Uninstall → verify-clean

1. Sign the two RDP sessions out. Settings → Apps → Installed apps → **CloudBox Server** → Uninstall (UAC Yes).
   (Or elevated: `& "C:\Program Files\CloudBox\Agent\CloudBox.Agent.exe" uninstall`.)
2. The report lists every entry `removed`/`restored` (VC++ runtime: `restored` = kept on purpose).
3. From the artifact folder, elevated:

```powershell
.\CloudBox.Agent.exe verify-clean                                                           # CLEAN, exit 0
reg query "HKLM\SYSTEM\CurrentControlSet\Services\TermService\Parameters" /v ServiceDll   # back to ...\termsrv.dll
reg query "HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server" /v fDenyTSConnections    # the value from step 0
Get-LocalUser cloud0* ; Get-LocalGroup CloudBoxUsers                                       # not found
Test-Path "C:\Program Files\RDP Wrapper","C:\Program Files\CloudBox","C:\ProgramData\CloudBox"   # False False False
```

User profile folders `C:\Users\cloud01`, `C:\Users\cloud02` remain: they hold what those users did during the demo
(customer data is never deleted by uninstall). Delete them by hand if wanted.

## Evidence to paste back

1. Summary screen + Status window screenshots (step 1).
2. `CloudBox.Agent.exe status` output (step 2).
3. Two simultaneous sessions + Status "Active sessions: 2" + Fleet health screenshot (step 3).
4. Status "Revoked" + the failed third `mstsc` + `status` showing `gate blocked` (step 4).
5. Uninstall report + `verify-clean` output + the three `reg query` lines (step 5).
6. Anything that differed from this page, verbatim.
