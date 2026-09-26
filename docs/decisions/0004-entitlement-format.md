# ADR 0004 — Entitlement format: ES256 JWS nested in an RSA-OAEP-256 / A256GCM JWE

**Status:** Accepted (WT-5, Phase 3)
**Date:** 2026-09-27
**Context:** Master spec §9.3 (machine-bound offline lease), §9.4 (no proprietary crypto), §9.6 (copy protection), §32 (revocation), §33 (renewal, generations); Slices 3.1 and 3.2.
**Stakeholders:** WT-5 (cloud issuer), WT-3 (`GET /agent/entitlement`), WT-4 / WT-10 (Windows verifier), WT-8 (security review)

## Problem

The cloud must hand each enrolled device an offline licence lease that:

- only the Cloud can mint (authenticity),
- only the enrolled device can read (confidentiality; the human-readable blob reveals nothing, §9.3),
- cannot be copied to another machine and made to work (§9.6),
- can be rotated to a new server key without stranding devices,
- is built from established primitives, not invented ones (§9.4, AGENTS.md).

## Decision

A nested JOSE token, produced and checked with `jose` (TypeScript) on the cloud side:

```
claims (JSON, snake_case)
  └─ JWS compact   alg=ES256  kid=<server kid>  typ=cbx-entitlement+jwt      (SignJWT)
      └─ JWE compact  alg=RSA-OAEP-256  enc=A256GCM  cty=JWT  kid=<server kid>  (CompactEncrypt)
          → stored in entitlements.token, served only to that device
```

- **Signing key:** one P-256 keypair per rotation period. Private JWK is the Wrangler secret `ENTITLEMENT_SIGNING_JWK` (agent-notes cloudflare-workers #20: declared by name, never read from D1). `kid` is the RFC 7638 SHA-256 thumbprint of the public key. The public half is inserted into `signing_keys` by `ensureSigningKey(env)` at first issuance (idempotent on the primary key); a `retired` or mismatched kid refuses to sign (503).
- **Encryption key:** the device's enrolled RSA public key (`devices.device_public_key_jwk`, TPM/CNG where available). Only public members `kty/n/e` are imported.
- **Claims:** spec §9.3 plus `iss:"cloudbox"`, `kid` (equal to the header kid), `jti` (equal to `license_id`), `iat` (seconds). `device_key_thumbprint` is RFC 7638 of the device public key. No `exp`/`nbf`: validity (`valid_until`) and `offline_grace_days` are evaluated by the agent against its trusted clock (§10, §11), not by a JWT library's wall clock.
- **Generations:** `generation = max(generation)+1` per device, enforced by `UNIQUE(device_id, generation)`; a concurrent issue loses with `409 generation_conflict` and nothing is written. The agent never accepts a lower generation than it has stored (§33.3).
- **Revocation:** revoke sets `revoked_at` on every live generation of the device. The agent endpoint serves the highest generation only, and nothing when that one is revoked; it never falls back to an older generation.
- **Verifier:** `verifyEntitlement` in `@cloudbox/licensing-contracts` is the reference: decrypt (RSA-OAEP-256/A256GCM only), JWS header must be ES256 with our `typ`, JWE kid = JWS kid, kid must be in the pinned set, `jwtVerify(algorithms:['ES256'], issuer:'cloudbox', typ)`, `claims.kid` = header kid, `jti` = `license_id`, and `device_key_thumbprint` = thumbprint of the local key. Every failure is an `EntitlementError` with a `code`.

## Alternatives considered

- **Signed only (JWS), no encryption.** Simpler, but the blob reveals tenant, limits and dates; fails §9.3 "reveals none of these fields". Rejected.
- **Encrypted only (JWE to the device key).** Anyone holding the device *public* key (it is not secret) could mint a JWE. Authenticity would rest on nothing. Rejected.
- **ECDH-ES to a device EC key.** Equally standard, but the Windows agent's TPM key is RSA (Slice 2.2, enrollment contract `kty:"RSA"`); switching would change the enrollment contract. Not now.
- **PASETO v4.** Good design, but no first-party .NET/CNG path and no TPM-bound decryption story; JOSE has both (Microsoft.IdentityModel, jose-jwt). Rejected for tooling reasons.
- **Proprietary licence file with HMAC.** Explicitly forbidden (§9.4). Rejected.
- **`kid` as a date label (`cbx-2026-09`).** Readable, but collisions are possible and it proves nothing; the RFC 7638 thumbprint is self-verifying. Chosen: thumbprint.

## Consequences

**Positive**

- Copy protection is the format itself: a copied token does not decrypt on another device (tested), and a token re-encrypted to another device fails the thumbprint check (tested).
- Rotation is additive: add a key, keep the old kid pinned until every device has a newer generation, then retire it.
- The .NET side needs no custom cryptography: standard JWE decrypt + ES256 verify (see `docs/slices/3.2-entitlement-format.md`), with a committed test vector (`packages/licensing-contracts/test/vectors/v1.json`).

**Risks and mitigations**

- **Signing key compromise** lets an attacker mint leases for any device whose public key they know. Mitigation: secret only in Wrangler (set by the deploy workflow from a GitHub environment secret), rotation runbook, retire + reissue.
- **Stale-generation replay offline** (an old lease restored from backup). Mitigation: the agent stores the highest generation seen in protected state (Slice 3.3/4.1) and rejects lower ones.
- **Device clock rollback** extends an expired lease. Mitigation: trusted-time high-water mark (spec §11, Slice 4.1); the token carries no `exp` precisely so this logic is not bypassed by a library default.
- **Library support on .NET** for RSA-OAEP-256 + A256GCM must be confirmed on the `windows-latest` runner (WT-4/WT-10); the documented fallback is the `jose-jwt` package, still a standard JOSE implementation.

## See also

- `packages/licensing-contracts/src/entitlement.ts`, `src/keys.ts`
- `apps/worker-api/src/entitlement/*`, `routes/v1/entitlements.ts`
- `docs/runbooks/licensing-key-rotation.md`
- ADR 0005 (device bearer token, which authenticates `GET /agent/entitlement`)
