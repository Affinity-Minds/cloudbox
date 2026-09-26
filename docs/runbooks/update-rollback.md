# Runbook: Update and Rollback

**Owner:** WT-10 (Phase 10)  
**Phase:** Phase 10  
**Status:** Skeleton (not yet implemented)

## Purpose

Guide for performing OTA updates to CloudBox components and rolling back if needed.

## Prerequisites

- Update channel configured (Development/Pilot/Stable/Pinned)
- Update manifest signed and published
- Recovery package available before update

## Procedure

### 1. Initiate update

*To be implemented by WT-10*

- Download signed update package
- Verify signature and hash
- Stage package locally
- Ensure recovery mechanism ready

### 2. Apply update

*To be implemented by WT-10*

- Stop affected component
- Install package to target location
- Restart and health-check
- Commit success if healthy

### 3. Monitor Pilot rollout

*To be implemented by WT-10*

- Limit to small device cohort initially
- Monitor health metrics (agent responsiveness, errors)
- Promote to Stable channel if green

### 4. Rollback if needed

*To be implemented by WT-10*

- If health gate fails, revert to last known-good package
- Restore configuration from prior state
- Restart and verify

## Troubleshooting

*To be filled during implementation*

- **Update fails verification:** Retry download, check network
- **Rollback needed:** Inspect logs for failure reason, decide on re-attempt

## References

- Spec Section 56, Phase 10 — OTA update system
- Spec §10.3 update channels (Development, Pilot, Stable, Pinned)
