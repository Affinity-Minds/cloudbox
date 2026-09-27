# Current phase
Phase 2 — Physical device enrollment and Windows acceptance (integration branch `phase-2/devices`); Phase 3 cloud side is already live.

# Current slice
2.3 physical acceptance: the owner runs the `CloudBox.Agent-win-x64` artifact on the lab PC against production (enroll → Online → entitlement → uninstall → verify-clean).

# Status
Phase 2 cloud side MERGED to `main` (PR #22, production SHA ed59dcf, 2026-09-27 09:37 UTC) and live-verified; the owner's lab run is the remaining Phase 2 exit item. In progress: plan pricing/add-on users (WT-13 follow-up). Follow-ups: W-2 (fleet principal-type check), Staff management screen, real SMTP relay send verification, pin actions by SHA, plan-designer note that lowering max_devices blocks new licences, Connect timing parity, ownership transfer in the portal.

# Demo path
1. Staff: https://box.affinityminds.in/ops/login → email + initial password → forced password change → authenticator QR → console.
2. Tenants → New tenant → Enrollment → New enrollment code (shown once).
3. Lab PC (elevated PowerShell, artifact extracted): `CloudBox.Agent.exe install --base-url https://box.affinityminds.in --enroll-token <code>` → Fleet shows the device Online.
4. Subscriptions → New subscription (cloudbox-6) → device → Issue → Agent `status` shows generation 1.
5. `CloudBox.Agent.exe uninstall` → `verify-clean` exits 0 → Fleet shows revoked, Audit shows DEVICE_UNINSTALLED.

# Evidence
- See "Completed phases" for Phase 0 and Phase 1 live evidence. Lab evidence is recorded here when the owner reports it.
- Merged `origin/wt/p16-docs-sweep` (PR #25, docs only) into `phase-2/devices` at `454bf91` (fast-forward from `33862a5`), then `origin/wt/p7-fleet-presence` (PR #27, WT-16 realtime fleet presence) at merge commit `f58bad6`, then a SECURITY.md numeric-limit correction at `8bc785d`. Gate run per-stage (host under heavy sibling-worktree CPU contention, so the bundled `pnpm run verify` was split and given long per-test timeouts instead): `pnpm check` rc=0, `pnpm typecheck` rc=0, `vitest run --testTimeout=120000 --hookTimeout=120000` for `@cloudbox/worker-api` — 35 test files / 649 tests passed, `@cloudbox/admin-web` — 4 files / 18 tests passed, `@cloudbox/licensing-contracts` — 2 files / 16 tests passed, `pnpm build` rc=0. `drizzle-kit generate --name probe` → "No schema changes, nothing to migrate" (neither branch touched schema/migrations). `check-workflows.py` ok.

# Blockers
None on the cloud side.

# Completed phases
## Phase 1 — Identity, tenancy, devices, entitlements — DONE 2026-09-27 03:15 IST
- Merged to `main` via PR #12 at `6c522a3cf7613d2569b2d4142ea56fd2ad405cfb` after WT-8's fifth-pass verdict (no Critical/High). Integration branch `phase-1/identity` (final `91ef989`).
- Verification at merge: `pnpm run verify` green — 469 worker tests (real D1 in the Workers pool, incl. 54+8+4+5 adversarial review tests), 16 entitlement-format tests, 5 UI tests; CI web + Windows + build jobs green on the PR.
- Deploy: "Deploy CloudBox" run 36273684998 deployed the Worker, applied migrations 0003–0008, synced secrets (STAFF_AUTH_SECRET, CUSTOMER_AUTH_SECRET, BOOTSTRAP_SUPER_ADMIN_PASSWORD, ENTITLEMENT_SIGNING_JWK, PROVIDER_SECRETS_KEY, TURNSTILE_SECRET_KEY) and proved the audited release row; the run then failed on a wrong `wrangler secret delete --force` flag in the retire step (fixed in PR #18), so the workflow's own verify step did not run and was performed by hand below.
- Live verification (curl, 03:12 IST): `/api/health` ok; `/api/version` gitSha == `main`; `/api/v1/foundation` release.sha == main with the audited row; `/login` 200 (customer, no robots header); `/ops/login` and `/ops` 200 with `X-Robots-Tag: noindex, nofollow`; `/ops/zzz` and a random path return byte-identical documents; `/api/ops/auth/get-session` and `/api/auth/get-session` answer, while `/api/auth/sign-in/email` and `/api/ops/auth/email-otp/*` are 404 (disjoint mounts); `/api/v1/screens/overview` and `/api/v1/me/tenants` are 401 anonymously; a wrong staff password returns 401 with the same body as an unknown email.
- Rendered evidence: `docs/evidence/phase-1/live-ops-login.png`, `docs/evidence/phase-1/live-customer-login.png` (production), plus per-slice screenshots under `docs/evidence/wt-*`.
- Exit criteria per spec (humans authenticate and operate inside an enforced tenant boundary): staff sign-in with password + authenticator ✓, customer email OTP ✓, roles/permissions as rows ✓, tenant CRUD ✓, memberships with standing ✓, cross-tenant negative tests ✓ (review U-3), audit on every consequential write ✓.
- Also live from this merge (Phase 2/3 cloud halves, individually gated): enrollment tokens, agent API, device registry, fleet screens (WT-3); plans, subscriptions, entitlement issuance with a provisioned signing key (WT-5); email provider registry (WT-12); Windows Agent artifact built by CI (WT-4).
- Security review: `docs/reviews/phase-1-security.md`, five passes; open Lows W-1, W-2 queued as follow-ups.


## Phase 0 — Repository, engineering contract, deployable skeleton — DONE 2026-09-27 00:25 IST
- Merged to `main` via PR #1 (fix commit `584aa9e`) and deploy hotfix PR #3 (`89fc59c`); production SHA `8f16cde9a904bc8c21328d0e6fbef1fc7e351f2e`.
- Deploy run: GitHub Actions "Deploy CloudBox" succeeded; D1 `cloudbox-db` recreated in APAC while empty; R2 binding deferred with a workflow warning until R2 is enabled on the account.
- Live verification (curl, 00:24 IST): `GET /api/health` 200 `{"status":"ok"}`; `GET /api/version` gitSha equals `main`; `GET /api/v1` carries `X-API-Version: v1`; `GET /api/v1/foundation` returns `release.status=deployed`, `release.sha` = main SHA, and the audited `foundation.release.changed` row by `github-actions` with before/after; `GET /` serves the SPA shell (200, text/html).
- Rendered evidence: `docs/evidence/phase-0/live-shell.png` (Playwright Chromium against https://box.affinityminds.in, shows Release deployed, Build and Audited SHA `8f16cde9a904`, 2 audit records).
- Exit criteria per spec: staging/production deployable ✓, versioned ✓, testable (`pnpm run verify`, 5 tests at the time) ✓, every later slice has a home ✓, audited administrative state change proven live ✓.
- Deferred: R2 bucket (account-level enablement), Windows physical checks (none required by Phase 0).

