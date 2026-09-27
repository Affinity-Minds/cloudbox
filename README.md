# CloudBox

CloudBox is a managed SaaS appliance platform that turns a physical Windows PC into a centrally licensed, privately networked, remotely accessible, backed-up, self-updating business application server.

**Production:** `https://box.affinity.ai.in`

## Quick start

### Prerequisites

- Node.js 22+
- pnpm 12.5.1+ (use `corepack enable` to activate globally)
- .NET 10 (for Windows components only)

### Setup

1. **Clone and install:**
   ```bash
   git clone https://github.com/affinityminds/cloudbox.git
   cd cloudbox
   corepack enable
   pnpm install --frozen-lockfile
   ```

2. **Environment configuration:**
   Copy `.dev.vars.example` to `.dev.vars` and fill in local values:
   ```bash
   cp apps/worker-api/.dev.vars.example apps/worker-api/.dev.vars
   ```
   Edit with your local Cloudflare credentials (dev account, not production).

3. **Run verification suite:**
   ```bash
   pnpm run verify
   ```
   This runs all tests and builds the monorepo (worker API, admin web, contracts).

4. **Start local development servers:**

   **Worker API (Cloudflare Worker, local):**
   ```bash
   pnpm --filter @cloudbox/worker-api run dev
   ```
   Serves on `http://localhost:8787` (Wrangler dev server).

   **Admin web (React):**
   ```bash
   pnpm --filter @cloudbox/admin-web run dev
   ```
   Serves on `http://localhost:5173` (Vite dev server).

   Both run in parallel. Wrangler proxies requests to `http://localhost:5173/` for unmatched routes (dev setup convenience).

### Local login

**Staff portal:** `http://localhost:8787/login`
- Bootstrap staff email: `soren@affinityminds.net` (hardcoded in dev)
- On first login, set a password and (optionally) enable TOTP.
- OTP echo enabled in dev: check server logs for mailed codes.

**Customer/Connect sign-in:** `http://localhost:8787/start`
- Self-service onboarding; enter any email.
- OTP codes echoed to stdout (search logs for "OTP code" or the mailed message).

### Database migrations

Migrations are run automatically at deploy time. Locally, to test migration logic:

```bash
pnpm --filter @cloudbox/worker-api run db:generate  # (after schema.ts changes)
pnpm --filter @cloudbox/worker-api run db:migrate:local  # (run against local D1 sqlite file)
```

### Governing documents

Read these before implementing:

1. **`CLOUDBOX_MASTER_AGENT_BUILD_SPEC.md`** — Product contract and phase timeline.
2. **`sorensd/agent-notes`** — Engineering guidance (routing table by task).
3. **`docs/ARCHITECTURE.md`** — System architecture, tables, flows, API versioning.
4. **`docs/decisions/`** — Architecture decision records (ADRs 0001–0011).
5. **`AGENTS.md`** — Agent delivery rules and authorization gates.

### Project structure

```
cloudbox/
├── apps/
│   ├── worker-api/              # Cloudflare Worker (Hono, Drizzle, Better Auth)
│   │   ├── src/
│   │   │   ├── db/schema.ts     # D1 schema (do not hand-edit Better Auth tables)
│   │   │   ├── routes/          # /api/v1/*, /api/ops/*, /api/auth/* handlers
│   │   │   ├── auth/            # Identity, authz, OTP, sessions
│   │   │   └── ...
│   │   ├── migrations/          # SQL migration files (0001, 0002, ...)
│   │   └── .dev.vars.example    # Copy to .dev.vars for local dev
│   ├── admin-web/               # React (Vite, TanStack Router, Tailwind)
│   │   ├── src/
│   │   │   ├── routes/          # File-based routing
│   │   │   └── ...
│   │   └── vite.config.ts
│   ├── cloudbox-agent/          # Windows Agent (.NET 10)
│   ├── cloudbox-server-setup/   # Installer (.NET 10)
│   ├── cloudbox-connect/        # Connect client (.NET 10)
│   └── cloudbox-status/         # Status monitor (.NET 10)
├── packages/
│   ├── contracts/               # Shared TypeScript types (@cloudbox/contracts)
│   └── licensing-contracts/     # Entitlement token types
├── tests/
│   └── e2e-cloud/               # End-to-end tests (Playwright, staging)
├── docs/
│   ├── ARCHITECTURE.md          # System design
│   ├── SECURITY.md              # Trust boundaries and enforcement
│   ├── OPERATIONS.md            # Staff procedures
│   ├── OPEN_QUESTIONS.md        # Unresolved issues
│   ├── ISSUE_LOG.md             # Known issues and decisions
│   ├── decisions/               # ADRs (0001–0011)
│   ├── handoffs/                # WT phase completion summaries
│   ├── slices/                  # Slice documentation
│   └── runbooks/                # Operational procedures
├── .github/workflows/
│   └── deploy-cloudflare.yml    # CI/CD pipeline
├── pnpm-lock.yaml               # Monorepo lock file
└── THIRD_PARTY_NOTICES.md       # License inventory
```

### Key npm scripts

- `pnpm run verify` — Run all tests and build.
- `pnpm --filter @cloudbox/worker-api run dev` — Local Worker server.
- `pnpm --filter @cloudbox/admin-web run dev` — Local React dev server.
- `pnpm --filter @cloudbox/worker-api run db:generate` — Regenerate migration snapshots.
- `pnpm --filter @cloudbox/admin-web run build` — Production React build.

### Testing

**Unit tests:**
```bash
pnpm run test
```

**Security review tests (Phase 1 and Phase 2 findings):**
```bash
pnpm --filter @cloudbox/worker-api test -- test/review
```

**Integration tests (local cloud + D1):**
```bash
pnpm --filter @cloudbox/worker-api test
```

**E2E tests (staging only):**
```bash
pnpm --filter e2e-cloud test
```

### Deployment

Production deployment is automated on every merge to `main`:

1. GitHub Actions workflow (`.github/workflows/deploy-cloudflare.yml`) runs on push.
2. Tests and builds must pass (`pnpm run verify`).
3. Migrations run against D1 (idempotent, via Wrangler).
4. Worker code deployed to Cloudflare edge.
5. Admin web built and uploaded to R2.
6. Rollback: revert commit + push to main.

**Manual deploy (rare):**
```bash
wrangler deploy  # (requires CLOUDFLARE_API_TOKEN in environment)
```

### Documentation

- **Phase planning:** Read `CLOUDBOX_MASTER_AGENT_BUILD_SPEC.md` Section 56+ for slice definitions and current phase context.
- **Architecture:** `docs/ARCHITECTURE.md` — data model, request flows, deployment zones, trust boundaries.
- **Security:** `docs/SECURITY.md` — identity systems, authorization, audit trail, rate limiting, open findings.
- **Operations:** `docs/OPERATIONS.md` — staff management, license keys, plans, device revocation, audit log queries.
- **Decisions:** `docs/decisions/` — ADRs covering auth (0002), email providers (0010), self-service onboarding (0011), etc.
- **Build state:** `docs/BUILD_STATE.md` — current WT status and blockers.

### Getting help

1. Check `docs/ISSUE_LOG.md` for known issues and workarounds.
2. Search `docs/decisions/` for relevant ADRs.
3. Review `docs/handoffs/` for phase completion context.
4. Check `docs/OPEN_QUESTIONS.md` for unresolved items.

### Contributing

- Work in a dedicated worktree: `.claude/worktrees/wt-p*/`.
- Create a feature branch: `git checkout -b wt/p-description`.
- Small logical commits with clear messages.
- Update `docs/BUILD_STATE.md` and `docs/ISSUE_LOG.md` as you go.
- Link commits to ADRs and slices.
- Push and open a draft PR against the target phase branch (e.g., `phase-2/devices`).
- Review process: code review + security review (if applicable).
- Merge via squash or rebase (fast-forward preferred).
