# CloudBox Backup and Restore Runbook

This document provides links to backup and restore procedures.

## Quick Links

- **Full Backup/Restore Runbook:** [docs/runbooks/backup-restore.md](runbooks/backup-restore.md)
- **Backup System Specification:** See spec Section 56, Phase 9

## Overview

CloudBox performs application-consistent backups of customer business application data and maintains local + offsite redundancy.

## Backup Process

1. **Local backup** — Agent backs up application data (application-dependent, not raw file copy)
2. **Verification** — Backup integrity checked locally
3. **Upload** — Completed backup uploaded to offsite storage after local success
4. **Retention** — Oldest backups automatically purged per policy

## Restore Process

1. **Select backup** — Choose from available restore points via Device → Backups tab
2. **Restore locally** — Restore to controlled location (does not overwrite live data)
3. **Verify integrity** — Application opens restored data successfully
4. **Promote to live** — Customer/admin confirms restore and applies to production (if desired)

## Scheduling

Backups can be:
- **Automatic** — Configured on Tenant → Device policy, respects maintenance windows
- **Manual** — Triggered on-demand via Device → Backups → "Run Backup Now"

## Disaster Recovery Checklist

For a failed machine:

1. Install CloudBox on replacement hardware
2. Enroll device to same tenant
3. Verify entitlements issued
4. Restore latest backup via Device → Backups → Restore
5. Verify application and data integrity
6. Resume operations

## References

- Spec Section 9: Business application backup and restore
- Spec §9.7: Restore drill (backup not accepted until restore tested)
