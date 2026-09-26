# Runbook: Licensing Key Rotation

**Owner:** WT-5  
**Phase:** Phase 3  
**Status:** Skeleton (not yet implemented)

## Purpose

Guide for rotating entitlement signing keys and managing subscription lifecycle (renewal, upgrade, downgrade).

## Prerequisites

- CloudBox SaaS accessible
- Super Admin privileges
- Key management infrastructure operational

## Procedure

### 1. Schedule key rotation

*To be implemented by WT-5*

- Determine rotation interval (default: 90 days, configurable)
- Generate new signing key
- Mark current key as "active"

### 2. Issue new entitlements

*To be implemented by WT-5*

- Existing devices continue to use current key
- New entitlements use new key

### 3. Retire old key

*To be implemented by WT-5*

- Mark old key as "retired" after transition period
- Devices with old entitlements still validate (key in JWE header)

### 4. Manage subscriptions

*To be implemented by WT-5*

- Renewal: extend `valid_until` date, maintain plan/slots
- Upgrade: change to higher-tier plan, issue new entitlements
- Downgrade: change to lower-tier plan, audit user slots if needed

## Troubleshooting

*To be filled during implementation*

- **Key not rotating:** Check signing_keys table, verify new key generated
- **Entitlements failing with old key:** Verify device public key and issuer match

## References

- Spec Section 56, Slice 3.1 — Subscriptions
- Entitlement signing (spec §9.3, ADR 0005 interim tokens)
- `signing_keys` table schema (foundation.md)
