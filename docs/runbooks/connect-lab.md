# Runbook — CloudBox Connect, two-machine LAN demo

Owner: WT-11. Applies to: `CloudBox.Connect.exe` built by `.github/workflows/build-connect.yml`
(artifact **`CloudBox.Connect-win-x64`**). Cloud: `https://box.affinityminds.in`.

> Connect is a per-user install with **no admin required**: it writes nothing outside
> `%LocalAppData%\CloudBox\Connect\` (one DPAPI-protected session file). Uninstalling is deleting the
> exe and that one folder.

This is the alpha demo path: two Windows PCs on the same LAN. PC A is an enrolled, licensed CloudBox
(Agent already installed per `docs/runbooks/agent-install-dev.md`). PC B runs Connect. `LanDirect`
(the only network implementation wired up today) needs PC A's Agent to report a `network.lan_address`
in its health document — until WT-4/WT-10 add that reporting, seed it by hand (step 2) so this demo
does not block on a separate Agent change.

## Prerequisites

- PC A: an enrolled CloudBox (Fleet shows it **enrolled**, licensed) reachable from PC B over the LAN
  (same subnet, `mstsc`'s target port 3389 open — Windows' own "Remote Desktop" firewall rule, already
  on if Remote Desktop is enabled on PC A).
- A tenant member: in the console, add the signed-in owner/admin's own email (or a second person's)
  as a member of PC A's tenant, standing `user` is enough.
- PC B: no admin needed, just a Windows account and outbound HTTPS to `box.affinityminds.in`.

## Demo path

1. **Seed PC A's LAN address** (until the Agent reports it itself): note PC A's LAN IP
   (`ipconfig` → IPv4 Address, e.g. `192.168.1.42`). Ask a Super Admin to confirm the device's
   `lastHealthJson` on the next real heartbeat includes `"network":{"lan_address":"192.168.1.42", ...}`
   once WT-4/WT-10 add reporting; for this alpha demo without that change yet, a Super Admin can set
   it directly for the demo device:
   ```sql
   -- staff-only, one-off for the demo (Fleet's own heartbeat will overwrite this once the Agent reports it):
   UPDATE devices SET last_health_json = json_set(coalesce(last_health_json, '{}'), '$.network.lan_address', '192.168.1.42') WHERE id = '<dev_id>';
   ```
2. **Download the build** on PC B. GitHub → Affinity-Minds/cloudbox → PR "WT-11: CloudBox Connect
   client" → Checks → *Build Connect client* → run summary → Artifacts → `CloudBox.Connect-win-x64`.
   Extract; it contains `CloudBox.Connect.exe` plus a handful of WPF native DLLs (D3DCompiler,
   PresentationNative, wpfgfx, PenImc, vcruntime — WPF cannot bundle these into the single file,
   unlike the Agent's exe) that must stay next to it. No admin, no install step — just run the exe
   from that folder (unblock the download mark first if Windows flags it:
   `Get-ChildItem | Unblock-File`).
3. **Sign in.** Enter the tenant's public code (e.g. `CBX-00001`, shown in the console's tenant
   page) and the member's email → **Send code**. Check that inbox (or the console's `AUTH_OTP_SENT`
   audit row in a dev environment where email delivery is stubbed) for the 6-digit code, type it (or
   paste the whole code into the first box) — it submits itself on the sixth digit.
4. **Device list.** Expect PC A listed, pill **Online**, no explanation text (licensed and online).
   If the tenant has no active plan, expect the orange banner "No active plan found…" instead.
5. **Connect.** Press **CONNECT** on PC A's row. Expected, in order: a brief "Connecting…" status,
   then `mstsc` opens full-screen already authenticated as `cloudNN` — no credential prompt.
6. **During the session:** on PC B, open `certmgr.msc`-adjacent tooling is unnecessary; instead
   confirm no password ever appeared — `cmdkey /list` run **while connected** shows a
   `TERMSRV/192.168.1.42` target with no way to read the password back (Windows never exposes it).
7. **End the session** (close the RDP window on PC B). Confirm the Credential Manager entry is gone:
   ```powershell
   cmdkey /list | findstr TERMSRV
   ```
   Expected: no `TERMSRV/192.168.1.42` line (deleted by `CredDelete` in the app's `finally`).
8. **Sign out** (button next to the device list). Confirm `%LocalAppData%\CloudBox\Connect\session.bin`
   is deleted:
   ```powershell
   Test-Path "$env:LOCALAPPDATA\CloudBox\Connect\session.bin"   # expect False
   ```
9. **Cloud audit:** console → Audit shows `RDP_SESSION_GRANTED` for PC A's device (actor: the
   member's user id), with the slot and expiry only — no password, no hash.

## Evidence to paste back

1. Screenshot of the device list (Online pill) and of the live RDP session (fullscreen, showing it
   is `cloudNN`, e.g. the Start menu's account name).
2. `cmdkey /list` output from steps 6 and 7 (showing the entry present, then gone).
3. Console Audit screenshot showing `RDP_SESSION_GRANTED`.
4. Whether a second, simultaneous Connect session from a different member (or the same one twice)
   correctly gets a second slot (`cloud02`) rather than reusing the first (spec §61: "at least two
   simultaneous independent RDP sessions").

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "This CloudBox has not reported a LAN address yet." | Step 1 not done, or the Agent hasn't heartbeat since | Seed it (step 1) or wait for the next heartbeat once WT-4/WT-10 add reporting. |
| "That tenant ID, email or code is not right." | Wrong tenant code, not a member, or wrong/expired code | Re-check the tenant's public code and membership; request a fresh code (30 s resend timer). |
| "Too many attempts. Please try again in a minute." | 3 calls/60 s per client ceiling (either endpoint) | Wait a minute; this is shared with the web login path, by design. |
| "No active plan found." banner, CONNECT disabled | Tenant has no active subscription | Assign a plan in the console. |
| "Every managed user slot on this CloudBox is in use right now." | `max_managed_users` (+ add-ons) slots are all mid-session | Wait for one to expire (15 min) or increase the plan's managed-user count. |
| `mstsc` prompts for a password anyway | The Credential Manager target name doesn't match `mstsc`'s "full address" exactly (e.g. hostname vs. IP) | Confirm the `lan_address` value used is exactly what the `.rdp` file's `full address` says; both come from the same value in this build. |
| "Your session has expired. Please sign in again." | Cookie expired/revoked cloud-side | Sign in again; this is automatic (the app clears its own stored session). |

## What this demo does not cover

- `NetBirdPlaceholder` (the real private overlay, WT-9) — always refuses; alpha uses `LanDirect` on
  a shared LAN only, per the brief.
- The Agent actually applying `SET_MANAGED_USER_PASSWORD` (WT-10, not yet built) — until that lands,
  the managed account's Windows password is whatever it already was; `mstsc` will only skip the
  credential prompt if that account's real password happens to match what was just written to
  Credential Manager. Treat step 5 as end-to-end-**wired** but not end-to-end-**proven** until WT-10
  ships that half.
