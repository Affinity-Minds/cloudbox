# ADR 0008 — Standing support access via credential broker (overrides Spec §21.1)

**Status:** Proposed (Phase 5, WT-10; reviewed by WT-8 before merge)  
**Date:** 2026-09-26  
**Context:** Alpha 1 and production support model  
**Stakeholders:** Owner (decision authority per spec §0.1), WT-0, WT-8, WT-10

## Problem

Spec §21 ("Super Admin Emergency RDP") requires explicit break-glass request/approval for every support access, with automatic expiry. Owner feedback (2026-09-26):

> "Super admin group always has access for maintenance and work"

This overrides spec §21.1 ("disabled by default"). Requirements:
- Provider (Super Admin) can access customer machines for support without per-session approval friction
- Access must be visible and audited (customer awareness)
- Access must be revoked when not in use (not a permanent door)
- Credential rotation prevents credential reuse across machines

## Decision

**Standing support access via credential broker.**

### Access model

1. **Super Admin group:** Automatically enrolled as `cbx-support` peer in every NetBird tenant network (Phase 6, WT-9).

2. **Windows login:** Server Setup (Phase 5, WT-10) creates local administrator `cbx-support` per device.
   - Credential: random per-device (e.g., 32-byte base64-encoded)
   - Storage: encrypted in D1 via `crypto.subtle.encrypt` (AES-GCM) with master key as Wrangler secret
   - Rotation: refreshed on every retrieval (no cached plaintext)

3. **Retrieval flow (Super Admin only):**
   - Super Admin navigates to Device → Support Access
   - Completes fresh OTP step-up (security gate)
   - Clicks "Retrieve Credential"
   - Server logs `SUPPORT_CREDENTIAL_RETRIEVED` (audit event with timestamp, reason if provided)
   - Super Admin sees plaintext credential (one-time display, not recoverable)
   - Credential used for RDP or command-line access
   - Next retrieval generates new random credential (old one invalid)

4. **Visibility:**
   - Status app shows "Provider support access in use" while a `cbx-support` session is open
   - Detected via Windows API (RDP session enumeration) or agent heartbeat
   - Customer sees clear indication; not hidden

5. **Automation:**
   - No approval loop required (stands in contrast to spec §21.2 break-glass flow)
   - Logging is the control (every retrieval and session is audited)
   - Revocation: disable `cbx-support` account locally (Device → Revoke Support, immediate effect)

### Credential vault design

- **Master key:** Wrangler secret `SUPPORT_CREDENTIAL_VAULT_KEY` (32-byte KDF output or similar)
- **Per-device storage:** `support_credentials` table:
  ```
  (device_id, credential_hash, encrypted_credential, created_at, retrieved_at, revoked_at)
  ```
  - `credential_hash`: SHA-256 of plaintext (for lookups)
  - `encrypted_credential`: `crypto.subtle` AES-GCM output
  - `retrieved_at`: timestamp of last retrieval (null = never retrieved)
- **Rotation logic:**
  - On retrieval: if current_time - created_at > 30 days, auto-rotate (generate new)
  - On explicit rotation: admin clicks "Rotate Credential Now"
  - Revocation: set `revoked_at`, skip future checks

### Audit trail

- `SUPPORT_CREDENTIAL_RETRIEVED` — device_id, user_id, retrieved_at, reason (optional)
- `SUPPORT_CREDENTIAL_ROTATED` — device_id, rotated_by, reason
- `SUPPORT_CREDENTIAL_REVOKED` — device_id, revoked_by
- `SUPPORT_SESSION_ACTIVE` — device_id, session_start, session_id (from RDP)
- `SUPPORT_SESSION_CLOSED` — device_id, session_id, duration

### WT-8 security review

Before this slice ships, WT-8 (Security) must validate:
- Credential vault encryption adequacy (AES-GCM key derivation, randomness)
- Credential Manager (Windows) storage ACLs (prevent local theft)
- Audit event completeness (session start/stop detection)
- Break-glass escalation (if customer demands strict mode, spec §21.2 remains optional)

## Alternatives considered

- **Spec §21 break-glass strict mode:** Requires explicit approval for every session (operational friction; owner rejected)
- **Permanent local admin:** Create `cbx-support` with fixed password (no rotation; credential reuse risk across machines)
- **RDP gate with no auth:** Allow Super Admin to bypass Windows login entirely (audit trail lost)

## Consequences

**Positive:**
- Operationally simple; support does not wait for approval
- Credential rotation prevents compromise spread across machines
- Audit trail complete (every retrieval, session, revocation logged)
- Customer sees active support sessions (not hidden)
- Backward compatible with spec §21.2 strict mode (optional per tenant/device policy)

**Risks:**
- **Credential exposure:** If plaintext credential leaked during transit or display, attacker gains temporary admin access. Mitigation: HTTPS transport, one-time display, short retention in memory, session timeout on device.
- **Audit log tampering:** If audit table compromised, breach history can be erased. Mitigation: tamper-resistant audit (append-only, external replay, spec §0.3), WT-8 validates.
- **RDP credential reuse:** If same password used for multiple devices, compromise of one affects all. Mitigation: per-device credential enforcement in code; audit catches violations.

## Implementation notes

- Owned by WT-10 (Server Setup, Phase 5) with coordination with WT-9 (NetBird policy)
- Credential vault in D1 under tenant isolation (no cross-tenant leakage)
- Encryption via `crypto.subtle.encrypt` (NIST-approved, platform cryptography)
- UI: Device detail → Support Access tab (Super Admin only)
- Session detection: `quser` command parsing + RDP event log listener on Agent
- Rotation: 30-day default, manual rotation available
- Optional strict mode: future policy engine (WT-11+) can enforce break-glass flow per tenant

## See also

- ALPHA_v0.1.md §Provider support access (owner decision)
- Spec §21 Super Admin Emergency RDP (strict mode remains available as policy option)
- Spec §0.1 item 1 (owner authority to override spec)
- WT-8 security review output (before merge approval)
