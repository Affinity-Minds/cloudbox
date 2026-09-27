# ADR 0014 — Production domain: `box.affinity.ai.in`

## Context
The production web origin was `box.affinityminds.in`. The owner wants the `affinityminds.in` zone freed entirely — no route, no trustedOrigin, no documentation reference, no CI default should keep it alive.

## Decision
Move the production hostname to `box.affinity.ai.in` and remove every reference to `affinityminds.in` from the codebase: the Worker custom-domain route (`apps/worker-api/wrangler.jsonc`), the auth `PRODUCTION_ORIGIN`/`trustedOrigins` (`apps/worker-api/src/auth/index.ts`), the deploy and CI workflow defaults (`.github/workflows/deploy-cloudflare.yml`, `.github/workflows/ci.yml`), test fixtures that assert against the production host, and all documentation (README, ARCHITECTURE, runbooks, handoffs, plans, BUILD_STATE, prior ADRs). The email sending domain `em.affinity.ai.in` and the bootstrap admin address `soren@affinityminds.net` are unrelated domains and are left untouched. `wrangler.jsonc` carries exactly one route entry — for `box.affinity.ai.in` — with no second entry for the old host.

## Alternatives considered
- Keep both hostnames live via two routes during a transition window. Rejected: the owner's goal is to free `affinityminds.in`, not to run it in parallel.
- Redirect the old host to the new one at the DNS/zone level. Rejected: the old zone is being abandoned entirely, not kept as a redirect target.

## Consequences
- The first deploy after this change provisions `box.affinity.ai.in` as a Worker Custom Domain. Because `wrangler.jsonc` no longer lists `box.affinityminds.in`, Wrangler removes that custom domain from the Worker on deploy — it does not coexist with the new one.
- If the `affinityminds.in` DNS record for `box` survives the Wrangler-managed custom-domain removal (e.g. it was ever created manually, or Wrangler only detaches the domain rather than deleting a stray record), it must be deleted by hand in the Cloudflare dashboard for the zone to be genuinely free.
- Turnstile's siteverify hostname check (`apps/worker-api/src/auth/challenge.ts`) already compares against the live request host rather than a hardcoded constant, so no widget-hostname code change was needed — but the Turnstile widget configuration in the Cloudflare dashboard must be updated to list `box.affinity.ai.in` as an allowed hostname, or challenges will fail closed in production.
- Two manual dashboard prerequisites are required before/at first deploy and are not something CI can verify: (1) the `affinity.ai.in` zone must be present in the same Cloudflare account the Worker deploys into, and (2) the Turnstile widget's hostname allow-list must include `box.affinity.ai.in`.

## Verification / follow-up
- `grep -rn "affinityminds.in"` across the repo (excluding `node_modules`, `.git`) must return zero hits.
- After the first production deploy: confirm `box.affinity.ai.in` resolves and serves the app (custom domain provisioned), and confirm in the Cloudflare dashboard that the `box.affinityminds.in` custom domain is gone from the Worker.
- Separately, in the Cloudflare DNS dashboard for `affinityminds.in`: confirm no `box` (or other CloudBox-related) DNS record remains — delete it by hand if Wrangler's custom-domain removal did not clear it. Only then is the zone genuinely free.
- Confirm the Turnstile widget hostname allow-list in the dashboard was updated to `box.affinity.ai.in` before relying on the challenge in production.
