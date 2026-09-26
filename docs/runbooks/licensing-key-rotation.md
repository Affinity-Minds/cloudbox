# Runbook: Entitlement signing key — first key, rotation, compromise

**Owner:** WT-5
**Phase:** 3
**Status:** Implemented (issuer, `ensureSigningKey`, generator). Deploy-workflow step syncs the secret into Wrangler (added by WT-0, 2026-09-27).
**Format:** ADR 0004 (`docs/decisions/0004-entitlement-format.md`)

## What exists

| Piece | Where | Secret? |
|---|---|---|
| Private signing key (EC P-256 JWK with `kid`, `alg:"ES256"`, `use:"sig"`) | Wrangler secret `ENTITLEMENT_SIGNING_JWK`, sourced from GitHub environment secret `ENTITLEMENT_SIGNING_JWK` (environment `production`) | **Yes** |
| Public half | D1 `signing_keys(kid, alg='ES256', public_jwk, status)`, inserted by the Worker on first issuance (`ensureSigningKey`) | No |
| `kid` | RFC 7638 SHA-256 thumbprint of the public key | No |

The Worker never reads a private key from D1 (agent-notes cloudflare-workers #20). Without the secret, issuing answers `503 signing_key_unavailable` and the Subscriptions detail shows a warning banner; nothing else is affected.

## 1. First key (one-off, owner)

On a trusted machine with the repo checked out, Node 24, and `gh` logged in to `Affinity-Minds`:

```bash
corepack pnpm install --frozen-lockfile
node packages/licensing-contracts/scripts/generate-signing-key.ts \
  | gh secret set ENTITLEMENT_SIGNING_JWK --env production --repo Affinity-Minds/cloudbox
```

- **stdout** carries only the private JWK and goes straight into the pipe. The script refuses to run if stdout is a terminal, so the private key is never printed or written to disk.
- **stderr** prints `kid: …` and the public JWK. Paste both into the "Key register" table below (they are public).
- Do not run `wrangler secret put` locally: the production Cloudflare account is reachable only from GitHub Actions (see BUILD_STATE / memory notes). The deploy workflow copies the GitHub secret into Wrangler.

After the next deploy, the first `Issue` in Subscriptions inserts the public half into `signing_keys` (`status='active'`). Check:

```bash
# from GitHub Actions or any context with prod D1 access
wrangler d1 execute cloudbox-db --remote --command "select kid, alg, status, created_at from signing_keys"
```

## Wiring the secret (WT-0, deploy workflow)

Add a step before `Deploy Worker` (same pattern as `BETTER_AUTH_SECRET`, but the value comes from the environment secret and is re-applied only when it changes):

```yaml
- name: Sync ENTITLEMENT_SIGNING_JWK (when set)
  working-directory: apps/worker-api
  env:
    ENTITLEMENT_SIGNING_JWK: ${{ secrets.ENTITLEMENT_SIGNING_JWK }}
  shell: bash
  run: |
    set -euo pipefail
    if [ -z "${ENTITLEMENT_SIGNING_JWK}" ]; then echo "not set; issuance stays 503"; exit 0; fi
    printf '%s' "$ENTITLEMENT_SIGNING_JWK" | pnpm wrangler secret put ENTITLEMENT_SIGNING_JWK
```

## 2. Planned rotation (yearly, or on staff change)

Rotation is additive; no device is ever stranded.

1. **Pin the next key in the agent first.** The Windows agent verifies against a pinned set of public JWKs (WT-4/WT-10). Ship an agent build whose pinned set contains the current kid **and** the new public JWK (generate the new key with step 1's command, but pipe to a new GitHub secret name `ENTITLEMENT_SIGNING_JWK_NEXT` and record the public half). Wait until the fleet reports that agent version.
2. **Switch the signer.** Replace `ENTITLEMENT_SIGNING_JWK` with the new private JWK (`gh secret set …` from the stored `…_NEXT`, then deploy). New issues and renewals use the new kid; the first one inserts it into `signing_keys`.
3. **Retire the old key.** Mark the old row retired so it can never sign again even if the old secret is restored:
   ```sql
   UPDATE signing_keys SET status = 'retired' WHERE kid = '<old kid>';
   ```
   Old entitlements keep verifying on devices (their kid is still pinned).
4. **Re-issue.** Renew every licensed device (Subscriptions → detail → Renew) so each holds a generation signed by the new kid. The agent rejects lower generations, so the old tokens are superseded.
5. **Unpin.** Ship an agent build without the old public JWK. From then on, a token signed by the old kid fails as `unknown_kid`.
6. Delete the GitHub secret `ENTITLEMENT_SIGNING_JWK_NEXT`; record dates in the register below.

`ensureSigningKey` refuses to sign with a kid whose row is `retired` (`503 signing_key_retired`) or whose stored public key differs from the secret (`503 signing_key_mismatch`).

## 3. Suspected compromise

1. Generate a new key (step 1) and switch the signer immediately (rotation step 2), skipping the "pin first" wait.
2. `UPDATE signing_keys SET status='retired' WHERE kid='<compromised kid>'`.
3. Ship an agent build that pins only the new key (emergency channel). Devices on the old build keep accepting the compromised kid until they update: this window is the residual risk; record it.
4. Renew every licensed device.
5. Audit: `LICENSE_ISSUED`/`LICENSE_RENEWED` rows carry `claims.kid`; list anything signed with the compromised kid after the suspected date.

## 4. Subscription lifecycle (for support)

- **Renew a customer:** Subscriptions → tenant → *Edit status / dates* → extend *Valid until* (audited `SUBSCRIPTION_CHANGED`), then *Renew* each device so its lease carries the new date (generation increases).
- **Change plan:** cancel the current subscription (terminal) and create a new one; then Issue/Renew devices.
- **Stop a device:** *Revoke* with a typed reason. Online agents lose the lease on their next fetch; offline agents within their grace window.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Issue answers `503 signing_key_unavailable` | Secret missing or not a P-256 private JWK with `kid` | Step 1 + deploy |
| `503 signing_key_retired` | The secret is an old key | Put the current key back in the secret |
| `503 signing_key_mismatch` | Same `kid`, different key material (hand-edited JWK) | Regenerate; never edit JWKs by hand |
| `409 no_active_subscription` | Tenant has no trial/active subscription covering now | Create or extend the subscription |
| `409 device_limit_reached` | Plan `max_devices` already licensed on this tenant | Revoke the other device first |
| Agent reports `unknown_kid` | Its pinned set lacks the signer's kid | Ship the agent build with the new key pinned (rotation step 1) |

## Key register

| kid | Created | Activated (signer) | Retired | Notes |
|---|---|---|---|---|
| BvYXJ4zdX7-kThGesLBGj4hvrXp-OCPQt6oIrgwLIN0 | ES256 | 2026-09-27 01:18 IST | active | `{"kty":"EC","crv":"P-256","x":"zCMUCeQ1DIPICjOUffUSRF5Jtp7642-PJl0CfGC9tnI","y":"wirynHCLCUXJ6v_CVHTuX_e1E2_gekB6o64ToXRAG60"}` |
| _(owner fills after step 1)_ | | | | |

## References

- Spec §9.3, §9.4, §32, §33; ADR 0004
- `packages/licensing-contracts/scripts/generate-signing-key.ts`
- `apps/worker-api/src/entitlement/signing-key.ts`
