# ADR 0007 — Private mesh via NetBird self-hosted (supersedes Spec §4.8 Netmaker)

**Status:** Proposed (Phase 6, WT-9)  
**Date:** 2026-09-26  
**Context:** Alpha 1 milestone, Phase 6 private network  
**Stakeholders:** Owner, WT-0, WT-9 (Private mesh)

## Problem

CloudBox requires a self-hosted private network overlay for Connect clients to securely reach CloudBox servers without public Internet RDP. Spec §4.8 specified Netmaker CE, but requirements shifted:
- No third-party SaaS dependency (Netmaker Cloud blocks relay/failover in CE)
- Owner has VPS available for control plane
- Need tenant-scoped network isolation
- Relay/failover critical for field deployments

## Decision

**Use NetBird open-source v0.79.0 (or later stable), self-hosted on owner's VPS.**

### NetBird selection rationale

1. **Licensing:** Verified from NetBird GitHub (2026-09-26):
   - Server components (`management/`, `signal/`, `relay/`) are **AGPLv3**
   - Client (Windows Netclient, iOS, Android, Linux) is **BSD-3-Clause**
   - AGPLv3 server components impose no obligation on CloudBox code (we use REST API, not link/embed)

2. **Capabilities:**
   - Management plane: group policies, device enrollment, relay configuration
   - Signal plane: NAT traversal, peer discovery
   - Relay plane: fallback when direct peer connection impossible
   - STUN/TURN: coturn bundled, fully functional in CE
   - IdP: embedded identity provider (or OIDC integration)
   - No feature gatekeeping; CE has everything production needs

3. **Deployment:** Standard compose stack with Traefik + Let's Encrypt:
   ```bash
   curl -fsSL https://github.com/netbirdio/netbird/releases/latest/download/getting-started.sh | bash
   ```
   Produces production-ready compose on a 1 CPU / 2 GB Linux VM (2 / 4 GB recommended).

4. **Infrastructure:**
   - VPS hostname: `net.affinity.ai.in` (DNS points to VPS IP)
   - Ports: TCP 80/443 (Traefik), UDP 3478 (STUN/TURN)
   - Backup: nightly snapshots of `/var/lib/netbird` (management store, identity DB)
   - HA failover: post-Alpha (documented setup, separate ADR if added)

### CloudBox integration

1. **Naming:** One network per tenant: `cbx-<tenant-id>`

2. **Policies (managed by CloudBox, not via NetBird UI):**
   - Delete default allow-all policy immediately after bootstrap
   - CloudBox Worker generates policies in D1:
     - Group `cbx-server-<tenant>` (all enrolled Servers for tenant)
     - Group `cbx-client-<tenant>` (all Connect clients for tenant)
     - Group `cbx-support` (support gateway peer)
   - Policy `cbx-client-<tenant> → cbx-server-<tenant>` on port 3389 RDP only
   - Policy `cbx-support → cbx-server-*` on 3389 and Agent management port

3. **Enrollment:**
   - Super Admin creates enrollment key via CloudBox SaaS
   - CloudBox Worker: `POST /api/setup-keys` to NetBird, type `one-off`, `auto_groups=[cbx-server-<tenant>]`, min expires 86400 s
   - Worker revokes after first use
   - Device receives short-lived key over authenticated channel (never in plaintext links)

4. **Client isolation (hard test):**
   - Tenant A peer connects to NetBird with key from Tenant A network
   - Tenant A peer attempts to reach Tenant B peer: denied (policy)
   - Prove via `netbird status --json` and packet capture

5. **Version pinning:** Lock NetBird version in deployment manifest; back up management store nightly.

### Risk: single point of failure

- VPS down: existing peers with direct WireGuard paths keep working
- New logins, new peers, relayed connections stop
- Mitigations:
  - Nightly backup of `/var/lib/netbird`
  - HA setup (documented post-Alpha)
  - Worker monitoring: alert if VPS unreachable

## Alternatives considered

- **Netmaker CE** (spec §4.8): Relay and failover gated to Pro tier; CE governance unclear
- **Tailscale managed:** Third-party dependency; not self-hosted
- **OpenVPN:** Requires manual key exchange; no dynamic group policy
- **Headscale (Tailscale open source):** Simpler, but fewer relay options; existing NetBird relationship

## Consequences

**Positive:**
- Self-hosted; no recurring SaaS fees or vendor lock-in
- Relay/failover fully functional in CE
- OIDC integration available for future identity federation
- Clear license: server AGPL/client BSD-3-Clause
- Tenant isolation enforced at NetBird policy level

**Risks:**
- **Single point of failure:** VPS must be monitored and backed up (owner accepts this for Alpha)
- **Windows client behavior:** Netbird client embeds WireGuard; may conflict with user WireGuard installs (test in lab)
- **AGPL compliance:** If we modify NetBird source, we must publish modifications. Mitigation: use unmodified upstream.

## Implementation notes

- WT-9 owns deployment, policy generator, client adapter
- CloudBox registers policies in D1; Worker pushes to NetBird via REST API
- Agent normalizes `netbird status` to CloudBox health states
- Connect client orchestrates silent Netclient join before RDP
- Setup.exe embeds NetBird Netclient; uninstall removes (Slice 2.5 manifest entry)

## See also

- ALPHA_v0.1.md WT-9 brief (full implementation plan)
- Spec §4 Network architecture (updated by this ADR)
- Spec §6 Phase 6 (Connect and private mesh)
