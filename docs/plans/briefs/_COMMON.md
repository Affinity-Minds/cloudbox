# Common rules — paste this block at the bottom of every worktree prompt

Repository: `Affinity-Minds/cloudbox` (GitHub, org secrets already configured). Production: `https://box.affinityminds.in`. Commit author: `Soren Singh Dary <67230851+sorensd@users.noreply.github.com>`. Never push to `main`. Never add agent co-author trailers.

Read first, in this order: `CLOUDBOX_MASTER_AGENT_BUILD_SPEC.md` (Section 0 and your slice in Section 56), `AGENTS.md`, `docs/handoffs/foundation.md` (exact table/column/route names — never guess), then only the `sorensd/agent-notes` files named in your brief (local clone at `../agent-notes` or GitHub `sorensd/agent-notes`).

Hard rules:
- Never `git stash` (worktrees share one `.git`; stash is global and corrupts siblings). Commit to your branch.
- Do not edit: `apps/worker-api/src/db/schema.ts`, migration `0003`, `apps/admin-web/src/nav.ts`, any `package.json`, `pnpm-lock.yaml`, `.github/workflows/*`, `docs/BUILD_STATE.md`. Add at most one line to `apps/worker-api/src/routes/v1/index.ts`. Need a column, dependency or nav entry? Put it in your handoff under "Requests to WT-0", stub locally, keep going.
- Integrate before authoring: search the repo and the installed packages before writing a helper. No custom crypto, auth, sessions, hashing, or token formats.
- Closed slice or draft: migration (only your reserved number, only if truly needed) → API with Zod validation via `@hono/zod-validator` → server-side authorisation on every route → UI reachable from the sidebar → `audit()` for every consequential write → tests (happy path + permission boundary + tenant boundary where applicable) → literal demo path → handoff.
- `pnpm run verify` (check, typecheck, test, build) must be green in your worktree before reporting ready.
- UI is not done without a screenshot saved under `docs/evidence/<your-wt>/`. Page type is **operational console**: dense tables, detail drawers, coloured status pills, honest empty states, chrome renders even when data fails.
- If something already exists, stop and report it instead of duplicating.
- Before you stop: write `docs/handoffs/<your-branch>.md` using the handoff template in the spec (Mission, Current status, Commits ready, Files/contracts changed, Migrations, API changes, Security assumptions, Tests run + exact results, Demo path, Known failures, Decisions needed, Requests to another worktree, Safe next action) and commit it.
