# CloudBox architecture

CloudBox has four deployment zones:

1. **Cloud SaaS** — Cloudflare Worker, static React apps, D1, Durable Objects, R2.
2. **Network control plane** — self-hosted WireGuard orchestration behind a CloudBox-owned adapter.
3. **CloudBox Server endpoint** — physical Windows machine running Agent, Status, remote-session runtime, private-network runtime, backup and update workers.
4. **CloudBox Connect endpoint** — employee Windows client providing tenant-scoped authentication and one-click private RDP access.

## Stable boundaries

- Cloud business authority never lives solely in the VPN controller.
- Windows privileged actions go through the Agent.
- Customer UIs see CloudBox concepts, not upstream VPN/RDP implementation details.
- API contract begins at `/api/v1/*`.
- Production origin is `https://box.affinityminds.in`.

## Phase 0 deployment

The first web deployment intentionally contains only the operational shell and infrastructure endpoints. D1 is not placed on the page-load path.
