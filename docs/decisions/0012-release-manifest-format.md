# ADR 0012 — Release manifest format, and `channel` vs `status` on `releases`

**Status:** Accepted (WT-18, Phase 10)
**Date:** 2026-09-27
**Context:** Master spec §18 (OTA / automatic updates), §45 (Update Dashboard), §50 (Windows release channels); Slices 10.1–10.4.
**Stakeholders:** WT-18 (cloud issuer), the Windows updater (a later slice, WT-4/WT-10 lineage), WT-8 (security review)

## Problem

The cloud must publish an OTA release for Agent/Status/Setup/Connect such that:

- a device can trust the manifest came from CloudBox and was not tampered with (§18.3: signed manifest, cryptographic hash, version, minimum compatible Agent version, rollback metadata),
- the manifest itself need not be secret (unlike a device entitlement — anyone with the release id can read it; only production of it must be gated),
- a bad Pilot build cannot reach the whole fleet by accident (§18.2, §45, Slice 10.4's exit criterion),
- the release's target channel (spec's four channels) and its promotion lifecycle (draft → live → withdrawn) are both representable, even though the brief's `releases` table DDL gives them as two separate enum columns (`channel` and `status`) rather than one.

## Decision

### Manifest: signed JWS, not a nested JWE

Unlike the entitlement (ADR 0004), the manifest is **signed only** — `SignJWT` (ES256, `typ:"cbx-release+jwt"`, `kid`), no `CompactEncrypt` layer — because it carries no secret. It has its **own** signing key (`RELEASE_SIGNING_JWK`, `signing_keys.purpose='release'`), never `ENTITLEMENT_SIGNING_JWK`: a release manifest and a device entitlement are different trust domains, and reusing one signer would mean a single key compromise affects both licensing and OTA delivery. The reference sign/verify pair lives in the new leaf package `@cloudbox/update-contracts` (mirrors `@cloudbox/licensing-contracts`'s shape: `manifest.ts` + `keys.ts`, a committed test vector, a generator script), so the Windows updater's .NET verifier has the same fixed target ADR 0004's does.

### `channel` is the rollout target; `status` is the workflow gate

The brief's DDL gives `releases` both `channel CHECK('development','pilot','stable','pinned')` and `status CHECK('draft','pilot','stable','withdrawn')`. Rather than treat these as redundant, they carry distinct meaning:

- **`channel`** — which of the spec's four channels this release currently targets. Set at upload time by the uploader's choice, changed only by promotion.
- **`status`** — the workflow/lifecycle gate: `draft` (uploaded, not live to anyone but an explicit device assignment — spec §18.2's "Internal lab" stage), `pilot` (live, only to an explicit device/tenant/percent assignment), `stable` (live, the broadcast default for the component), `withdrawn` (terminal; pulled from every path).

Promotion transitions (`POST /:id/promote {channel}`, enforced in `src/releases/service.ts`):

| From (status) | To (channel) | Result (status) | Gate |
|---|---|---|---|
| `draft` | `pilot` | `pilot` | none |
| `pilot` | `stable` | `stable` | health gate (≥1 `installed_healthy`, 0 `installed_unhealthy`/`rolled_back`) |
| `stable` | `pinned` | `stable` (unchanged) | none — only `channel` moves |
| `stable`, `channel=pinned` | `stable` | `stable` (unchanged) | none — "unpin" |
| `draft` | `stable` directly | refused | `409 must_pilot_first` |
| any | (withdrawn already) | refused | `409 already_withdrawn` |

A `stable`-status, `pinned`-channel release is still a fully live, valid release — pinning only removes it from the broadcast default (`resolve.ts`'s "channel default" tier filters on `channel='stable'`, not just `status='stable'`), so it is reachable only through an explicit device/tenant/percent assignment. This is what makes a Pilot rollout safe: the fleet-wide default only ever moves when the health gate has passed, and an operator can always carve out an exception (pin) without touching the default.

### Health gate, exactly per §45

`healthGatePassed` (`src/releases/results.ts`) requires **at least one** `installed_healthy` result and **zero** `installed_unhealthy`/`rolled_back` results, counted across every device that has reported against the release (not scoped to a cohort — a Pilot assignment is what limits who *can* report in the first place). The ten terminal states from §45 are stored verbatim in `release_results.state`; nothing here ever infers success from `downloaded` alone.

### Deferred: the fresh-TOTP step-up on pilot→stable

The brief asks that promotion to `stable` also require a fresh-TOTP step-up (ADR 0009's staff authenticator). No such helper is exported from WT-1's auth module as of this branch. `promoteRelease` enforces the health gate only; the step-up is a documented `TODO` and a "Decision needed" in the handoff, not invented.

## Consequences

- The Windows updater verifies the manifest exactly as `@cloudbox/update-contracts/test/vector.test.ts` pins it, same acceptance model as ADR 0004.
- A compromised `RELEASE_SIGNING_JWK` cannot forge an entitlement, and vice versa.
- Rotation follows the same additive pattern as `docs/runbooks/licensing-key-rotation.md`; see `docs/runbooks/release-key-rotation.md`.
- Once the fresh-TOTP helper exists, `promoteRelease`'s pilot→stable branch gains one more check; no schema change is needed.

## References

- Spec §18, §45, §50; Slices 10.1–10.4
- `packages/update-contracts/src/manifest.ts`, `src/keys.ts`
- `apps/worker-api/src/releases/service.ts`, `resolve.ts`, `results.ts`
- `docs/runbooks/release-key-rotation.md`, `docs/slices/10.1-10.4-releases.md`
