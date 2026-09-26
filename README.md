# CloudBox

CloudBox is a managed SaaS appliance platform that turns a physical Windows PC into a centrally licensed, privately networked, remotely accessible, backed-up, self-updating business application server.

Production hostname: `https://box.affinityminds.in`

## Governing documents

1. `CLOUDBOX_MASTER_AGENT_BUILD_SPEC.md`
2. `sorensd/agent-notes`
3. `AGENTS.md`
4. `docs/ARCHITECTURE.md`
5. ADRs in `docs/decisions/`

## Phase 0 quick start

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm ci
```

Cloudflare deployment is performed by GitHub Actions after merge to `main`. Production credentials stay in GitHub/Cloudflare secret stores and never in this repository.