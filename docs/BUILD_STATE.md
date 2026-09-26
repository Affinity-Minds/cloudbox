# Current phase
Phase 0 — Repository, engineering contract, and deployable skeleton

# Current slice
0.1 — Bootstrap the monorepo

# Status
in_progress

# Demo path
1. Fresh clone.
2. `corepack enable`.
3. `pnpm install`.
4. `pnpm ci`.
5. Verify repository contains documented Cloud, Windows, infrastructure, package, test, and docs boundaries.

# Evidence
- Commit identity confirmed: sorensd <67230851+sorensd@users.noreply.github.com>.
- GitHub write access re-authorized successfully on 2026-09-26.
- Phase 0 branch created: `phase-0/bootstrap`.
- Initial repository scaffold is being published.
- CI and deploy workflows prepared.
- Production domain fixed at `box.affinityminds.in`.

# Blockers
- Cloudflare D1/R2 resource identifiers will be created/recorded by the deployment workflow rather than invented in source.
- Dependency lockfile will be generated after the first successful registry install, then CI will switch to frozen-lockfile.
