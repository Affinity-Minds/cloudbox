# Cloudflare infrastructure

Production origin: `box.affinityminds.in`.

The Worker configuration lives in `apps/worker-api/wrangler.jsonc`. D1, R2 and Durable Object resources are added as the slices that use them land. Resource identifiers must come from Cloudflare, never placeholders guessed by an agent.

GitHub Actions receives only the deployment token/account ID. Application secrets remain Cloudflare secrets.
