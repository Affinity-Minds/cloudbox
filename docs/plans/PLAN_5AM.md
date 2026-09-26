# CloudBox — 5 AM execution plan (written 2026-09-26 22:45 IST)

Deadline: 05:00 IST 2026-09-27 (about 6 hours). Orchestrator: this session (Fable 5.1, worktree WT-0).

## 1. Honest estimate

| Scope | Estimate |
|---|---|
| Full spec, first commercial milestone (Section 0.12: physical CloudBox, Netmaker mesh, Connect, backup+restore, OTA, break-glass) | **8–10 weeks** calendar with 4–6 parallel agent worktrees. Dominated by physical Windows tests, self-hosted Netmaker, RDP Wrapper legal inventory, and restore drills. No amount of parallelism removes those. |
| Cloud control plane only, Phases 0–3 cloud halves | **1–2 days** |
| **Tonight (6 h)** | Phase 0 live on box.affinityminds.in; Phase 1 complete (OTP login, staff roles, tenants, memberships) and deployed; Phase 2 cloud side (enrollment tokens, device registry, fleet table); Phase 3 cloud side (plans, subscriptions, signed+encrypted entitlement issuance); Windows Agent installed on the owner's lab machine, enrolled for real, heartbeating into the fleet table, and **uninstalled back to original state** (Slice 2.1, 2.2, 2.3, new 2.5). |

"Working product by 5 AM" therefore means: a real admin can log in with email OTP on the production URL, create a tenant, mint an enrollment token, install the Agent on the real Windows machine, see it enrolled and online in the fleet table, attach a subscription and issue a machine-bound entitlement that the Agent downloads, then run the uninstaller and prove nothing CloudBox remains. All audited, all server-authorised, all deployed.

## 2. What I verified (repository reality beats the handoff)

- `phase-0/bootstrap` already holds the 38-file scaffold (11 commits, author `sorensd`). PR #1 is open. `main` has only the initial commit.
- CI fails on **one character**: `apps/admin-web/src/main.tsx:94` closes a `<section>` with `</div>`. With that fixed, `check`, `typecheck`, `test` (5 tests) and `build` including `wrangler deploy --dry-run` all pass locally.
- `pnpm ci` in package.json is **shadowed by pnpm's built-in clean-install**. It reinstalls and never runs checks or the build. The deploy workflow relies on it, so it would deploy with no `admin-web/dist`. Rename the script to `verify`.
- Deploy workflow line 75 has broken JSON quoting in `--data "{"status":...}"`. It would send garbage and fail the audited-release step.
- `wrangler.jsonc` omits D1 `database_id` and R2 `bucket_name`; wrangler 4.135 accepts this in dry-run (auto-provision on deploy). Keep a fallback step that creates `cloudbox-db` / `cloudbox-artifacts` and injects ids if the first deploy refuses.
- GitHub org secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` exist with visibility `all`. The `production` environment does not exist yet; GitHub creates it on first run.
- The `affinityminds.in` zone is on Cloudflare nameservers but is **not** in either account this machine's wrangler login can see. Production deploys go through GitHub Actions only. `box.affinityminds.in` is NXDOMAIN until the first deploy provisions the custom domain.
- This Linux machine has node 24, pnpm via corepack, git, gh. **No dotnet, no Windows.** Windows components compile only on the `windows-latest` CI runner tonight.
- Pinned package versions all exist on npm. Latest useful: better-auth 1.7.6, jose 6.2.12, resend 6.30.0, @tanstack/react-router 1.170, @tanstack/react-table 9.2, shadcn 4.21, tailwindcss 4.3, input-otp 1.5, @cloudflare/vitest-pool-workers 0.22.
- agent-notes routing table read. Binding shortcuts from it are applied in Section 4.

## 3. Owner inputs (resolved 2026-09-26 23:00)

1. **OTP email = Cloudflare Email Service** (`send_email` binding named `EMAIL`), sending domain `em.affinity.ai.in`, from address `no-reply@em.affinity.ai.in`. Verified in public DNS at 23:05: `cf-bounce.em.affinity.ai.in` has the Cloudflare bounce MX, SPF and DKIM records and `_dmarc` is `p=reject`, so the domain is onboarded to Email Sending. Two things the owner must confirm in the dashboard of the account that owns the `cloudbox` Worker: the `affinity.ai.in` zone and the Email Sending onboarding are in that same account (a binding can only send from domains onboarded in its own account), and `soren@affinityminds.net` is added as a verified destination address under Email Routing (sending to verified destinations works on every plan; sending to arbitrary addresses needs Workers Paid). If a send throws `E_SENDER_NOT_VERIFIED`, that is the account mismatch. Dev echoes the OTP behind `OTP_DEV_ECHO=1`; production never echoes.
2. **Bootstrap super admin** = `soren@affinityminds.net`. Already set as GitHub repo variable `BOOTSTRAP_SUPER_ADMIN_EMAIL`. First login with that email is seeded as Super Admin; every other staff role is an audited grant.
3. **A Windows machine exists.** WT-4 ships a self-contained `CloudBox.Agent.exe` CI artifact; the owner downloads it on the lab machine and runs the install, enrollment, heartbeat and uninstall demo path from `docs/runbooks/agent-install-dev.md`.
4. **Uninstaller is in scope tonight** (new Slice 2.5, WT-4): remove literally everything CloudBox created and return the machine to its pre-install state, driven by an install manifest. Customer business-application data is never deleted by uninstall unless `--purge-data` is given with a typed confirmation, per spec §3.4.
5. If the first deploy fails on custom-domain provisioning, the org Cloudflare token needs Zone:DNS:Edit on `affinityminds.in`.

## 4. Shortcuts (use the existing wheel)

| Need | Wheel | Not doing |
|---|---|---|
| Email OTP auth | Better Auth `emailOTP` plugin, Drizzle adapter on D1, schema generated by `@better-auth/cli` | own OTP tables or sessions |
| Email delivery | Cloudflare Email Service `send_email` binding: `env.EMAIL.send({to, from, subject, text, html})`, behind a 20-line adapter | Resend, SMTP, custom queue |
| Roles/permissions | permissions as rows: `permissions`, `role_permissions`, `staff_members`; one `requirePermission()` middleware | Better Auth admin plugin as the authority |
| UI | Tailwind v4 + shadcn/ui (`sidebar-07` + `data-table` blocks), TanStack Router (file-based), Query, Table, React Hook Form + Zod, `input-otp`, Lucide | hand-written CSS shell (the current 330-line styles.css is replaced) |
| Validation | Zod schemas in `packages/contracts`, `@hono/zod-validator` | ad hoc checks |
| Migrations | Drizzle schema is the source; `drizzle-kit generate` emits SQL into `infra/cloudflare/migrations`; wrangler applies | hand-written DDL drift |
| Entitlement | `jose`: ES256 JWS of claims, nested in RSA-OAEP-256/A256GCM JWE to the device public key | any proprietary format |
| Enrollment codes | `crypto.getRandomValues`, SHA-256 hash stored, `CBX-ENROLL-XXXX-XXXX` | reusable keys |
| Device auth (tonight) | opaque device bearer token issued at enrollment, hash stored. ADR records upgrade to signed requests with the TPM key | building request signing tonight |
| D1 integration tests | `@cloudflare/vitest-pool-workers` with `applyD1Migrations` | mocking D1 |
| Windows service | `dotnet new worker` + `Microsoft.Extensions.Hosting.WindowsServices`, Serilog, `CngKey` with Microsoft Platform Crypto Provider, `NamedPipeServerStream` | custom service host, custom IPC |
| Uninstall to original state | install manifest (`C:\\ProgramData\\CloudBox\\install-manifest.json`) written transactionally by every install step, replayed in reverse by `CloudBox.Agent.exe uninstall`; `sc.exe`, `netsh advfirewall`, `net localgroup`, `CngKey.Delete`, ARP registry key for Apps & Features | ad hoc cleanup scripts |
| Realtime | reserved (`FleetPresence` DO already bound); tonight fleet table uses a single screen loader, not polling | WebSocket work tonight |

## 5. Worktree map (branch, model, ownership)

Integration branches: `phase-0/bootstrap` → `main` (tonight, first hour), then `phase-1/identity` from `main`. All fan-out worktrees branch from `phase-1/identity` **after WT-0 lands the foundation commit**. Phase 2/3 worktrees also branch from it; WT-0 merges them into `phase-2/devices` and `phase-3/entitlement` integration branches after Phase 1 merges.

| WT | Role | Model | Branch | Owns (paths) | Starts |
|---|---|---|---|---|---|
| WT-0 | Orchestrator / integrator / foundation | **Fable 5.1** (this session) | `phase-0/bootstrap`, `phase-1/identity`, integration | `db/schema.ts`, migration `0003`, `routes/v1/index.ts`, `nav.ts`, root `package.json`, workflows, `BUILD_STATE`, `WORKTREE_REGISTRY` | now |
| WT-1 | Auth + authz (1.1, 1.2) | **Opus 5.5** | `wt/p1-auth` | `worker-api/src/auth/**`, `authz/**`, `routes/v1/auth.ts`, `admin-web/src/routes/login.tsx`, `api/auth.ts`, email provider | after foundation |
| WT-2 | Tenants + memberships (1.3, 1.4) | **Sonnet 5** | `wt/p1-tenants` | `routes/v1/tenants.ts`, `memberships.ts`, `screens/tenants.ts`, `admin-web/src/routes/_app/tenants*`, `api/tenants.ts` | after foundation |
| WT-3 | Enrollment + devices + fleet table cloud side (2.3, 7.3-lite) | **Sonnet 5** | `wt/p2-enrollment` | `routes/v1/enrollment.ts`, `devices.ts`, `agent.ts`, `screens/fleet.ts`, `admin-web/src/routes/_app/fleet*`, `_app/enrollment*`, `api/devices.ts` | after foundation |
| WT-4 | Windows Agent + device identity + enrollment client + **uninstaller** (2.1, 2.2, 2.3 client, 2.5) | **Opus 5.5** | `wt/p2-agent` | `apps/cloudbox-agent/**`, `apps/cloudbox-status/**` (stub), `.github/workflows/build-windows.yml` test + publish-artifact steps | **now** (independent of foundation; contract is in the brief) |
| WT-5 | Plans, subscriptions, entitlement issuance (3.1, 3.2 cloud) | **Opus 5.5** | `wt/p3-entitlement` | `routes/v1/subscriptions.ts`, `entitlements.ts`, `entitlement/**`, `admin-web/src/routes/_app/subscriptions*`, `api/subscriptions.ts`, `packages/licensing-contracts` | after foundation |
| WT-6 | QA harness: pool-workers, migration test, permission-boundary fixtures, Playwright prod smoke | **Sonnet 5** | `wt/p1-qa` | `apps/worker-api/vitest.config.ts`, `test/**`, `tests/e2e-cloud/**`, `packages/test-fixtures` | after foundation |
| WT-7 | Docs, registry, handoff templates, third-party notices, ADRs 0002–0005 drafts | **Haiku 4.5** | `wt/p1-docs` | `docs/**` except `BUILD_STATE.md`, `THIRD_PARTY_NOTICES.md`, runbook skeletons | **now** |
| WT-8 | Adversarial security review (read-only until findings accepted) | **Opus 5.5** | reads `phase-1/identity` | writes only `docs/reviews/phase-1-security.md` and negative-test requests | when WT-1 and WT-2 report ready |

Eight worktrees is above the spec's 3–4 early-phase guidance. The reason is explicit: the deadline. It is safe because WT-0 lands every shared file first (schema, migration, route index, nav, dependencies) so fan-out is file-disjoint.

## 6. Timeline (IST)

| Time | WT-0 | Parallel |
|---|---|---|
| 22:45–23:30 | Fix PR #1 (JSX, `verify` script, deploy JSON quoting, provisioning fallback, `.gitignore` worktrees). Merge to `main`. Watch deploy. Verify `/api/health`, `/api/version` = SHA, audited release row. Mark Phase 0 done. | WT-4 Agent and WT-7 Docs start from `phase-0/bootstrap` tip. |
| 23:30–00:20 | Create `phase-1/identity`. Land **foundation commit**: migration `0003_identity_tenancy_devices.sql` with every Phase 1–3 table, Drizzle schema, Better Auth generated tables, permission catalogue seed, `audit()` helper, route index, contracts package, admin-web stack install (Tailwind, shadcn, TanStack, RHF, input-otp), nav config, API client, route stubs. Push. Publish exact table/column names in `docs/handoffs/foundation.md`. | |
| 00:20 | Fan out WT-1, WT-2, WT-3, WT-5, WT-6 from `phase-1/identity`. | |
| 00:20–02:30 | Answer contract questions, keep `WORKTREE_REGISTRY` current, pre-merge small green branches. | All implementation worktrees. |
| 02:30–03:30 | Integrate WT-1 + WT-2 (+ WT-6 harness). Run full suite. WT-8 review. Fix. Merge Phase 1 to `main`. Deploy. **Live OTP login on box.affinityminds.in.** | WT-3, WT-5 finish. |
| 03:30–04:30 | Integrate WT-3, WT-5, WT-4. Deploy. Owner runs the Agent artifact on the Windows machine: install → enroll → Online in Fleet → entitlement downloaded → uninstall → machine clean. | WT-7 finalises docs. |
| 04:30–05:00 | Buffer. `BUILD_STATE.md`, evidence, handoffs, `ISSUE_LOG`. | |

## 7. Foundation contract (fixed names; fan-out builds against these, never guesses)

Migration `0003_identity_tenancy_devices.sql` (WT-0 only). Later numbers reserved: 0004 WT-1, 0005 WT-2, 0006 WT-3, 0007 WT-5. Only use a reserved number for a genuinely new need; report it in the handoff.

Tables:
- Better Auth: `user`, `session`, `account`, `verification` (generated, default names).
- `staff_members(user_id PK→user.id, role CHECK('super_admin','admin','support','read_only'), created_by, created_at)`
- `permissions(key PK, description)`; `role_permissions(role, permission_key, PK(role,permission_key))` seeded with the spec's catalogue (`tenant.view` … `audit.view`). Super Admin gets every key **as rows**, not a bypass.
- `tenants(id 'ten_…', public_code UNIQUE 'CBX-00481', display_name, legal_name, status CHECK('trial','provisioning','active','past_due','suspended','cancelled','archived'), primary_contact_email, support_contact_email, billing_contact_email, timezone, maintenance_window_json, renewal_warning_days INT, backup_policy_json, plan_code, notes, created_at, updated_at, archived_at)`
- `tenant_memberships(id, tenant_id, user_id, standing CHECK('owner','admin','user'), status CHECK('active','revoked'), invited_by, created_at, UNIQUE(tenant_id,user_id))`
- `enrollment_tokens(id, tenant_id, token_hash UNIQUE, label, created_by, expires_at, redeemed_at, redeemed_device_id, created_at)`
- `devices(id 'dev_…', tenant_id, name, status CHECK('enrolled','revoked','transferred'), device_public_key_jwk, device_key_thumbprint UNIQUE, key_protection CHECK('tpm','software'), hostname, windows_build, agent_version, last_seen_at, last_health_json, enrolled_at, revoked_at)`
- `device_credentials(id, device_id, token_hash UNIQUE, created_at, revoked_at)`
- `plans(code PK, name, max_devices, max_managed_users, features_json, offline_grace_days, renewal_warning_days)`
- `subscriptions(id 'sub_…', tenant_id, plan_code, status CHECK('trial','active','past_due','suspended','cancelled'), valid_from, valid_until, max_managed_users, features_json, offline_grace_days, renewal_warning_days, created_at, updated_at)`
- `entitlements(id 'lic_…', subscription_id, device_id, generation INT, claims_json, token TEXT, issued_by, issued_at, valid_until, revoked_at, UNIQUE(device_id,generation))` (`token` = compact JWE, never logged)
- `signing_keys(kid PK, alg, public_jwk, status CHECK('active','retired'), created_at)`; private key lives in secret `ENTITLEMENT_SIGNING_JWK`.
- `audit_log` gains `actor_tenant_id`, `correlation_id`, `source` via ALTER TABLE. `actor_type` values: `user`, `device`, `system`, `bootstrap-admin`.

Server: `src/db/schema.ts` (WT-0), `src/audit.ts` `audit(db, {eventType, entityType, entityId, actor, before, after, correlationId})`, `src/authz/permissions.ts` catalogue + `requirePermission(key)` + `requireTenantStanding('owner'|'admin'|'user')`, `src/routes/v1/index.ts` one `route.route('/x', x)` line per module.

Agent API (WT-3 server, WT-4 client), all under `/api/v1/agent/*`:
- `POST /enroll` body `{ token, device: { hostname, windowsBuild, agentVersion, keyProtection: 'tpm'|'software', publicKeyJwk: { kty:'RSA', n, e } } }` → `201 { deviceId, tenantId, tenantCode, deviceName, deviceToken }`. Token is single-use, TTL from row, hash compare.
- `POST /heartbeat` Bearer deviceToken, body `{ health: AgentHealth }` (spec §29 document) → `{ serverTime, entitlementGeneration, commands: [] }`.
- `GET /entitlement` Bearer deviceToken → `{ entitlement: <compact JWE>, generation }` or 404 when none issued.

Entitlement: claims per spec §9.3 + `iss:'cloudbox'`, `kid`. JWS ES256 → JWE `alg:'RSA-OAEP-256', enc:'A256GCM'`, `typ:'cbx-entitlement+jwt'`. Windows verifies with `System.IdentityModel.Tokens.Jwt` / `Microsoft.IdentityModel.Tokens` (decrypt with TPM key, verify ES256 with pinned server public JWK).

## 8. Shared-file rules for every worktree

- Never `git stash`. Commit to your branch or use a patch file.
- Do not edit `schema.ts`, migration `0003`, `routes/v1/index.ts` beyond adding one line, `nav.ts`, root or app `package.json`, `pnpm-lock.yaml`, workflows, `BUILD_STATE.md`. Need a dependency or column? Write it in your handoff under "Requests to WT-0" and continue with a local stub.
- Every slice is closed: migration (if reserved) → API with Zod validation → server authorisation → UI reachable from nav → audit → tests (happy + permission boundary) → literal demo path → handoff committed.
- Tests: `pnpm run verify` must be green in your worktree before you report ready. Worktrees are gitignored and excluded from vitest globs by the foundation commit.
- Commit author `Soren Singh Dary <67230851+sorensd@users.noreply.github.com>`. No agent co-author trailers. Never push to `main`.
- Rendered UI needs a screenshot in `docs/evidence/<wt>/` before "done".

## 9. Deferred tonight (explicitly, not forgotten)

Status app UI, Tailscale mesh/Connect (see ALPHA_v0.1.md), RDP gate, RDP Wrapper install, managed users, backups, OTA, break-glass, tenant portal beyond membership switch, realtime WebSocket, alerts. Each keeps its spec phase; nothing is descoped, only sequenced. Every later component that installs anything must register into the uninstall manifest from Slice 2.5.

## 10. Uninstall contract (Slice 2.5, owned by WT-4, binding on every later Windows slice)

- Every install action appends a manifest entry `{kind, id, createdAt, priorState}` before it takes effect: `service`, `directory`, `file`, `registry_key`, `registry_value` (with prior value), `firewall_rule`, `local_user`, `local_group_membership`, `scheduled_task`, `cng_key`, `event_log_source`, `windows_setting` (e.g. `fDenyTSConnections` prior value), `third_party_component` (installer path + silent uninstall command), `arp_entry`.
- `CloudBox.Agent.exe uninstall [--purge-data] [--keep-logs] [--offline]` replays the manifest in reverse, restores every `priorState`, stops and deletes the service, deletes the TPM/CNG key, removes the named pipe ACL artefacts, removes the ARP entry, tells the cloud `POST /api/v1/agent/uninstalled` (best effort, audited `DEVICE_UNINSTALLED`, device marked revoked) unless `--offline`, then deletes `C:\\ProgramData\\CloudBox` and `C:\\Program Files\\CloudBox` last, and finally deletes itself via a detached `cmd /c ping -n 3 127.0.0.1 >nul & del` step. It prints a verification report listing every manifest entry and `removed`/`restored`/`missing`.
- `--purge-data` is the only path that touches `D:\\CloudBoxData` / backup folders, requires typing the machine name, and is logged as `SECURITY`.
- `CloudBox.Agent.exe verify-clean` runs after uninstall and exits non-zero if any manifest kind still exists (service, directory, registry, firewall rule, user, group, key, task, ARP entry). This is the acceptance test on the lab machine.
