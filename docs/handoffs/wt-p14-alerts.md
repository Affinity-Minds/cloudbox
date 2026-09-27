# Handoff: WT-17 — Alerts, evaluator cron, notifications (Slices 14.1-14.2)

**Status:** Ready for review (draft PR against `phase-2/devices`)
**Date:** 2026-09-27
**Branch:** `wt/p14-alerts` (from `phase-2/devices` @ `33862a5`)

---

## Mission

**Slices:** 14.1 (normalized event model → the `alerts` table), 14.2 (alert routing/notification).

**Success criterion:** a stateful alert opens automatically when a device goes offline, a
tenant's license nears/passes expiry, an enrolled device has no active plan, or the agent's last
reported health shows RDP/network/disk/reboot trouble; it resolves automatically when the
condition clears; staff can see, filter, acknowledge and resolve alerts on a new Alerts page;
warning/critical alerts email the tenant's contact and a staff distribution list, at most once
every 6 hours per condition; every open/resolve transition is audited.

---

## Current status

- Branch: `wt/p14-alerts`, parent `phase-2/devices`
- `corepack pnpm run verify`: **green, exit 0** (see "Tests run and results")
- No stub test modules to drop — this is a wholly new slice, not filling in an existing stub.

---

## Files and contracts changed

**New (mine):**
- `apps/worker-api/src/alerts/evaluate.ts` — the evaluator (`evaluateAlerts`, `dedupeKeyFor`).
- `apps/worker-api/src/alerts/notify.ts` — email notifications, cooldown.
- `apps/worker-api/src/alerts/settings.ts` — `alerts.staff_recipients` get/set.
- `apps/worker-api/src/alerts/view.ts` — `toAlert()` row → contract mapper, shared by every route.
- `apps/worker-api/src/routes/v1/alerts.ts` — acknowledge/resolve + the `alertsSettings` router.
- `apps/worker-api/src/routes/v1/me-alerts.ts` — `GET /me/alerts` (second router mounted at `/me`).
- `apps/worker-api/src/routes/v1/screens/alerts.ts` — `GET /screens/alerts`.
- `apps/worker-api/test/alerts.test.ts` — 15 tests (see below).
- `packages/contracts/src/alerts.ts` — `Alert`, `AlertCategory/Severity/Status`, `AlertsScreen`,
  `MeAlertsResponse`, `AlertsSettings`, `UpdateAlertsSettingsRequest`, `ALERT_CATEGORY_LABEL`.
- `apps/admin-web/src/routes/_app/alerts.tsx` — the Alerts page.
- `apps/admin-web/src/api/alerts.ts` — API client.
- `apps/admin-web/src/components/alerts-settings-section.tsx` — Settings → "Alerts" section.
- `infra/cloudflare/migrations/0015_alerts.sql` + `meta/0015_snapshot.json` — reserved migration.
- `docs/slices/14.1-14.2-alerts.md`, this handoff. `docs/evidence/wt-p14-alerts/*` — not yet
  captured, see "Screenshots" below.

**Edited (additive, all pre-authorised by the brief — see "Requests to another worktree" for the
one item that still needs a look from an owner):**

| File | Owner | Change |
|---|---|---|
| `apps/worker-api/src/db/schema.ts` | WT-0 | `alerts` table + `ALERT_CATEGORIES/SEVERITIES/STATUSES` consts |
| `apps/worker-api/src/routes/v1/index.ts` | WT-0 | 3 lines: mount `alerts`, `alertsSettings`, `meAlerts` |
| `apps/worker-api/src/routes/v1/screens/index.ts` | WT-0 | 1 line: mount `alerts` screen |
| `apps/worker-api/src/routes/v1/screens/overview.ts` | WT-0 | `alerts: {open, critical}` in the existing `db.batch` |
| `apps/worker-api/src/index.ts` | WT-0 | `import evaluateAlerts`; `runAlertsCron()`; `scheduled` attached to the same exported `app` object via `Object.assign` (no change to `.request`/`.fetch`) |
| `apps/worker-api/wrangler.jsonc` | WT-0 | `triggers.crons: ["*/5 * * * *"]` |
| `packages/contracts/src/screens.ts` | WT-0 | `OverviewScreen.alerts` (additive) |
| `packages/contracts/src/agent.ts` | WT-3/4 | `AgentHealth.storage.total_bytes`, optional (additive) — see "Decisions needed" |
| `packages/contracts/src/common.ts` | WT-0 | `ID_PREFIX.alert = "alrt_"` |
| `packages/contracts/src/index.ts` | WT-0 | `export * from "./alerts"` |
| `apps/admin-web/src/nav.ts` | WT-0 | `alerts` entry, "Operate" group, after "fleet" |
| `apps/admin-web/src/routes/_app/index.tsx` | WT-0 | 5th Overview tile, "Open alerts" |
| `apps/admin-web/src/routes/_app/settings.tsx` | WT-0 | `<AlertsSettingsSection/>` |
| `apps/admin-web/src/routeTree.gen.ts` | generated | regenerated (`vite build`) to include `/alerts` |

**Not touched:** `routes/v1/agent.ts` (heartbeat) — per the brief, alert state is derived from D1
on the evaluator's own schedule, never from the heartbeat request path.

---

## Migrations

- **Reserved number:** `0015` (as assigned).
- **Filename:** `infra/cloudflare/migrations/0015_alerts.sql` — one `CREATE TABLE alerts` + 4
  indexes (see the slice doc for the exact column list).
- Generated via `drizzle-kit generate` against the schema addition, renamed from its auto-assigned
  name to `0015_alerts.sql`/`0015_snapshot.json`, journal tag updated. A second `db:generate`
  reports **"No schema changes, nothing to migrate"** — reconciled, as required.
- Applied locally via `wrangler d1 migrations apply cloudbox-db --local` for the evidence capture.

---

## API changes

See `docs/slices/14.1-14.2-alerts.md` "API changes" for the full table. Summary: `GET
/screens/alerts` (`device.view`), `POST /alerts/:id/acknowledge|resolve` (`device.manage`), `GET
/me/alerts` (customer session, membership-scoped), `GET`/`PATCH /settings/alerts`
(`settings.manage`).

---

## Security assumptions

- Every new route is gated server-side; none of it trusts a client-supplied tenant id (`/me/alerts`
  re-resolves `tenant_memberships` per request).
- The evaluator's writes use `actor: {type: "system", id: "alerts-evaluator"}` and `source: "cron"`,
  distinct from a staff acknowledge/resolve (`actor: user`, `source: "api"`) in the audit log.
- No secret material ever enters `alerts.last_evidence_json` (health-state strings, timestamps,
  byte counts only).
- `sendEmail`'s own contract (never throws) is relied on as-is; a broken email provider cannot
  crash the evaluator or leave alerts un-reconciled.

---

## Tests run and results

### `corepack pnpm run verify`

```
$ biome check .                Checked 224 files. No fixes applied. (1 pre-existing warning, tests/e2e-cloud)
$ pnpm -r typecheck             licensing-contracts, contracts, tests/e2e-cloud, worker-api, admin-web: Done
$ pnpm -r test
  packages/licensing-contracts  Test Files 2 passed (2)    Tests 16 passed (16)
  apps/admin-web                Test Files 3 passed (3)    Tests 13 passed (13)
  apps/worker-api                Test Files 35 passed (35)  Tests 667 passed (667)
$ pnpm build                   admin-web ✓ built; worker-api wrangler deploy --dry-run OK
EXIT 0
```

(Full tails saved as /tmp/verify-output6.log in the session that ran it; not committed —
see the PR description for the exact green tail instead.)

### `test/alerts.test.ts` (15/15, new)

- Opens once on `device_offline`; re-running with the condition unchanged adds no second row and
  no second `ALERT_OPENED` audit; resolves once when the device comes back online; re-running
  online adds no second `ALERT_RESOLVED`; going offline again **reopens the same row** (same id,
  same `dedupe_key`) rather than inserting a duplicate — `ALERT_OPENED` audited a second time
  (a genuine transition).
- `no_active_plan` opens for an enrolled device with no live entitlement and no issuable
  subscription.
- `license_expiring` (inside the renewal window, warning) and `license_expired` (past
  `valid_until`, critical), both tenant-scoped (`deviceId` null).
- Health-derived: `rdp_unhealthy`, `private_network_failed`, `reboot_required` (info),
  `disk_low` (critical at 5% free) all open from one `last_health_json` document; a document with
  `free_bytes` but no `total_bytes` does **not** open `disk_low` (older-agent case).
- Notification cooldown: notifies once on open, withholds on a same-alert re-run inside 6h,
  notifies again once 7h have passed — asserted by per-alert-id audit counts and `notified_at`
  equality, not the evaluator's aggregate return value (the shared test D1 accumulates other
  tests' alerts, so an aggregate assertion would be flaky; see the file's own comment).
- `app.scheduled(controller, env, ctx)` (via `cloudflare:test`'s `createScheduledController`)
  resolves without throwing.
- `GET /screens/alerts`: 401 anonymous, 200 for `read_only` (holds `device.view`), filters by
  status/severity/tenant correctly, and the loader stays within 3 D1 round trips beyond auth
  (`countingD1`).
- Acknowledge → resolve happy path; 409 on a second resolve; 404 unknown id; 403 for `read_only`.
- `GET /me/alerts`: a tenant member sees their tenant's alert; an unrelated signed-in user sees an
  empty list; 401 anonymous.
- `GET`/`PATCH /settings/alerts`: round-trips the recipient list; 403 for `read_only`.
- Idempotence: running the evaluator three times with nothing changed adds no audit rows.

Full suite: 667/667 worker-api (34 pre-existing files/652 tests + this branch's own
`alerts.test.ts`, 1 file/15 tests) — pre-existing tests confirmed still green, no regressions.

### Demo path

See `docs/slices/14.1-14.2-alerts.md` "Demo path" and the screenshots below.

---

## Screenshots

**Not captured in this session — flagged, not silently skipped.** Local `wrangler dev` (worker
API) and `wrangler d1 migrations apply --local` (including `0015_alerts.sql`) both ran
successfully against this branch, and the API was reachable. Capturing the Alerts/Settings pages
themselves needs the Browser-pane tooling, which this session's tool broker refused every call to
(`preview_list`, `navigate`, `tabs_context`, even a plain file `Read` at one point) with "the user
doesn't want to take this action right now" — a permission gate this run could not get past, not
a rendering or app bug. Whoever picks this up next: `docs/evidence/wt-p14-alerts/` does not yet
exist; the demo path above is the literal set of clicks to capture it once browser tooling is
available.

---

## Known failures

- `pnpm run verify` is green (see above), reproduced from a clean state.
- **No UI screenshots this session** (see "Screenshots") — the one item in the brief's deliverable
  list not completed. Everything else (migration, evaluator, notifications, API, UI code, tests,
  docs) is done and tested.
- Real email delivery was exercised only through the dev-mode fallback/log path (same limitation
  every other worktree's email-touching slice has noted) — this branch does not configure a real
  SMTP/Cloudflare Email provider itself; `sendEmail`'s own provider registry (WT-12) is unchanged.
- `pnpm run verify` was flaky under this shared host's load (other worktrees' concurrent test runs
  drove load average past 150 on a 16-core box at one point — confirmed via `ps aux`/`uptime`, not
  caused by this branch): three consecutive full-suite attempts each failed a different, unrelated
  set of pre-existing timing/rate-limit tests (OTP attempt windows, IP-bucket limits), never the
  same file twice, never anything in `src/alerts/**`. A fourth attempt at lower load passed clean
  (667/667 worker-api, 13/13 admin-web, 16/16 licensing-contracts, both builds). Retry if CI shows
  an unrelated flake.

---

## Deviations from the brief

See `docs/slices/14.1-14.2-alerts.md` "Deviations from the brief" for the full list and reasoning
(`AgentHealth.storage.total_bytes` addition, health-derived severities, query-plan registry
scope, and the "cooldown repeats, not once-ever" reading of the notification rule). Summary:

- Added `AgentHealth.storage.total_bytes` (optional) — `disk_low`'s §24 thresholds are percentages,
  and the existing contract only had an absolute `free_bytes`.
- Categories evaluated are exactly the brief's explicit list (`device_offline`, `license_expiring`,
  `license_expired`, `no_active_plan`, `rdp_unhealthy`, `private_network_failed`, `disk_low`,
  `reboot_required`); the other 7 in the CHECK constraint are valid rows, not evaluated yet
  (belong to phases 9-12, not built).
- Did not append the evaluator's own internal batch queries to `test/queries.ts` — they are
  deliberate whole-table scans in a 5-minute background job, not request-path loaders (the
  convention and its regression test target the latter). The two request-path queries
  (`screens/alerts.ts`, `me-alerts.ts`) join by primary key throughout and are covered by this
  branch's own round-trip-ceiling test instead.

---

## Decisions needed

- [ ] **WT-3/WT-4 (Windows agent):** please start sending `storage.total_bytes` in the
  `AgentHealth` heartbeat payload once convenient — without it, `disk_low` is never evaluated for
  that device (silently skipped, not a false positive, but also not the coverage the brief asked
  for). Field is optional/additive so nothing breaks in the meantime.
- [ ] **Notification cadence:** confirm the "repeats every 6h while open" reading (documented in
  the slice doc) is the intended one, versus "notify once at open, then never again for that
  alert." Easy one-line change in `notify.ts`'s `dueForNotification` if the latter is wanted.

---

## Requests to another worktree

- [ ] **WT-3/WT-4:** see "Decisions needed" above — `total_bytes` in the health payload.
- [ ] **Whoever next touches `routes/v1/agent.ts`:** nothing required of you; alert state reads
  `devices.last_seen_at`/`last_health_json` after your writes land, on its own 5-minute schedule.
  Please don't add a direct call into `src/alerts/*` from the heartbeat handler — that was the one
  hard constraint in this worktree's brief, and it's already satisfied; keep it that way.
- [ ] **WT-0:** nothing blocking; the schema/nav/routes/screens edits above are all one-line
  additions in files you own, following the established per-owner convention in those files.

---

## Safe next action

Review and merge this draft into `phase-2/devices`; nothing here blocks or is blocked by anything
else outstanding on that branch. The Cron Trigger needs no additional secret or binding — it reads
existing D1 state only — so once deployed it starts evaluating on the next scheduled tick with no
further setup, beyond optionally setting `alerts.staff_recipients` from the Settings page.
