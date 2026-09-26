# Open questions

Only record issues that genuinely require human or external resolution. Routine implementation choices are not questions.

## Owner Inputs (Resolved, 2026-09-26 23:00 IST)

These items were outstanding until owner confirmation. All now resolved:

1. **OTP email service:** Confirmed = Cloudflare Email Service (`send_email` binding), sending domain `em.affinity.ai.in`, from address `no-reply@em.affinity.ai.in`. Verified public DNS records (SPF, DKIM, DMARC) confirm onboarding. Owner must verify in dashboard: domain and Email Sending in same Cloudflare account; `soren@affinityminds.net` added as verified destination.

2. **Bootstrap super admin:** Confirmed = `soren@affinityminds.net`. First login with this email receives Super Admin role automatically; all other staff roles are audited grants.

3. **Windows machine available:** Confirmed. Physical CloudBox machine exists for Phase 2 enrollment testing and Phase 6 acceptance (two concurrent RDP sessions).

4. **Uninstaller in scope:** Confirmed. New Slice 2.5 (WT-4 owns) reverses every install step via manifest, restores pre-install state. Customer data in `D:\CloudBoxData` never deleted unless `--purge-data` with typed machine name (logged as SECURITY).

5. **Cloudflare account token:** If custom-domain provisioning fails on first deploy, org Cloudflare token needs Zone:DNS:Edit on `affinityminds.in`. To verify during bootstrap.

## Current

- Commercial release requires a complete third-party inventory for RDP Wrapper/TermWrap dependencies and the network runtime. (See THIRD_PARTY_NOTICES.md for initial inventory; to-verify items noted.)
- Windows code-signing certificate/provider will be selected before signed installer release.
- Transactional email provider confirmed (Cloudflare Email Service); dev echo via `OTP_DEV_ECHO=1`.
- WireGuard and Wintun exact licenses: to verify during Phase 6 implementation.
- All npm/NuGet packages: to inventory after foundation and WT-4 baseline commits.
