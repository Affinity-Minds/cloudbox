# Runbook — uninstall CloudBox from a machine (Slice 2.5)

The owner requirement: uninstall returns the machine to the state it was in before CloudBox was installed,
and `verify-clean` proves it.

## Commands (elevated prompt)

```powershell
CloudBox.Agent.exe uninstall [--offline] [--keep-logs] [--purge-data]
CloudBox.Agent.exe verify-clean          # exit 0 = clean, exit 1 = something remains
```

| Option | Effect |
|---|---|
| *(none)* | Notify the cloud (`POST /api/v1/agent/uninstalled`, best effort, 15 s), replay the manifest in reverse, print the report. Customer data is never touched. |
| `--offline` | Skip the cloud notification (the device stays enrolled in Fleet until revoked by staff). |
| `--keep-logs` | Copy `C:\ProgramData\CloudBox\logs` to `%TEMP%\CloudBox-logs-<timestamp>` before removal. |
| `--purge-data` | **Also** deletes customer data folders (`D:\CloudBoxData`). Requires typing the machine name; anything else refuses and changes nothing. Logged on the `SECURITY` channel and listed in the report. |

Also reachable from Settings → Apps → **CloudBox Agent** → Uninstall (ARP `UninstallString`
`"C:\Program Files\CloudBox\Agent\CloudBox.Agent.exe" uninstall`).

## What happens, in order

1. `--purge-data` confirmation (only if requested). Refusal stops here.
2. Cloud notified unless `--offline` (needs the device token, so it runs before state is deleted).
3. Every manifest entry is reverted **newest first**. Each entry is `{kind, id, createdAt, priorState}`:
   - created by CloudBox (`priorState.existed = false`) → removed;
   - pre-existing (`existed = true`) → restored to `priorState` (e.g. a registry value's old data), or left alone.
   Revert is idempotent; a failed entry is reported and the rest still run.
   Typical order for the Agent: ARP entry → service (stopped, deleted) → event log source → CNG device key (deleted)
   → exe → `Program Files\CloudBox\Agent` → `Program Files\CloudBox` → `ProgramData\CloudBox` → `HKLM\SOFTWARE\CloudBox`
   (which holds the manifest backup).
4. Well-known CloudBox artefacts not in the manifest are also checked and removed (orphan cleanup if both the manifest
   file and its registry backup are lost).
5. Report printed and saved to `%TEMP%\CloudBox-uninstall-report.json` (outside every CloudBox folder so
   `verify-clean` can re-check each entry later).
6. If run from `C:\Program Files\CloudBox\Agent`, the running exe cannot delete itself: those paths are reported
   `scheduled` and removed by a detached `cmd /c ping -n 3 127.0.0.1 >nul & rmdir /s /q …` after exit.

The named pipe `\\.\pipe\CloudBoxAgent` has no persistent artefact; it disappears when the service stops.

## verify-clean

Checks every entry from the manifest (if still present), the last uninstall report, and the well-known list
(service `CloudBoxAgent`, `C:\ProgramData\CloudBox`, `C:\Program Files\CloudBox`, `HKLM\SOFTWARE\CloudBox`, ARP key
`…\Uninstall\CloudBoxAgent`, CNG key `CloudBox.Agent.DeviceKey` in the TPM and software providers, event log
sources `CloudBoxAgent` / `CloudBox.Agent`). It also prints each of the 14 manifest kinds. Exit code 1 if anything
remains — this is the lab acceptance test.

## Manifest kinds (binding for later slices)

`service`, `directory`, `file`, `registry_key`, `registry_value`, `firewall_rule`, `local_user`,
`local_group_membership`, `scheduled_task`, `cng_key`, `event_log_source`, `windows_setting`,
`third_party_component`, `arp_entry`.

**Rule for every later Windows slice** (RDP Wrapper, Netclient, managed users, firewall gate, Status autostart,
Windows settings such as `fDenyTSConnections`): make every machine change through `ManifestRunner.Apply(kind, id,
spec)` in `apps/cloudbox-agent/Install/`. Never write to the machine around the manifest; never put secrets
(passwords, tokens) in `spec`. Registry values whose prior type cannot be restored exactly are refused before any
change is made.

## Recovery

- Uninstall reports `failed` for an entry → fix the cause (e.g. a locked file) and run `uninstall` again; completed
  entries report `missing`.
- `verify-clean` reports `REMAINS` after a successful uninstall → paste both outputs and the report JSON into the
  issue log; that is a Slice 2.5 bug.
