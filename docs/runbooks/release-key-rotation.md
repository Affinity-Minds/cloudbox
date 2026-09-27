# Runbook: Release-manifest signing key — first key, rotation, compromise

**Owner:** WT-18
**Phase:** 10
**Status:** Implemented (issuer, `ensureReleaseSigningKey`, generator). Deploy-workflow secret-sync step not yet added (see "Requests to another worktree" in the handoff) — sibling of the same gap `licensing-key-rotation.md` records for `ENTITLEMENT_SIGNING_JWK`.
**Format:** ADR 0012 (`docs/decisions/0012-release-manifest-format.md`)

## What exists

| Piece | Where | Secret? |
|---|---|---|
| Private signing key (EC P-256 JWK with `kid`, `alg:"ES256"`, `use:"sig"`) | Wrangler secret `RELEASE_SIGNING_JWK` (a GitHub environment secret of the same name, environment `production`, once the sync step below is added) | **Yes** |
| Public half | D1 `signing_keys(kid, alg='ES256', public_jwk, status, purpose='release')`, inserted by the Worker on first upload (`ensureReleaseSigningKey`) | No |
| `kid` | RFC 7638 SHA-256 thumbprint of the public key | No |

Deliberately its **own** key — never `ENTITLEMENT_SIGNING_JWK` (see ADR 0012). The Worker never reads a private key from D1 (agent-notes cloudflare-workers #20). Without the secret, uploading a release answers `503 signing_key_unavailable` and the Updates page shows a warning banner; nothing else is affected — existing releases and their manifests keep verifying.

## 1. First key (one-off, owner)

On a trusted machine with the repo checked out, Node 24, and `gh` logged in to `Affinity-Minds`:

```bash
corepack pnpm install --frozen-lockfile
node packages/update-contracts/scripts/generate-signing-key.ts \
  | gh secret set RELEASE_SIGNING_JWK --env production --repo Affinity-Minds/cloudbox
```

- **stdout** carries only the private JWK and goes straight into the pipe. The script refuses to run if stdout is a terminal, so the private key is never printed or written to disk.
- **stderr** prints `kid: …` and the public JWK. Paste both into the "Key register" table below (they are public).
- Do not run `wrangler secret put` locally: the production Cloudflare account is reachable only from GitHub Actions. The deploy workflow copies the GitHub secret into Wrangler (once WT-0 adds the sync step below).

After the next deploy, the first upload inserts the public half into `signing_keys` (`purpose='release'`, `status='active'`). Check:

```bash
wrangler d1 execute cloudbox-db --remote --command "select kid, alg, status, purpose, created_at from signing_keys where purpose = 'release'"
```

## Wiring the secret (WT-0, deploy workflow)

Same pattern as `ENTITLEMENT_SIGNING_JWK` (`licensing-key-rotation.md` "Wiring the secret"):

```yaml
- name: Sync RELEASE_SIGNING_JWK (when set)
  working-directory: apps/worker-api
  env:
    RELEASE_SIGNING_JWK: ${{ secrets.RELEASE_SIGNING_JWK }}
  shell: bash
  run: |
    set -euo pipefail
    if [ -z "${RELEASE_SIGNING_JWK}" ]; then echo "not set; uploads stay 503"; exit 0; fi
    printf '%s' "$RELEASE_SIGNING_JWK" | pnpm wrangler secret put RELEASE_SIGNING_JWK
```

## 2. Planned rotation (yearly, or on staff change)

Rotation is additive; no already-issued release is ever invalidated.

1. **Pin the next key in the updater first.** The Windows updater verifies against a pinned set of public JWKs (a later slice). Ship an updater build whose pinned set contains the current kid **and** the new public JWK (generate the new key with step 1's command, but pipe to a new GitHub secret name `RELEASE_SIGNING_JWK_NEXT` and record the public half). Wait until the fleet reports that updater version.
2. **Switch the signer.** Replace `RELEASE_SIGNING_JWK` with the new private JWK (`gh secret set …` from the stored `…_NEXT`, then deploy). Every release uploaded from then on uses the new kid; the first one inserts it into `signing_keys`.
3. **Retire the old key.** Mark the old row retired so it can never sign a new release even if the old secret is restored:
   ```sql
   UPDATE signing_keys SET status = 'retired' WHERE kid = '<old kid>' AND purpose = 'release';
   ```
   Every release already signed with the old kid keeps verifying on devices (their kid is still pinned) — the manifest is not re-signed retroactively.
4. **Unpin.** Ship an updater build without the old public JWK. From then on, a manifest signed by the old kid fails as `unknown_kid`.
5. Delete the GitHub secret `RELEASE_SIGNING_JWK_NEXT`; record dates in the register below.

`ensureReleaseSigningKey` refuses to sign with a kid whose row is `retired` (`503 signing_key_retired`), belongs to the other purpose (`503 signing_key_mismatch`), or whose stored public key differs from the secret (`503 signing_key_mismatch`).

## 3. Suspected compromise

1. Generate a new key (step 1) and switch the signer immediately (rotation step 2), skipping the "pin first" wait.
2. `UPDATE signing_keys SET status='retired' WHERE kid='<compromised kid>' AND purpose='release'`.
3. Ship an updater build that pins only the new key (emergency channel). Devices on the old build keep accepting the compromised kid's already-downloaded manifests until they update: this window is the residual risk; record it.
4. Audit `UPDATE_RELEASED`/`UPDATE_PROMOTED` rows for anything signed with the compromised kid after the suspected date (the manifest's `kid` claim is not secret and is stored in `releases.manifest_json`).
5. Consider withdrawing (`POST /:id/withdraw`) any release signed with the compromised kid that has not yet reached `stable`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Upload answers `503 signing_key_unavailable` | Secret missing or not a P-256 private JWK with `kid` | Step 1 + deploy |
| `503 signing_key_retired` | The secret is an old key | Put the current key back in the secret |
| `503 signing_key_mismatch` | Same `kid`, different key material, or the kid belongs to `purpose='entitlement'` | Regenerate; never edit JWKs by hand; never point this secret at the entitlement key |
| `409 health_gate_failed` on promote to stable | No `installed_healthy` result yet, or an `installed_unhealthy`/`rolled_back` is present | Wait for Pilot devices to report, or fix the regression and re-upload as a new version |
| `409 must_pilot_first` | Tried to promote a `draft` release straight to `stable` | Promote to `pilot` first |
| A device's `GET /assigned` 404s | No release for that component has reached `channel='stable'` yet, and the device has no explicit assignment | Promote one to stable, or add a device/tenant/percent assignment |

## Key register

| kid | Created | Activated (signer) | Retired | Notes |
|---|---|---|---|---|
| _(owner fills after step 1)_ | | | | |

## References

- ADR 0012; Spec §18.3, §18.7
- `packages/update-contracts/scripts/generate-signing-key.ts`
- `apps/worker-api/src/releases/signing-key.ts`
