# Runbook: Tenant Offboarding

**Owner:** WT-0 (coordination)  
**Phase:** Phase 1+  
**Status:** Skeleton (not yet implemented)

## Purpose

Guide for gracefully offboarding a tenant from CloudBox SaaS, including subscription suspension, device revocation, and data retention.

## Prerequisites

- Super Admin privileges
- Tenant status known (active, past_due, etc.)
- Backup of customer data exported (if contracted)

## Procedure

### 1. Notify tenant

*To be implemented by support/operations*

- Provide offboarding notice per contract terms
- Outline data retention and device revocation timeline

### 2. Cancel/suspend subscription

*To be implemented by WT-5*

- Navigate to Tenant → Subscriptions
- Click subscription
- Select "Cancel" or "Suspend"
- Document reason

### 3. Disable SaaS access

*To be implemented by WT-1/WT-2*

- Revoke all tenant memberships for active staff
- Revoke Super Admin seats (if any)
- Disable tenant login via status flag (if implemented)

### 4. Revoke device entitlements

*To be implemented by WT-5*

- Issue revocation for all active entitlements in tenant
- Devices will detect license revocation on next heartbeat
- Manage-RDP sessions blocked (per spec)

### 5. Revoke network access

*To be implemented by WT-9*

- Delete tenant network from NetBird (if Phase 6 active)
- Revoke all Connect client credentials

### 6. Preserve and archive data

*To be implemented by WT-9/backup*

- Export customer backups to customer-provided storage (if contracted)
- Archive audit logs, metadata in cold storage
- Mark tenant as "archived" in SaaS DB

### 7. Final cleanup

*To be implemented by WT-0*

- Delete all device records (if contracted; else retain for dispute resolution)
- Delete tenant membership records
- Audit log remains (append-only)

## Rollback

*To be filled during implementation*

If offboarding is reversed before cutover:
- Re-activate subscription
- Restore entitlements
- Restore network access

## References

- Spec Section 53 — Tenant Offboarding
- Tenant lifecycle (foundation.md `tenants` table, status field)
