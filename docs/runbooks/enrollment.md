# Runbook: Device Enrollment

**Owner:** WT-3, WT-4  
**Phase:** Phase 2  
**Status:** Skeleton (not yet implemented)

## Purpose

Guide for enrolling a CloudBox device into the SaaS platform. This runbook covers Super Admin token generation, device setup, and verification.

## Prerequisites

- CloudBox SaaS accessible (https://box.affinity.ai.in)
- Super Admin privileges
- Windows machine prepared for CloudBox installation
- CloudBox.Server.Setup.exe available (from CI artifacts)

## Procedure

### 1. Generate enrollment token (SaaS console)

*To be implemented by WT-3*

- Navigate to Tenant → Enrollment Tokens
- Click "New Token"
- Provide label (e.g., "Lab Box 1")
- Note expiry default (24 hours, configurable)
- Copy token

### 2. Run device setup

*To be implemented by WT-4*

- Run `CloudBox.Server.Setup.exe` on Windows machine
- Paste enrollment token when prompted
- Configure device name (or accept auto-generated)
- Confirm installation location

### 3. Verify enrollment

*To be implemented by WT-3*

- Return to SaaS console
- Refresh Fleet table
- New device appears with status `enrolled`, online = true (after 1st heartbeat, ~60 s)
- Click device row to verify device_id, public key thumbprint, enrollment time

### 4. Issue initial subscription

*To be implemented by WT-5*

- Navigate to Tenant → Subscriptions
- Select subscription covering new device
- Click "Issue License"
- Select new device from list
- Verify entitlement generation and issue timestamp in Device detail → License tab

## Troubleshooting

*To be filled during implementation*

- **Token not found or expired:** Generate new token, confirm expiry
- **Device not appearing in Fleet:** Check Agent logs, verify heartbeat endpoint reachable
- **License not issued:** Verify subscription active, device count not exceeded

## Rollback

*To be filled during implementation*

If enrollment fails or device needs re-enrollment:
- Delete device via UI (if implemented)
- Revoke enrollment token (if reuse needed)
- Run uninstall on device (see `windows-disaster-recovery.md`)
- Repeat procedure

## References

- Spec Section 56, Slice 2.3 — One-time enrollment
- Agent API contract (spec §29)
- Device enrollment token schema (foundation.md `enrollment_tokens` table)
