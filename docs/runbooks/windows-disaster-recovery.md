# Runbook: Windows Disaster Recovery (CloudBox Uninstall / Clean Slate)

**Owner:** WT-4  
**Phase:** Phase 2  
**Status:** Skeleton (not yet implemented)

## Purpose

Guide for completely removing CloudBox from a Windows machine and restoring it to pre-installation state. Includes recovery procedures if Agent is unresponsive.

## Prerequisites

- Local administrator access to Windows machine
- CloudBox.Agent.exe available (from earlier installation or CI)
- Install manifest at `C:\ProgramData\CloudBox\install-manifest.json` (if normal uninstall possible)

## Normal Uninstall

### 1. Graceful shutdown

*To be implemented by WT-4*

```cmd
cd C:\Program Files\CloudBox
CloudBox.Agent.exe uninstall
```

- Agent reads manifest in reverse order
- Removes every installed component
- Restores prior state (registry, users, firewall, etc.)
- Deletes CloudBox directories
- Prints verification report
- Self-deletes

### 2. Verify clean

*To be implemented by WT-4*

```cmd
CloudBox.Agent.exe verify-clean
```

- Scans for any remaining CloudBox artifacts
- Exits 0 if clean, non-zero if found
- Output lists any found artifacts for manual removal

## Offline Uninstall (Agent Unresponsive)

### 1. Manual manifest replay

*To be implemented by WT-4*

- Read manifest at `C:\ProgramData\CloudBox\install-manifest.json`
- Replay entries in reverse manually:
  - `service`: `sc delete CloudBoxAgent`
  - `registry_value`: `reg delete HKLM\...`
  - `firewall_rule`: `netsh advfirewall firewall delete rule name="CloudBox..."`
  - `local_user`: `net user cbx-support /delete`
  - `cng_key`: PowerShell: `Remove-Item -Path Microsoft-Cert:\CurrentUser\My\<thumbprint>`

### 2. Delete directories

```cmd
rmdir /s /q "C:\ProgramData\CloudBox"
rmdir /s /q "C:\Program Files\CloudBox"
```

### 3. Verify clean

```cmd
:: Check for Service
sc query CloudBoxAgent

:: Check for User
net user | findstr cbx-support

:: Check for ARP entry (CloudBox.Agent)
wmic product list brief | findstr CloudBox

:: Check registry
reg query "HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall" | findstr CloudBox
```

## Data Preservation

### Default behavior

- Customer business data in `D:\CloudBoxData` (or configured backup target) **NOT deleted**
- Windows user profiles and documents **NOT deleted**
- Only CloudBox-specific components removed

### With --purge-data (explicit)

```cmd
CloudBox.Agent.exe uninstall --purge-data
```

- Requires typed machine name confirmation (prevents accidental deletion)
- Deletes `D:\CloudBoxData` and all backups
- Logged as SECURITY event
- Use only if customer explicitly requests data deletion

## Troubleshooting

*To be filled during implementation*

- **Manifest missing or corrupted:** Use offline uninstall with manual replay
- **Service fails to stop:** Kill process, then proceed with deletion
- **Registry keys in use:** Restart required before full cleanup

## Recovery

If uninstall is incomplete or failed:
- Manually remove artifacts using offline procedure above
- Re-run verify-clean until clean
- Contact support if ambiguous artifacts remain

## References

- ADR 0006 — Install manifest uninstall
- Spec Section 56, Slice 2.5 — Uninstaller (Phase 2)
