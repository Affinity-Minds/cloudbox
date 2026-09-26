# CloudBox Provider Support and Break-Glass Access

This document provides orientation to emergency support access procedures.

## Quick Links

- **Support Access Runbook:** [docs/runbooks/break-glass.md](runbooks/break-glass.md)
- **Standing Support Model (ADR 0008):** [docs/decisions/0008-standing-support-access.md](decisions/0008-standing-support-access.md)
- **Full Break-Glass Specification:** See spec Section 21 and ALPHA_v0.1.md

## Overview

CloudBox implements standing support access for Super Admin members. This means:

- **No per-session approval required** for routine support work
- **Every access is visible** to the customer (Status app shows "Provider support access in use")
- **Every retrieval is audited** (`SUPPORT_CREDENTIAL_RETRIEVED` event)
- **Credentials rotate** automatically on each retrieval (no reuse across machines)

## Super Admin Support Access

### Retrieve credential

1. Navigate to Device detail in CloudBox SaaS
2. Click "Support Access" tab
3. Complete fresh OTP step-up verification
4. Click "Retrieve Credential"
5. Copy plaintext credential (one-time display, not recoverable)

### Connect

- Use `cbx-support` local administrator account with credential via RDP
- Connection routed through private NetBird mesh (if Phase 6 active)
- Connection is visible to customer

### Session closure

- Disconnect RDP when complete
- Customer Status app shows support access inactive
- Next retrieval generates new credential

## Sensitive Operations

For high-risk remediation (e.g., data access, configuration changes):
- Request customer approval before proceeding
- Document reason and actions in audit log
- Provide summary to customer after session

## Offline Emergency Access (Phase 4+)

When cloud is unavailable and device is offline:
- Requires machine-specific rescue entitlement (not a universal master password)
- See spec Section 21.6 (Offline emergency path)
- Documented in separate runbook after implementation

## Audit and Compliance

All support access is logged:
- `SUPPORT_CREDENTIAL_RETRIEVED` — timestamp, user, reason
- `SUPPORT_SESSION_ACTIVE` — device, session_id, duration
- `SUPPORT_SESSION_CLOSED` — closure reason if applicable

Customer can inspect audit log via Tenant → Audit tab.

## References

- ADR 0008: Standing support access via credential broker
- ALPHA_v0.1.md: Owner support decision
- Spec Section 21: Break-glass and emergency access model
