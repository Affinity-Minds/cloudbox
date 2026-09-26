# Runbook: Provider Support / Break-Glass Emergency Access

**Owner:** WT-10 (Phase 5)  
**Phase:** Phase 5  
**Status:** Skeleton (not yet implemented)

## Purpose

Guide for Super Admin emergency access to customer CloudBox device without routine approval (standing support model per ADR 0008).

## Prerequisites

- Super Admin privileges
- Device enrolled and online (or offline access procedure)
- Device has local administrator account `cbx-support` registered

## Procedure

### 1. Retrieve support credential

*To be implemented by WT-10*

- Navigate to Device detail
- Click Support Access tab
- Complete fresh OTP step-up
- Click "Retrieve Credential"
- Copy plaintext credential (one-time display)

### 2. Connect via RDP

*To be implemented by WT-10*

- Use CloudBox private mesh (NetBird overlay) if available
- RDP to device using `cbx-support` credential
- Session is visible to customer via Status app ("Provider support access in use")
- Perform diagnostics/remediation

### 3. Close session

*To be implemented by WT-10*

- Disconnect RDP
- Status app shows support access inactive
- Credential automatically rotates on next retrieval

### 4. Escalate if needed

*To be implemented by WT-10*

- For sensitive operations, request customer approval
- Log reason and any changes made
- Close with summary for customer review

## Offline emergency access

*To be implemented by Phase 4*

- Requires machine-bound rescue entitlement (no universal master password)
- Documented in Phase 4 ADR (to be created)

## Troubleshooting

*To be filled during implementation*

- **Credential retrieval fails:** Verify Super Admin permission, OTP succeeded
- **RDP connection fails:** Check network, device online status, firewall

## References

- ADR 0008 — Standing support access via credential broker
- Spec Section 56, Phase 5 (Server setup and RDP runtime)
- Spec Section 21 (break-glass model, optional strict mode)
