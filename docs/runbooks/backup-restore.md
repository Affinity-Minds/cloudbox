# Runbook: Backup and Restore

**Owner:** WT-9 (Phase 9)  
**Phase:** Phase 9  
**Status:** Skeleton (not yet implemented)

## Purpose

Guide for performing application-consistent backups and verified restore procedures.

## Prerequisites

- CloudBox device operational and licensed
- Separate local backup target available (optional but recommended)
- Offsite storage configured and reachable

## Procedure

### 1. Initiate backup

*To be implemented by WT-9*

- Manual trigger via Device → Backups tab, or scheduled automatic backup
- Capture application state (application-dependent; see notes)
- Upload to offsite storage after local completion

### 2. Verify backup

*To be implemented by WT-9*

- Check hash/checksum after upload
- Log backup metadata (size, date, application version)

### 3. Restore from backup

*To be implemented by WT-9*

- Select backup from list via Device → Backups → Restore
- Restore to controlled location (do not overwrite live data automatically)
- Verify application opens and reads data correctly

### 4. Verify restore with business application

*To be implemented by WT-9*

- Open application with restored data
- Confirm data integrity (sample records, calculations, reports)
- Document verification steps and results

## Troubleshooting

*To be filled during implementation*

- **Backup failed:** Check disk space, Agent logs, network connectivity
- **Restore failed:** Verify backup artifact intact, destination writable
- **Application fails to open restored data:** Verify application version compatibility

## References

- Spec Section 56, Phase 9 — Backup and restore
- Spec §9.6–9.7 guided restore and restore drill
