# Open questions

Only record issues that genuinely require human or external resolution. Routine implementation choices are not questions.

## Owner inputs (Resolved, 2026-09-26 23:00 IST)

These items were outstanding until owner confirmation. All now resolved:

1. **OTP email service:** Confirmed = Cloudflare Email Service (`send_email` binding), sending domain `em.affinity.ai.in`, from address `no-reply@em.affinity.ai.in`. Verified public DNS records (SPF, DKIM, DMARC) confirm onboarding. Owner must verify in dashboard: domain and Email Sending in same Cloudflare account; `soren@affinityminds.net` added as verified destination.

2. **Bootstrap super admin:** Confirmed = `soren@affinityminds.net`. First login with this email receives Super Admin role automatically; all other staff roles are audited grants.

3. **Windows machine available:** Confirmed. Physical CloudBox machine exists for Phase 2 enrollment testing and Phase 6 acceptance (two concurrent RDP sessions).

4. **Uninstaller in scope:** Confirmed. Slice 2.5 (WT-4 owns) reverses every install step via manifest, restores pre-install state. Customer data in `D:\CloudBoxData` never deleted unless `--purge-data` with typed machine name (logged as SECURITY).

5. **Cloudflare account token:** If custom-domain provisioning fails on first deploy, org Cloudflare token needs Zone:DNS:Edit on `affinity.ai.in`. To verify during bootstrap.

6. **VPN self-hosting:** Confirmed. NetBird v0.79.0 self-hosted on customer VPS. Management and signal servers run in a Docker Compose stack. See ADR 0007 and handoff WT-9 for architecture.

7. **RDP Wrapper licensing:** Confirmed. Direct commercial license agreement with author (Sergiy Egoshyn). Permission to redistribute and embed in Setup.exe. Evidence held by project owner. See `THIRD_PARTY_NOTICES.md`.

## Current

### License key batch pricing

Unresolved: whether add-on user pricing is fixed per plan or per batch. Current implementation stores pricing at plan level only. If batch-level pricing override is needed, schema change required to `license_keys` and `entitlements` tables. **Decision needed before Phase 3 feature freeze.**

### Connect timing parity

Unresolved: whether Connect sign-in latency should match web sign-in. Current implementation uses the same rate limits and email backend. Latency differs due to different code paths and device authentication overhead. **Measure and benchmark during Phase 6 acceptance.**

### Owner role transfer

Unresolved: ownership transfer from one tenant member to another (e.g., when original contact leaves). Current state allows demotion of any owner except the last one; no transfer primitive. **Product decision: add a dedicated transfer flow or require creation of a new Owner and demotion of old one?**

### RDP Wrapper AV risk

Known risk: RDP Wrapper patches Windows kernel RDP module at runtime. Some antivirus software flags this as suspicious. Mitigation: code-signing the Setup.exe (before Phase 5). **Status: awaiting code-signing certificate selection.**

### Third-party inventory completion

Resolved items:
- npm packages: inventoried from pnpm-lock.yaml (see THIRD_PARTY_NOTICES.md).
- NuGet packages: inventoried from .csproj files (see THIRD_PARTY_NOTICES.md).
- NetBird v0.79.0: verified BSD-3-Clause (bundled).
- RDP Wrapper v2.15: commercial license agreement confirmed.
- WireGuard and Wintun: exact licenses **to verify** before Phase 6 release (expected GPL-compatible, but confirm upstream).

## Resolved

The following items were questions but are now settled:

- **License key generation and redemption:** Implemented in WT-14 (Phase 2). Keys are offline-first; one key + device activation binds a subscription.
- **Self-service onboarding:** Implemented in WT-14 (Phase 2). Customers can create tenants and enroll devices via activation codes.
- **Plan pricing:** Implemented in WT-10 (Phase 2). Plans have base price + add-on user pricing. Currencies: INR, USD, EUR, GBP, AED (configurable per plan).
- **Device revocation:** Implemented in Phase 2. Staff can revoke devices; entitlements are invalidated on next heartbeat.
- **Audit trail:** Implemented in Phase 1. Every state change audited immutably in `audit_log` table.
