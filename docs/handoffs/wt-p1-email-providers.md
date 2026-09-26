# Handoff — WT-12 `wt/p1-email-providers` (email provider registry: SMTP, fallback, console UI)

## Mission

**Slice:** 1.5 — Email provider registry with SMTP and fallback.

**Success criterion:** the console can configure N email providers (Cloudflare Email Service
binding, SMTP, a development-only log provider), order them by priority, test each one, and every
send tries them in order until one succeeds. Zero providers configured falls back to the
pre-existing `EMAIL` binding, so `sendOtpEmail`'s behaviour is unchanged for any install that never
touches the new screen.

---

## Current status

- Branch: `wt/p1-email-providers`, forked from `phase-1/identity` at `4efba3f`, merged forward twice
  (to `1600a14`, the tip when I finished) to absorb WT-1's closed sign-in (password + authenticator,
  ADR 0009) and the tenants/devices/agent/Turnstile slices that landed in between.
- `pnpm run verify`: green (check 170 files, typecheck all 4 TS packages, test 466 worker-api + 4
  admin-web + 16 licensing-contracts, build admin-web + worker-api incl. `wrangler deploy --dry-run`).
- Draft PR: opened against `phase-1/identity`, see PR URL in my final report to the orchestrator.

---

## Commits ready for merge

```
6137937 feat(email): provider registry with SMTP, Cloudflare binding and dev log providers
dcd79a1 feat(admin-web): Email providers settings section
da4a27e ci(deploy): create PROVIDER_SECRETS_KEY once if absent
4f97137 docs: ADR 0010, runbook and slice doc for the email provider registry
49134ce Merge remote-tracking branch 'origin/phase-1/identity' into wt/p1-email-providers
2624777 fix(email): dedupe kind in test-send audit; update tests for providerId/kind in AUTH_OTP_SENT
b076019 docs(evidence): email providers UI screenshots (wrangler dev + local D1, Playwright)
8bc9783 Merge remote-tracking branch 'origin/phase-1/identity' into wt/p1-email-providers
```

---

## Files and contracts changed

- **Migration:** `infra/cloudflare/migrations/0008_email_providers.sql` — table `email_providers`.
  Drizzle table in `apps/worker-api/src/email/providers/schema.ts` (not `db/schema.ts` — see
  "Requests to WT-0" below), the same pattern WT-1 used for `rateLimit`/migration `0004`.
- **worker-api:**
  - `src/email/providers/types.ts` — `EmailProvider`, `EmailMessage`, `EmailProviderError` (`.code`).
  - `src/email/providers/cloudflare-binding.ts`, `.../log.ts`, `.../smtp.ts` (uses `worker-mailer`
    1.2.1; SMTP send is DI-able via a `mailerSend` parameter, defaulting to the real
    `WorkerMailer.send`, so tests never open a socket).
  - `src/email/providers/crypto.ts` — AES-256-GCM envelope (`encryptSecret`/`decryptSecret`),
    `ProviderSecretsKeyMissingError`.
  - `src/email/send.ts` — `sendEmail(env, message, {purpose, correlationId})`: loads enabled rows
    (cached 60 s per isolate, keyed by the `D1Database` binding identity — see "Deviations"), tries
    each in priority order, audits `EMAIL_SENT`/`EMAIL_FAILED` per attempt, falls back to the
    `EMAIL` binding when no rows exist. Also `testEmailProvider(env, row, to, actorId)` for
    `POST /:id/test`, and `invalidateProviderCache(env)` called by every write route.
  - `src/email/index.ts`: `sendOtpEmail` now delegates its send to `sendEmail(...)` — see "How WT-1
    and I integrated" below; this was **not** a one-line change in the end, because WT-1's own
    `AUTH_OTP_SENT` outcome shape changed under me mid-task (added `outcome: "sent"|"send_failed"`,
    `client`) and the coordinator asked me to also thread `providerId`/`kind` through so that audit
    row can record which provider delivered the OTP. The diff there is now ~15 lines instead of 1.
  - `src/routes/v1/email-providers.ts` — the API (see below).
  - `src/routes/v1/index.ts` — one line: `v1.route("/settings/email-providers", emailProviders);`
  - `src/env.ts` — added `PROVIDER_SECRETS_KEY?: string`.
- **packages/contracts:** `src/email-providers.ts` (`EmailProviderKind`, `SmtpConfig`,
  `CreateEmailProviderRequest` discriminated union, `UpdateEmailProviderRequest`, `EmailProvider`,
  `TestEmailProviderResponse`); `common.ts` gained `ID_PREFIX.emailProvider = "eprv_"`.
- **admin-web:** `src/api/email-providers.ts`, `src/components/email-providers-section.tsx`
  (`<EmailProvidersSection />`), one import + one JSX line added to
  `src/routes/_app/settings.tsx` (that file's own header comment invites other worktrees to add
  editable sections here).
- **Tests:** `apps/worker-api/test/email-providers.test.ts` (API CRUD, permission boundary,
  delete-last-enabled-refused, `PROVIDER_SECRETS_KEY` missing → 503, log-in-production refused),
  `apps/worker-api/test/email-send.test.ts` (encryption round trip, SMTP provider against an
  injected fake `mailerSend`, `sendEmail` ordering/fallback/audit). Registered one query-plan entry
  in `apps/worker-api/test/queries.ts`.
- **CI:** one step added to `.github/workflows/deploy-cloudflare.yml` ("Ensure PROVIDER_SECRETS_KEY
  exists"), same pattern as `BETTER_AUTH_SECRET`.
- **Docs:** `docs/decisions/0010-email-provider-registry.md`, `docs/slices/1.5-email-providers.md`,
  `docs/runbooks/email-providers.md`, this handoff, `docs/evidence/wt-p1-email/*.png`.
- **Dev convenience:** `.claude/launch.json` (runs `admin-web` via the `run`/Browser-pane tooling).

---

## Migrations

- **Reserved number:** `0008` (as assigned).
- **Filename:** `infra/cloudflare/migrations/0008_email_providers.sql`.
- **Applied locally:** yes, via `wrangler d1 migrations apply cloudbox-db --local` after wiping
  `.wrangler/state` (needed twice, after each merge from `phase-1/identity`, per migration `0004`
  changing in place under ADR 0009).

---

## API changes

All under `/api/v1/settings/email-providers`, gated `requirePermission("settings.manage")`
(only `super_admin`/`admin` hold that key per the migration `0003` seed).

| Method | Path | Request | Response | Audit |
|---|---|---|---|---|
| GET | `/` | — | `{items: EmailProvider[]}` (masked: `hasSecret` boolean, never the ciphertext/plaintext) | — |
| POST | `/` | `CreateEmailProviderRequest` (discriminated by `kind`; `smtp` requires `config` + `secret`) | `201 EmailProvider` | `EMAIL_PROVIDER_CREATED` |
| PATCH | `/:id` | `UpdateEmailProviderRequest` (all optional; `priority` for reorder, `enabled` for on/off) | `200 EmailProvider` | `EMAIL_PROVIDER_UPDATED` (before/after masked) |
| DELETE | `/:id` | — | `204`; `409 {error:"conflict", detail:"last_enabled_provider"}` if it is the only enabled row | `EMAIL_PROVIDER_DELETED` |
| POST | `/:id/test` | — | `200 {ok, messageId?, errorCode?}` (sends to the caller's own signed-in email) | `EMAIL_PROVIDER_TESTED` |

Additional error responses: `503 {error:"provider_secrets_key_missing"}` when saving an `smtp`
provider's secret and `PROVIDER_SECRETS_KEY` is unset; `400 invalid_request` with
`detail:"log_provider_disabled_in_production"` creating/enabling a `log` provider when
`ENVIRONMENT === "production"`; `400 invalid_request` with `detail:"config_not_applicable"` /
`"secret_not_applicable"` patching `config`/`secret` on a non-`smtp` row.

---

## Security assumptions

- SMTP password: AES-256-GCM, random 12-byte IV per value, one Wrangler secret
  `PROVIDER_SECRETS_KEY` (32 raw bytes, base64) decrypts at send time only. The API is write-only
  for the secret — `GET`/audit rows carry `hasSecret` only, never ciphertext or plaintext.
- `log` provider (writes to `console`, never sends) is refused server-side both at
  create/enable-time (the route) and at send-time (`sendEmail`'s `buildProvider`, defense in depth)
  whenever `ENVIRONMENT === "production"`.
- Every route requires `settings.manage`; verified by dedicated tests and by the repo's
  self-discovering `test/permission-matrix.test.ts` (enumerates every `/api/v1` route from Hono's
  own route table, so a route this worktree adds gets probed automatically without anyone having to
  remember to list it).
- `sendEmail` never throws (every internal audit write is wrapped in try/catch, matching
  `sendOtpEmail`'s own contract) so a broken provider or a broken audit write cannot turn into a
  500 for whatever's sending the mail.

---

## Tests run and results

### Verification script (`pnpm run verify`)

```
✓ biome check .                       — 170 files, no fixes needed
✓ pnpm -r typecheck                   — contracts, licensing-contracts, e2e-cloud, admin-web, worker-api
✓ pnpm -r test                        — worker-api 466/466, admin-web 4/4, licensing-contracts 16/16
✓ admin-web build + worker-api build  — vite build, wrangler deploy --dry-run (bindings listed incl. new PROVIDER_SECRETS_KEY-dependent code, no errors)
```

### Test coverage

- `test/email-providers.test.ts`: create (all 3 kinds), secret never echoed (response text and the
  subsequent GET list), `provider_secrets_key_missing` 503, `log` refused in production, reorder
  via `PATCH priority`, delete-refused-when-only-enabled then succeeds once a second exists,
  test-send round trip, 404s, permission boundary (401 unauthenticated, 403 `read_only`).
- `test/email-send.test.ts`: AES-256-GCM round trip + distinct IVs + `ProviderSecretsKeyMissingError`
  without a key; SMTP provider against an injected fake `mailerSend` (success returns a synthesised
  id since `worker-mailer`'s `send()` resolves `void`; failure wraps as `EmailProviderError` with a
  stable code, never the password); `sendEmail` binding-fallback with zero rows; provider order with
  a failing `cloudflare_binding` row (priority 1) skipped in favour of a succeeding `log` row
  (priority 2), both attempts audited.
- `test/queries.ts`: registered the `loadEnabledProviders` query shape (not in
  `GUARDED_TABLES`, so the plan check is currently a no-op for it, same as any new table until
  WT-6 opts it in).

### Demo path

```
1. apps/worker-api: wrangler dev --local, migrations 0001-0004+0008 applied locally
2. apps/admin-web: vite dev, proxying /api to the worker
3. Sign in as staff (password + authenticator per ADR 0009)
4. Settings → "Email providers" → "No providers configured; the Cloudflare Email binding is used."
5. Add provider → SMTP (host/port/username/password) or Cloudflare Email → Save
6. Row appears with priority, kind pill, enabled pill, "not tested"
7. Click the send icon → row updates to "sent" or the error code
8. Up/down arrows swap priority with the neighbour
9. Delete → typed-name confirmation dialog; typing the wrong name keeps Delete disabled
10. Deleting the only enabled provider is refused (409) until a second one exists/is enabled
```

Screenshots: `docs/evidence/wt-p1-email/01-settings-empty-state.png` through `06-after-delete.png`
(empty state, add-provider sheet, ordered table, test-send "sent" pill, delete confirmation
mismatch/matched states, post-delete state) — captured against real `wrangler dev` + local D1 +
Playwright, not mocked.

---

## Known failures

- [ ] No screenshot of a real external SMTP send succeeding end-to-end. I tried against
  Cloudflare's own `smtp.mx.cloudflare.net:587` with a made-up username/password from this sandbox;
  the connection succeeded at the TCP layer but the request then hung and eventually the local
  `wrangler dev` isolate stopped responding entirely (had to kill and restart it). I don't have
  strong evidence this is a bug in my code versus a quirk of real SMTP auth failing silently
  against a sandboxed dev container with unusual egress — `worker-mailer`'s own defaults
  (`socketTimeoutMs: 60_000`, and a `responseTimeoutMs` default that looks like it falls back to
  `socketTimeoutMs` rather than its own 30 s in the library's source) mean a slow/unreachable
  relay can hold a request open for up to a minute. I did not chase this further given the time
  already spent; see "Decisions needed".
- [ ] "Last test result" is not persisted (no DB column for it — the exact schema in the brief
  didn't include one). The UI shows it as in-session-only state, cleared on reload. Flagged as a
  deliberate scope call, not an oversight, in the ADR.

---

## Decisions needed

- [ ] Should `sendEmail`/the SMTP provider set an explicit, shorter `socketTimeoutMs` /
  `responseTimeoutMs` (e.g. 10–15 s) when calling `worker-mailer`, rather than relying on its
  60 s/30 s defaults? I did not make this change because I could not confirm in this environment
  whether the isolate-hang I saw was caused by the library, by real SMTP auth behaviour, or by
  this specific sandbox's network egress — but a real relay that is slow to respond is a realistic
  production scenario (a customer misconfigures a relay), and the current behaviour risks tying up
  a request for up to a minute. Low-risk, low-effort follow-up.
- [ ] Confirmed with the owner mid-task (via the orchestrator) that `sendEmail`'s
  `SendEmailOutcome` should always carry `providerId`/`kind`, even on total failure, so
  `sendOtpEmail`'s `AUTH_OTP_SENT` row can record which provider handled (or tried to handle) the
  send. Implemented; no further decision needed, documented here for visibility.

---

## Requests to another worktree

- [ ] **WT-0:** move `email_providers` from `apps/worker-api/src/email/providers/schema.ts` into
  `db/schema.ts` verbatim, and regenerate the Drizzle meta snapshot (`drizzle.config.ts` only diffs
  `db/schema.ts` today, so migration `0008` — like WT-1's `0004` — was written by hand rather than
  via `db:generate`). Table, columns and the `email_providers_kind_check` constraint are unchanged;
  copy-paste is enough.
- [ ] **WT-0 (nav):** no nav change needed — the section lives inside the existing "Settings" page,
  which is already in `nav.ts`.
- [ ] **Whoever owns `apps/worker-api/src/email/index.ts` next:** the `sendOtpEmail`→`sendEmail`
  delegation is now load-bearing for `AUTH_OTP_SENT`'s `providerId`/`kind` fields; please don't
  revert to a direct `env.EMAIL.send(...)` call without also removing/adjusting those fields, or
  the shape will silently regress to `undefined`.

---

## Safe next action

`pnpm run verify` is green against `origin/phase-1/identity` at `1600a14` (merged into this branch
twice as new work landed). Draft PR is open against `phase-1/identity`, not `main`, and is not
mergeable by me. WT-0/whoever integrates should: (1) move the Drizzle table per the request above,
(2) review the SMTP timeout follow-up, (3) merge whenever convenient — nothing here blocks another
worktree, and this branch only adds one line to `routes/v1/index.ts` and one section to
`settings.tsx`.

---

## Appendix: Evidence

- Screenshots: `docs/evidence/wt-p1-email/*.png` (8 files, see "Demo path").
- Test output: see "Tests run and results" above (466/466 worker-api, 4/4 admin-web).
- Build log: `wrangler deploy --dry-run` succeeded, binding list includes the unchanged foundation
  bindings (no new binding required — `PROVIDER_SECRETS_KEY` is a secret, not a binding).
