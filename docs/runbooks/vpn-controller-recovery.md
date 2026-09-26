# Runbook: VPN Controller Recovery (NetBird SaaS/Self-Hosted)

**Owner:** WT-9  
**Phase:** Phase 6  
**Status:** Skeleton (not yet implemented)

## Purpose

Guide for recovering or reconstructing the NetBird control plane if it becomes unavailable or corrupted.

## Prerequisites

- SSH access to NetBird VPS
- Nightly backup of `/var/lib/netbird` available
- Docker/compose tools available

## Procedure

### 1. Detect controller failure

*To be implemented by monitoring*

- Worker health check fails (VPS unreachable)
- New device enrollments fail
- New Connect client logins fail
- Existing peers with direct paths remain connected

### 2. Assess damage

*To be implemented by operations*

- SSH to VPS
- Check service status: `docker compose ps`
- Inspect logs: `docker compose logs management` / `signal` / `relay`
- Check management store: `ls -la /var/lib/netbird/`

### 3. Restore from backup

*To be implemented by operations*

- If corruption detected: restore latest clean backup
- Stop compose: `docker compose down`
- Restore: `cp -r /backups/netbird-latest/* /var/lib/netbird/`
- Restart: `docker compose up -d`
- Verify all services healthy: `docker compose ps`

### 4. Resync policies

*To be implemented by WT-0/WT-9*

- Policies are stored in CloudBox D1 (source of truth, not NetBird)
- After controller restart, Worker re-publishes all policies to NetBird
- Verify groups recreated: `netctl list groups`
- Verify policies recreated: `netctl list policies`

### 5. Verify peer connectivity

*To be implemented by operations*

- Issue a setup key: `netctl create setup-key --one-off`
- Enroll a test peer
- Verify peer can reach other peers in its network
- Revoke test setup key

## Failover to HA (post-Alpha)

*To be implemented by WT-9+*

- Multi-VPS HA setup with secondary backup and failover DNS
- Documented in separate ADR (future)

## References

- ADR 0007 — NetBird self-hosted
- ALPHA_v0.1.md WT-9 brief (NetBird deployment)
