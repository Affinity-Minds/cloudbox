# CloudBox private network: server architecture and research brief

**Purpose.** (1) Record the network control-plane architecture as designed and built so far. (2) Define a research task for a separate agent (Codex) to evaluate hosting options and alternatives, with a fixed reporting format so the findings can be compared and acted on.

**Owner constraints (fixed, do not re-litigate):** no third-party freemium or per-user-priced control plane (Tailscale, NetBird Cloud, Cloudflare Zero Trust rejected); open source with no seat or device limits; data plane must be peer-to-peer WireGuard; CloudBox SaaS stays the only customer-facing control plane; the provider (super admin group) must always have network reachability to every tenant server for maintenance. Selected stack: **self-hosted NetBird** (server components AGPLv3, run unmodified via REST API; Windows client BSD-3). Spec §4.8 (Netmaker) is superseded by ADR 0007.

---

## Part 1 — Architecture as built

### Components and where they run

| Component | Runs on | Role | Status |
|---|---|---|---|
| CloudBox SaaS (Cloudflare Worker + D1 + R2 + Durable Objects) at `https://box.affinity.ai.in` | Cloudflare | Source of truth for tenants, members, devices, plans, licences; generates NetBird desired state | Live |
| Network controller adapter (`apps/worker-api/src/network/*`) | Cloudflare Worker | Thin REST client over NetBird's API; reconciles groups, policies, setup keys, peers from D1 | Merged; no-op until `NETBIRD_API_URL` is set |
| NetBird control plane (management, signal, relay, coturn STUN/TURN, embedded IdP, dashboard, Traefik + Let's Encrypt) | **A Linux host we own** (the subject of Part 2) | Peer registration, key exchange, NAT traversal help, policy distribution, relay fallback | Not deployed |
| NetBird client (netbird service) | Every CloudBox server PC (installed silently by `CloudBox.Server.Setup.exe`) and every client PC (installed by `CloudBox.Connect.Setup.exe`) | WireGuard data plane; joins with a one-off setup key minted by the SaaS | Placeholder step in Setup; Connect has the interface only |
| Support gateway peer | The same Linux host, in group `cbx-support` | Provider's always-on entry point into every tenant network | Not deployed |

### Desired-state model (generated from D1, never edited by hand in NetBird)

- Groups: `cbx-server-<TENANT_CODE>`, `cbx-client-<TENANT_CODE>`, `cbx-support`.
- Policies: per tenant `cbx-client-<T>` → `cbx-server-<T>`, TCP 3389 (+ a reserved Agent management port), one-directional; global `cbx-support` → every `cbx-server-*`. The NetBird **Default allow-all policy is deleted**; a test asserts it stays absent.
- Setup keys: one-off, 24 h, `auto_groups` = the tenant's group, minted per server at enrollment (`POST /api/v1/agent/enroll` returns `network.setupKey`) and per client on demand (`GET /api/v1/connect/devices/:id/network`); revoked after first use. Users never see keys, network names or addresses.
- Revocation: device revoke, membership revoke and device uninstall remove the peer; best-effort so a NetBird outage never blocks the primary action.
- Table `network_peers` in D1 mirrors peer ids, groups and status for the fleet Network tab.

### Traffic model

```
Connect PC ──(WireGuard, direct P2P when NAT allows)──▶ CloudBox server PC : 3389
     │                                                          ▲
     └──(only if direct fails: relay over WebSocket / TURN UDP)─┘  via the NetBird host
Both peers ──(HTTPS/gRPC: registration, keys, policy, signalling)──▶ NetBird host : 443
Both peers ──(STUN: discover public endpoint)──▶ NetBird host : UDP 3478
```

Control-plane outage semantics (spec §41): established direct tunnels keep working; new logins, new peers and relayed sessions stop until the host returns.

### Host requirements (verified from NetBird docs, 2026-09-26)

- Linux VM, **≥1 CPU, 2 GB RAM** (4 GB comfortable), Docker with the compose plugin, `jq`, `curl`.
- A **public IPv4 that the peers can reach directly**; a DNS **A record, DNS-only (not proxied)** e.g. `net.affinity.ai.in`.
- Inbound **TCP 80, TCP 443, UDP 3478**. Legacy clients (<0.29) also need TCP 33073, 10000, 33080 and UDP 49152–65535; not needed for us.
- Persistent disk for `/var/lib/netbird` (the identity/store database) and the Let's Encrypt state; nightly backup.
- Install: `curl -fsSL https://github.com/netbirdio/netbird/releases/latest/download/getting-started.sh | bash` (embedded IdP, Traefik with automatic TLS). Pin the version afterwards.
- Why Cloudflare's own platform cannot host it: Workers/Containers expose only HTTP/WebSocket through a Worker (no inbound UDP, no direct gRPC, ephemeral disk); NetBird requires unproxied DNS.

### Security posture on the host

- Only the three ports open; SSH key-only; automatic security updates; NetBird API token stored as a Wrangler secret (`NETBIRD_API_TOKEN`), never in D1 or the repo; dashboard admin restricted to the provider.
- The host is inside the mesh as `cbx-support` only; it holds no customer data.

---

## Part 2 — Research requirement for Codex

### Task

Evaluate **where to host the NetBird control plane for CloudBox's alpha and first year**, and produce a decision-ready comparison. Also evaluate two structural alternatives at lower priority. Do not build anything; do not open accounts; do not spend money.

### Hard requirements every hosting option must meet

R1. Public IPv4 reachable directly; DNS-only A record possible.
R2. Inbound TCP 80/443 and UDP 3478 (and the ability to open UDP 49152–65535 if ever needed).
R3. ≥2 GB RAM, ≥1 vCPU, ≥20 GB persistent disk that survives reboots and provider maintenance.
R4. Docker + docker compose v2 installable; Ubuntu 22.04/24.04 or Debian 12; **ARM64 acceptable** (NetBird images are multi-arch) — say so per option.
R5. Root SSH access for our automation.
R6. No per-user, per-device or per-seat pricing; no "free tier" that requires an upgrade for API access or for the UDP ports.
R7. Region: India preferred (Mumbai/Hyderabad/Bangalore/Delhi); Singapore acceptable; EU/US acceptable for control traffic only if the price justifies it. Give measured or documented latency from India where available.

### Options to research (add any credible one I missed)

1. Home lab VM behind a residential connection with router port-forwarding and a dynamic-DNS update (the "factory" VM: Ubuntu 24.04, Docker present, public IP via ISP). Focus: reliability, IP change handling, ISP CGNAT risk, upload bandwidth impact when relaying, exposure/security of a home network hosting this.
2. Oracle Cloud Always Free (Mumbai/Hyderabad): what is actually free forever for ARM Ampere and AMD shapes as of the research date, signup/approval friction, whether inbound UDP works through their security lists and NSGs, idle-reclaim policy for free instances, egress limits.
3. Hetzner Cloud: exact current prices per location for CX (cost-optimized), CPX (regular) and CAX (ARM) lines including IPv4 fee; availability in Singapore vs Germany/Finland vs US; traffic quotas; measured India latency to each.
4. DigitalOcean Bangalore, Vultr Mumbai/Delhi, Linode/Akamai Mumbai and Chennai, AWS Lightsail Mumbai, Azure B1s/B2s India, Google Cloud e2-micro/e2-small Mumbai, Contabo, OVH: cheapest instance meeting R1–R6 in an Indian or Singapore region, all-in monthly price, bandwidth included.
5. Fly.io: whether inbound UDP and persistent volumes satisfy R1–R3 today, pricing, region availability (Mumbai/Singapore).
6. Any Indian providers (E2E Networks, Hostinger VPS India, DigitalOcean's Indian resellers) meeting R1–R6.

### Structural alternatives (lower priority, one page each)

A. **Cloudflare Zero Trust as the network instead of NetBird** (cloudflared on servers + WARP on clients, or browser-rendered RDP through Access): exact current pricing model and free-seat limit, whether device-only (no user) enrollment is possible, whether traffic is hub-only, and what it would take to embed WARP silently in our installers. State clearly that this conflicts with owner constraints and quantify the cost at 50, 200 and 1000 end users.
B. **Self-built coordination on Cloudflare Workers/Durable Objects** with native WireGuard on Windows, public STUN (`stun.cloudflare.com`) and a relay fallback: is there a maintained open-source project that already does this (search for WireGuard control planes that run serverless), what relay would work, and a rough effort estimate. Do not propose writing a VPN orchestrator from scratch.

### Evidence rules

- Every price, limit, port rule and free-tier claim must come from the **vendor's own current page or documentation**, with the URL and the date you read it. No blog posts, no summaries, no recollection. If a vendor page and a third-party page disagree, the vendor page wins and the disagreement is noted.
- Mark anything you could not verify as **"unverified"** rather than guessing.
- Note "limited availability", region-specific caveats, card-on-file requirements, and idle-reclaim or fair-use rules explicitly.
- Latency: prefer the vendor's own published numbers or a reputable public looking-glass; label estimates as estimates.

### Required output format

Deliver one Markdown file `netbird-hosting-findings.md` with exactly these sections:

1. **Summary** (≤10 lines): the recommended option for alpha, the recommended option for the first year, and the single biggest risk of each.
2. **Comparison table**, one row per option, columns: Provider/plan · Region · vCPU/RAM/disk · Arch · Public IPv4 · UDP 3478 inbound (yes/no/needs config) · Persistent disk · Monthly all-in price (USD, incl. IPv4 and VAT if applicable) · Included traffic · India latency (ms, source) · Card required · Free-tier gotchas · Verdict (fit / fit with caveat / unfit) · Sources.
3. **Per-option notes**, one subsection each: exact steps to satisfy R1–R7 on that provider (firewall/security-list rules, static IP, disk), anything that breaks NetBird's quick-start script there (e.g. ARM, cloud-init, ports 80/443 already in use), and the exit path (how to move away).
4. **Home-lab option**: a concrete risk register (IP change, CGNAT, ISP port blocking, power/ISP outage, upload saturation, exposure of the home LAN) with a mitigation and a residual-risk rating for each, plus the exact router/DDNS setup steps.
5. **Structural alternatives A and B**: one page each as specified above.
6. **Recommendation**: a ranked list with reasons, and a 10-line runbook for the top pick (create instance, open ports, DNS record, install command, token, delete Default policy, join the support peer, backup cron, monitoring).
7. **Open questions for the owner**: anything that changes the answer (budget ceiling, tolerance for a home-hosted control plane, region preference).
8. **Sources**: numbered list of every URL with its access date.

### Non-goals

Do not evaluate mesh products other than NetBird for the data plane (decision made). Do not evaluate Kubernetes hosting (single compose stack; a cluster adds cost without benefit at this scale). Do not recommend anything that proxies NetBird's gRPC or hides it behind a tunnel.
