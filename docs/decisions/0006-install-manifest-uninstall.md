# ADR 0006 — Reversible install via manifest; uninstall and --purge-data

**Status:** Proposed (binding on all Windows slices)  
**Date:** 2026-09-26  
**Context:** Slice 2.1 Agent skeleton, Slice 2.5 Uninstaller (Phase 2)  
**Stakeholders:** WT-0, WT-4 (Agent), WT-10 (Server Setup)

## Problem

**Owner requirement:** CloudBox.Agent.exe must uninstall to the exact pre-installation state. Customer data is never deleted unless explicitly requested with `--purge-data`. Requirements:
- Every install action is reversible (transactional)
- Uninstall restores prior state (registry, firewall, users, groups, services, keys)
- Proof of clean removal via `verify-clean` command
- Customer data in `D:\CloudBoxData` untouched unless `--purge-data` typed
- Every later Phase 5–6 component registers into manifest (binding on all Windows slices)

## Decision

**Install manifest-driven reversible uninstall.**

1. **Manifest:** Transactional JSON file at `C:\ProgramData\CloudBox\install-manifest.json`. Every install step appends entry before taking effect:
   ```json
   {
     "entries": [
       {
         "kind": "service",
         "id": "CloudBoxAgent",
         "createdAt": "2026-09-26T12:34:56Z",
         "priorState": null
       },
       {
         "kind": "registry_value",
         "id": "HKLM\\System\\CurrentControlSet\\Services\\CloudBoxAgent\\ImagePath",
         "createdAt": "2026-09-26T12:34:56Z",
         "priorState": null
       }
       // ... more entries
     ]
   }
   ```

2. **Supported entry kinds:**
   - `service` — stopped/deleted
   - `directory` — deleted recursively
   - `file` — deleted
   - `registry_key`, `registry_value` — deleted or restored
   - `firewall_rule` — removed
   - `local_user`, `local_group_membership` — removed or restored
   - `scheduled_task` — deleted
   - `cng_key` — deleted via CNG API
   - `event_log_source` — deregistered
   - `windows_setting` — restored (e.g., `fDenyTSConnections`)
   - `third_party_component` — uninstalled via embedded command
   - `arp_entry` — removed

3. **Uninstall:** `CloudBox.Agent.exe uninstall [--purge-data] [--keep-logs] [--offline]`
   - Replays manifest in **reverse** order
   - Restores every `priorState` where applicable
   - Prints verification report (each entry: removed/restored/missing)
   - If `--offline`: skips cloud notification, best effort only
   - If `--purge-data`: **only then** deletes `D:\CloudBoxData` + backup folders (requires typed machine name confirmation, logged as SECURITY event)
   - Finally deletes `C:\ProgramData\CloudBox` and `C:\Program Files\CloudBox`
   - Last step: self-delete via detached `cmd /c ping -n 3 127.0.0.1 >nul & del`

4. **Verification:** `CloudBox.Agent.exe verify-clean`
   - Checks for any manifest kinds still present (service, directory, registry, firewall, user, group, key, task, ARP entry)
   - Exits non-zero if any found (acceptance test on lab machine)

5. **Cloud notification:** On uninstall, device calls `POST /api/v1/agent/uninstalled` (best effort); server logs `DEVICE_UNINSTALLED` audit event, marks device status "revoked".

6. **Binding:** Every future Phase 5+ component (RDP Wrapper, managed users, firewall gate, backup scheduler, update worker, Netclient, Connect client registration) must add its own manifest entries **before** taking effect.

## Alternatives considered

- **Snapshot restore:** Back up machine state before install (infeasible for production customer machines)
- **Hard-coded cleanup list:** No prior state tracking; cannot restore to exact pre-install (violates owner requirement)
- **Ad hoc script:** Each component ships own uninstall logic (coordination nightmare, impossible to guarantee clean removal)

## Consequences

**Positive:**
- Complete audit trail of every install action
- Guaranteed clean removal to original state (testable via verify-clean)
- Customer data only deleted if explicitly confirmed
- Every future component author has clear contract (add manifest entries)
- Failure recovery: uninstall always has baseline knowledge of what was installed

**Risks:**
- **Manifest corruption:** If JSON corrupted, uninstall may fail. Mitigation: validate manifest on load; keep backup copy.
- **Prior state capture accuracy:** Capturing exact registry value (not just key) requires careful logic. Mitigation: log every write; test on clean Windows build.
- **Permission race:** If user manually deletes file during uninstall, manifest may reference missing paths. Mitigation: verify before delete; log as warning; continue.

## Implementation notes

- Manifest written transactionally: write temp file, then atomic rename
- Entry format includes priorState (null if new, prior value if modified)
- Uninstall reads manifest, replays in reverse order
- Each entry has kind-specific restoration logic
- Audit event: `INSTALLATION_MANIFEST_CREATED`, `DEVICE_UNINSTALLED` (with manifest SHA for verification)
- WT-4 implements Phase 2 entries (service, directories, registry, CNG keys, ARP)
- WT-10 (Server Setup, Phase 5) adds RDP Wrapper, managed users, firewall rules, VC++ redist
- WT-11 (Connect client, Phase 6) adds Connect app directory, registry entries, uninstall entry in Add/Remove Programs
- Every slice reviews manifest entries in its handoff

## See also

- Slice 2.1 — Windows Agent skeleton
- Slice 2.5 — Uninstaller (Phase 2, owned by WT-4)
- PLAN_5AM.md §10 uninstall contract
- ALPHA_v0.1.md WT-10 brief (RDP Wrapper integration)
