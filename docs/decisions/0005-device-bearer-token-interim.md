# ADR 0005 — Device authentication: opaque bearer token (interim)

**Status:** Proposed (upgrade path to signed requests in Phase 4)  
**Date:** 2026-09-26  
**Context:** Slice 2.3 enrollment, Agent API heartbeat  
**Stakeholders:** WT-0, WT-3, WT-4, WT-8 (Security review)

## Problem

Enrolled devices must authenticate subsequent API calls (heartbeat, entitlement fetch, commands). Requirements:
- Proof of device identity without every request signing
- Single-use enrollment prevents token reuse across devices
- Token revocation on device offboarding/uninstall
- Upgrade path to TPM-signed requests (Phase 4) without breaking earlier devices

## Decision

**Phase 1–3: Opaque bearer token stored in `device_credentials`.**

1. **Issuance:** Upon enrollment (Slice 2.3), server generates random token and stores SHA-256 hash in `device_credentials`.

2. **Format:** `Authorization: Bearer <random-hex-128>` (128 bits random via `crypto.getRandomValues`)

3. **Storage:** Only hash stored (`device_credentials.token_hash`). Device stores cleartext locally (encrypted at rest with DPAPI on Windows).

4. **Verification:** Device sends cleartext; server hashes and compares against stored hash (same as password verification).

5. **Revocation:** On uninstall (Slice 2.5), device calls `POST /api/v1/agent/uninstalled`; server marks token revoked in D1 and updates device status to "revoked".

6. **Audit:** Every token issue/revocation logged as `DEVICE_CREDENTIAL_ISSUED` / `DEVICE_CREDENTIAL_REVOKED`.

7. **Phase 4 upgrade:** ADR 0005-phase-4 (future) will add TPM-signed request capability. Devices with TPM will use signed requests; bearer tokens remain valid fallback for software-only devices or interop.

## Alternatives considered

- **Mutual TLS:** Certificate-based auth (added complexity, certificate rotation overhead, no intermediate phase)
- **Session tokens:** Like human sessions but device-specific (identical to bearer token, just renamed)
- **API key model:** Long-lived key per device (no security improvement; same revocation problem)

## Consequences

**Positive:**
- Simple to implement (standard HTTP Bearer scheme)
- No cryptography complexity in Phase 1
- Revocation is immediate (device never needs old token again)
- Audit trail is complete (issue/revoke logged)

**Risks:**
- **Token exposure:** If cleartext token is exfiltrated, attacker can impersonate device. Mitigation: Windows DPAPI encryption + ACLs on storage location.
- **No proof of possession:** Token alone doesn't prove the holder has the device's private key. Mitigation: Phase 4 will add signed requests; bearer tokens marked lower assurance in logs.
- **Long-lived credentials:** Token valid for device lifetime or until revocation. Mitigation: Token rotation in Phase 4; Phase 1 accepts this trade-off for simplicity.

## Implementation notes

- `device_credentials` schema: `(id, device_id FK, token_hash UNIQUE, created_at, revoked_at)`
- Token generation: `crypto.getRandomValues(new Uint8Array(16))` encoded as hex
- Hash: SHA-256 via Web Crypto API
- Device storage: `C:\ProgramData\CloudBox\device-token.enc` (DPAPI-encrypted)
- Middleware: `requireDeviceToken()` in Agent API routes (Slice 2.3 client)
- Revocation: timestamp `revoked_at` set; checks skip revoked tokens

## Phase 4 migration notes

- Signed requests will use device private key (TPM or software)
- Bearer token fallback will remain for non-TPM devices
- Audit event `DEVICE_CREDENTIAL_REVOKED` on token refresh/rotation
- No forced migration; old tokens remain valid until explicit revocation

## See also

- Slice 2.3 — One-time enrollment
- Spec §29 Agent API contract
- ADR 0005-phase-4 (future): device request signing
- WT-8 security review: token storage and cleartext exposure
