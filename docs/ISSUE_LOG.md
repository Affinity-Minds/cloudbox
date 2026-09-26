# CloudBox issue log

Newest first. Record only non-obvious failures or fixes with meaningful blast radius.

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
