# CloudBox issue log

Newest first. Record only non-obvious failures or fixes with meaningful blast radius.

## 2026-09-27 — Enrollment redeem update failed its FK before the device existed (WT-3)
**Symptom:** `POST /agent/enroll` answered 500 with `FOREIGN KEY constraint failed` on the very first successful-looking enrollment, inside the conditional token-redemption `UPDATE`.

**Cause:** Following agent-notes' "run the conditional update alone, then batch the rest" rule literally, the redeem `UPDATE` set both `redeemed_at` and `redeemed_device_id` in the same statement — but `redeemed_device_id` references `devices.id`, and the device row is only created in the batch that comes *after* the conditional update. D1 enforces the FK immediately, not deferred to commit.

**Fix:** Split the concerns: the standalone conditional update claims the token by setting `redeemed_at` only (still checked with `.returning()`, still run before anything else); `redeemed_device_id` is set by a third statement inside the same `db.batch` as the device insert, ordered after it so the FK is satisfied within the transaction.

**Blast radius:** Any conditional-claim-then-link pattern where the linked-to row doesn't exist yet. Generalizes the existing "conditional update run alone" note: the *columns in that update* still can't reference a row created later in the batch.

**Verification:** `apps/worker-api/test/agent.test.ts` — enroll happy path, reuse, duplicate-key-with-retry.

## 2026-09-27 — `formatAgo` always said "ago", even for a future timestamp (admin-web)
**Symptom:** The Enrollment page's "Expires" column read "expires 24 hours ago" for a token that expires in the future.

**Cause:** `lib/time.ts`'s `formatAgo` hard-appended the literal string `" ago"` to `formatDistanceToNowStrict()`. Every caller before WT-3's enrollment tokens only ever passed a past timestamp (`lastSeenAt`, `createdAt`, audit rows), so the bug was latent until the first future-dated field.

**Fix:** Pass `{ addSuffix: true }` instead, which date-fns renders as "X ago" for the past and "in X" for the future — no call-site changes needed.

**Blast radius:** `apps/admin-web/src/lib/time.ts` is shared; every existing caller keeps its exact previous output (all past dates), so this is additive.

**Verification:** Enrollment page screenshot (`docs/evidence/wt-p2-enrollment/04-enrollment-list-active-token.png`) reads "in 24 hours"; `apps/admin-web` test suite still green.

## 2026-09-27 — Drizzle `db.batch` on D1 silently shifted joined columns (WT-5)
**Symptom:** Entitlement issuance answered `409 device_not_enrolled` for an enrolled device; a screen query failed with `ambiguous column name: generation`.

**Cause:** Drizzle's D1 batch path turns each row object into an array with `Object.values` and then maps by position. A select over a join that returns two columns with the same SQL name (`devices.status` and `subscriptions.status`, `devices.id` and `subscriptions.id`) collapses to one key, so every later field shifts by one. The same query run alone (not in a batch) is fine, which hides it. Separately, a subquery alias equal to a real column name (`max(generation) as generation`) is ambiguous in the outer join.

**Fix:** In batched selects, alias every duplicated column name (`sql\`${devices.status}\`.as("device_status")`) and give aggregates distinct aliases (`max_generation`). Comment at the query in `src/entitlement/service.ts`.

**Blast radius:** Any `db.batch([...])` containing a join that selects same-named columns from two tables. Screen loaders are the usual place (fast-data-hydration pushes everything into one batch).

**Verification:** `test/subscriptions.test.ts` issuance and screen tests.

## 2026-09-27 — Zod `.partial()` kept a `.default()`: an empty PATCH would have re-activated a subscription (WT-5)
**Symptom:** `CreateSubscriptionRequest.omit({planCode}).partial().parse({})` returned `{ status: "active" }`.

**Cause:** In Zod 4, `.partial()` wraps a field that has `.default()`; the default still fills a missing value.

**Fix:** `UpdateSubscriptionRequest` is spelled out with optional fields and no defaults, plus a "at least one field" refinement.

**Blast radius:** Any update schema derived with `.partial()` from a create schema that has defaults (agent-notes cloudflare-workers #16 is the sibling: defaults only exist after `parse`).

**Verification:** `PATCH /subscriptions/:id` with `{}` answers 400; covered in `test/subscriptions.test.ts`.

## 2026-09-27 — A developer's `.dev.vars` changed worker test results
**Symptom:** `a mail failure still answers 200 and records the error code` passed, then failed after `wrangler dev` was set up locally: the audit row read `{echoed:true}` instead of `{errorCode:…}`.

**Cause:** `@cloudflare/vitest-pool-workers` reads `wrangler.jsonc` **and** `apps/worker-api/.dev.vars`, so a local `OTP_DEV_ECHO=1` leaked into the test environment. (The send outcome also overwrote the real error code when the echo fired.)

**Fix:** `vitest.config.ts` pins `OTP_DEV_ECHO: "0"` (and a test-only `BETTER_AUTH_SECRET`) in miniflare `bindings`, which override `.dev.vars`; the audit outcome now keeps the send result and adds `echoed: true`.

**Blast radius:** Any test that depends on a var a developer may set in `.dev.vars`. Pin such vars in `vitest.config.ts`.

**Verification:** Worker tests 51/51 with and without `apps/worker-api/.dev.vars` present.

## 2026-09-27 — `pnpm run verify` checks nothing inside `.claude/worktrees/*`
**Symptom:** In a worktree under `.claude/worktrees/`, `pnpm check` (`biome check .`) fails with "No files were processed in the specified paths … These paths were provided but ignored: ." so `verify` stops at step one.

**Cause:** `biome.json` excludes `!!**/.claude` (meant for sibling worktrees inside the main checkout); run from inside a worktree, the path of every file contains `/.claude/`.

**Fix (workaround):** Run `biome check apps packages biome.json package.json tsconfig.base.json` then `pnpm typecheck && pnpm test && pnpm build`. A real fix belongs to WT-0 (`biome.json`), requested in `docs/handoffs/wt-p1-auth.md`.

**Blast radius:** Every agent worktree under `.claude/worktrees/`; CI (a normal checkout) is unaffected.

**Verification:** The explicit-path check processes 96 files and the remaining verify steps are green.

## 2026-09-27 — First production deploy failed twice on the Cloudflare account, not the code
**Symptom:** `Deploy CloudBox` failed at "Ensure Cloudflare resources": first `Authentication error [code: 10000]` on `/d1/database`, then after a token fix `Please enable R2 through the Cloudflare Dashboard [code: 10042]`. The first D1 database that did get created landed in region WNAM.

**Cause:** (1) The org `CLOUDFLARE_API_TOKEN` lacked D1/R2/Workers/zone permissions. (2) R2 is an account-level product that must be enabled once in the dashboard; no API token permission unlocks it. (3) `wrangler d1 create` without `--location` picks a region from the runner's vantage point (GitHub's US runners → WNAM), not from where users are.

**Fix:** Owner regenerated the token with Workers Scripts/D1/R2/Account Settings + zone DNS/Workers Routes on `affinityminds.in`. Workflow now creates D1 with `--location apac` and recreates an *empty* database found elsewhere; the R2 step degrades to a warning and strips the binding until R2 is enabled.

**Blast radius:** Deploy workflow only. The recreate-if-empty branch must never fire on a populated database (it checks `num_tables == 0`); remove that branch once the database has data.

**Verification:** Deploy run succeeded; `/api/version` gitSha equals `main`; annotations show "Recreating empty cloudbox-db in APAC (was WNAM)" and the R2 warning.

## 2026-09-27 — `pnpm ci` never ran the checks
**Symptom:** The root script `"ci"` reinstalled dependencies and exited 0 without running Biome, typecheck, tests, or the build. The deploy workflow depended on it, so it would have deployed without `admin-web/dist`.

**Cause:** pnpm treats `pnpm ci` as its built-in clean-install command; the script name is shadowed.

**Fix:** Renamed to `verify`; every workflow and doc now calls `pnpm run verify`.

**Blast radius:** Any script named like a pnpm built-in (`ci`, `install`, `add`, `run`, `test` is fine because pnpm maps it to the script). Recorded in `sorensd/agent-notes` too.

**Verification:** `pnpm run verify` prints all four stages and fails on a deliberate type error.

## 2026-09-27 — A merge was refused by the agent's permission gate, not by GitHub
**Symptom:** `gh pr merge 1` returned "denied by the auto mode classifier [Merge Without Review]" although CI was green.

**Cause:** The orchestrating agent's auto-approval mode gates merges to `main`; it is not a repository rule.

**Fix:** The owner instructs the merge explicitly ("merge PR N"), after which the same command succeeds.

**Blast radius:** Any phase timeline that assumes the agent can merge unattended. Plan for a human merge step at each phase gate.

**Verification:** PR #1 and PR #3 merged after explicit instruction.

## 2026-09-26 — GitHub writes returned 403 after repository connection
**Symptom:** Read access worked, but branch/issue creation returned `Resource not accessible by integration`.

**Cause:** GitHub connector had not been granted effective organization write access to `Affinity-Minds/cloudbox`.

**Fix:** Re-authenticated the GitHub connector with organization/repository write access.

**Blast radius:** Repository publication only. No code or production infrastructure was affected.

**Verification:** `phase-0/bootstrap` branch creation succeeded after re-authentication.

## Template

### YYYY-MM-DD — Short symptom
**Symptom:**

**Cause:**

**Fix:**

**Blast radius:**

**Verification:**
