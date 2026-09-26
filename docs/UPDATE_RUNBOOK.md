# CloudBox Update and Rollback Runbook

This document provides links to update procedures.

## Quick Links

- **Full Update Runbook:** [docs/runbooks/update-rollback.md](runbooks/update-rollback.md)
- **OTA System Specification:** See spec Section 56, Phase 10

## Update Channels

CloudBox supports four update channels:

1. **Development** — Latest builds, frequent changes, unstable
2. **Pilot** — Vetted in small cohort, health-gated before promotion
3. **Stable** — Production-ready, validated across fleet
4. **Pinned** — Customer-specific version lock, no automatic updates

## Pilot Rollout

Updates are promoted in stages:

1. Developers build new version
2. Deploy to Pilot channel
3. Monitor health metrics (agent responsiveness, errors, restarts)
4. After health gate pass, promote to Stable
5. Existing devices update on their configured schedule

## Rollback

If a Pilot or Stable update fails:

1. Health checks fail post-update
2. Agent detects unhealthy state
3. Agent automatically reverts to prior version
4. Prior version restarted and verified healthy
5. Failure logged for analysis

## Manual Update

Super Admin can manually trigger update:

1. Navigate to Device → Updates
2. Click "Check for Updates"
3. If available, click "Install Now"
4. Agent downloads, verifies, and applies
5. Device reboots if required (respects maintenance window policy)

## References

- Spec Section 10: OTA / self-update system
- Spec §10.3: Update channels
- Spec §10.5–10.6: Transactional updater and rollback
