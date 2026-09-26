# CloudBox Worktree Registry

This registry tracks the eight parallel worktrees active during Phase 0–3 delivery.

| WT | Role | Model | Branch | Owns (paths) | Status |
|---|---|---|---|---|---|
| WT-0 | Orchestrator / integrator / foundation | **Fable 5.1** | `phase-0/bootstrap`, `phase-1/identity`, integration | `db/schema.ts`, migration `0003`, `routes/v1/index.ts`, `nav.ts`, root `package.json`, workflows, `BUILD_STATE`, `WORKTREE_REGISTRY` | Phase 0 merged to `main` (deploy blocked on Cloudflare token permissions); foundation landed `7d8a76d`; contract null-fix `d98dba0` |
| WT-1 | Auth + authz (1.1, 1.2) | **Opus 5.5** | `wt/p1-auth` | `worker-api/src/auth/**`, `authz/**`, `routes/v1/auth.ts`, `admin-web/src/routes/login.tsx`, `api/auth.ts`, email provider | Done, merged at `13186f4` (PRs #4 #6 #9 #10 #14 #17): two identity systems (staff password+TOTP under discreet `/ops`, customers email OTP), closed sign-in, Turnstile step-up, all WT-8 passes 1–4 fixed |
| WT-2 | Tenants + memberships (1.3, 1.4) | **Sonnet 5** | `wt/p1-tenants` | `routes/v1/tenants.ts`, `memberships.ts`, `screens/tenants.ts`, `admin-web/src/routes/_app/tenants*`, `api/tenants.ts` | Done, merged (PRs #13 #16 #19): tenants, memberships, ranking, primary contact = first Owner |
| WT-3 | Enrollment + devices + fleet table cloud side (2.3, 7.3-lite) | **Sonnet 5** | `wt/p2-enrollment` | `routes/v1/enrollment.ts`, `devices.ts`, `agent.ts`, `screens/fleet.ts`, `admin-web/src/routes/_app/fleet*`, `_app/enrollment*`, `api/devices.ts` | Done, merged `734bdd1` (PR #11): enrollment tokens, agent API, fleet screens; 367 worker tests |
| WT-4 | Windows Agent + device identity + enrollment client + **uninstaller** (2.1, 2.2, 2.3 client, 2.5) | **Opus 5.5** | `wt/p2-agent` | `apps/cloudbox-agent/**`, `apps/cloudbox-status/**` (stub), `.github/workflows/build-windows.yml` test + publish-artifact steps | Done, merged into `phase-1/identity` (PR #2 draft, Windows CI green, artifact `CloudBox.Agent-win-x64`); lab run after Phase 1 deploy |
| WT-5 | Plans, subscriptions, entitlement issuance (3.1, 3.2 cloud) | **Opus 5.5** | `wt/p3-entitlement` | `routes/v1/subscriptions.ts`, `entitlements.ts`, `entitlement/**`, `admin-web/src/routes/_app/subscriptions*`, `api/subscriptions.ts`, `packages/licensing-contracts` | Done, merged `55dd451` (PR #7): plans, subscriptions, entitlement issuance; signing key provisioned as GitHub env secret |
| WT-6 | QA harness: pool-workers, migration test, permission-boundary fixtures, Playwright prod smoke | **Sonnet 5** | `wt/p1-qa` | `apps/worker-api/vitest.config.ts`, `test/**`, `tests/e2e-cloud/**`, `packages/test-fixtures` | Done, merged `b009bf6` (PR #8): fixtures, query-plan registry, self-discovering permission matrix, migration tests, Playwright smoke |
| WT-7 | Docs, registry, handoff templates, third-party notices, ADRs 0002–0008 drafts | **Haiku 4.5** | `wt/p1-docs` | `docs/**` except `BUILD_STATE.md`, `THIRD_PARTY_NOTICES.md`, runbook skeletons | Done 00:05 IST, merged into `phase-1/identity` at `7d8a76d` |
| WT-8 | Adversarial security review (read-only until findings accepted) | **Opus 5.5** | reads `phase-1/identity` | writes only `docs/reviews/phase-1-security.md` and negative-test requests | Phase 1 five passes + Phase 2 onboarding review and verdict (merge approved); Lows tracked in BUILD_STATE |

**Master timeline:**

- 22:45–23:30 IST: WT-0 fixes PR #1, merges to main. WT-4 and WT-7 start from `phase-0/bootstrap`.
- 23:30–00:20: WT-0 creates `phase-1/identity` with foundation commit.
- 00:20: Fan out WT-1, WT-2, WT-3, WT-5, WT-6.
- 00:20–02:30: All implementation worktrees, WT-0 answers contract questions.
- 02:30–03:30: Integrate WT-1 + WT-2 + WT-6. Run suite. WT-8 review. Merge Phase 1 to main. Deploy.
- 03:30–04:30: Integrate WT-3, WT-5, WT-4. Deploy. Owner runs Agent on lab Windows machine.
- 04:30–05:00: Buffer. Final docs, evidence, handoffs.

**Status updates:**

WT-0 maintains this registry with exact current status; each worktree updates its own row with link to `docs/handoffs/<branch>.md` when ready for integration.
| WT-12 | Email provider registry: N providers incl. SMTP (`worker-mailer`), fallback order, encrypted secrets, Settings UI (owner request 02:05) | **Sonnet 5** | `wt/p1-email-providers` | `worker-api/src/email/providers/**`, `src/email/send.ts`, `routes/v1/settings-email-providers`, `admin-web/src/routes/_app/settings.tsx` email section, migration `0008` | Done, merged `fd5a1c9` (PR #15): provider registry with SMTP, fallback, encrypted secrets, Settings UI; real SMTP relay send unverified |
| WT-13 | Plan designer, plan selector, timezone selector (owner request 04:05) | **Sonnet 5** | `wt/p2-plan-designer` | plans router, `routes/_app/plans.tsx`, `components/plan-select.tsx`, `components/timezone-select.tsx`, migration `0009` | Done, merged `694b495` (PR #21) |
| WT-14 | Self-service onboarding, activation grants, licence keys, two-event plan redemption, auto-issuance, Connect sign-in contract (owner requests 03:50–04:20) | **Opus 5.5** | `wt/p2-self-onboarding` | `src/onboarding/**`, `routes/_app/licences.tsx`, `routes/start.tsx`, migration `0010` | Done, merged (PR #20) incl. all review fixes |
