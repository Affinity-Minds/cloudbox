# ADR 0013 — RDP credential broker: cloud mints, Agent applies, Connect brokers via Credential Manager

**Status:** Accepted (WT-11, Phase 6 alpha).
**Date:** 2026-09-27.
**Context:** Slice 6.4 (CloudBox Connect client). Spec §14.2 ("RDP credentials SHOULD be brokered
internally by CloudBox Connect/Agent rather than exposed as the user's SaaS password"), §28.4 ("Do
not place RDP passwords in URLs, command-line arguments visible to other processes, or logs").
**Stakeholders:** WT-11 (Connect client, this worktree), WT-10 (Agent — implements the command this
ADR defines but does not yet apply it), WT-3/WT-5 (devices, entitlement — unaffected).

## Problem

A Connect user clicking **CONNECT** needs an RDP session to a managed Windows account (`cloudNN`) on
the target CloudBox, without ever seeing, typing, or exposing that account's password — the password
must not appear on a command line, in a file, or in a log on either the client or the cloud, and the
cloud must not be able to read it back out of storage once minted.

## Decision

A one-time, short-lived (15 minute) credential, brokered in three steps:

1. **Cloud mints.** `POST /api/v1/connect/devices/:deviceId/session` (customer session, active
   tenant membership) picks the lowest managed-user slot (`cloud01`, `cloud02`, …) that has no live
   grant for that device, generates a random password (20 chars, meeting Windows' default 3-of-4
   complexity), and:
   - returns `{deviceId, user, password, expiresAt}` to the caller **exactly once** — Connect must
     use it immediately and never persist or log it;
   - stores only a SHA-256 hash of the password (`rdp_session_grants.password_hash`, for
     audit/identification, never for recovery) and a compact JWE of `{"password": "…"}` encrypted to
     the device's own enrolled RSA public key (`RSA-OAEP-256` / `A256GCM`, the same key management
     scheme as the entitlement envelope, `@cloudbox/licensing-contracts`) — safe to store because
     only that device's own private key, which never leaves the machine (CNG-protected, WT-4), can
     open it.
   - audits `RDP_SESSION_GRANTED` with the slot and expiry, never the password or its hash.

2. **Agent applies (WT-10, not yet implemented).** The next heartbeat response's `commands` array
   carries `{"type": "SET_MANAGED_USER_PASSWORD", "user": "cloud03", "passwordCiphertext": "<JWE>"}`
   for every grant not yet delivered (`rdp_session_grants.delivered_at IS NULL`); the cloud marks it
   delivered the moment it's queued, so a slow-polling Agent is never handed the same command twice.
   The Agent decrypts `passwordCiphertext` with its own device private key and sets the local
   Windows account's password to match — this ADR fixes the command's exact shape
   (`packages/contracts/src/connect.ts`'s `SetManagedUserPasswordCommand`) as the contract WT-10
   builds against; the Agent-side application of it is outside this worktree's scope (see the
   handoff).

3. **Connect brokers.** On the same plaintext password from step 1, before launching anything:
   - `CredWrite` (`advapi32.dll`, generic `TERMSRV/<address>` credential, `CRED_TYPE_DOMAIN_PASSWORD`,
     session-persistence so it disappears at logoff even if step 4 is never reached) —
     `apps/cloudbox-connect/Rdp/CredentialBroker.cs`.
   - Write a `.rdp` file with `full address:s:<address>` and `username:s:<user>` — **no password
     field** — and launch `mstsc.exe <file> /f`; `mstsc` reads the credential Windows Credential
     Manager already holds for that exact target and never prompts.
   - Wait for `mstsc` to exit, then `CredDelete` the same target (always, even if the launch threw)
     and delete the temp `.rdp` file.

## Why this order (cloud mints before the Agent has applied it)

The credential the cloud hands to Connect and the one it queues for the Agent are the same
plaintext, decided once; Connect does not wait for the Agent to confirm it applied the password
before writing it to Credential Manager and launching `mstsc` — the two happen concurrently, timed
by the heartbeat interval (≤60 s) against the credential's 15-minute lifetime. If the Agent has not
yet applied the new password by the time `mstsc` connects, the connection fails once and the user
retries; this is accepted for the alpha (a strict handshake would need a fourth round trip — Agent
acks "applied" — which is a reasonable Phase 6 follow-up, not built here).

## Alternatives considered

- **Connect talks to the Agent directly (skip the cloud).** Rejected: Connect has no private-network
  reachability to the device until `EnsureConnectedAsync` succeeds, and the whole point of the
  managed-user model (§14) is that entitlement/slot accounting lives in the cloud, not the client.
- **Cloud stores the plaintext (or a reversible encryption) so it can hand it out again on retry.**
  Rejected: violates "never on the cloud" for a human-usable secret; a failed first attempt simply
  requests a fresh grant (a new slot, same 15-minute TTL) rather than replaying an old one.
- **A signed (JWS) command, not just encrypted (JWE).** Considered for tamper-evidence, but the
  Agent's own device-bearer heartbeat channel is already authenticated (Bearer device token) and
  the command travels inside that authenticated response — encryption alone is enough to keep the
  password unreadable to anything except the target device; explicit signing would be
  defence-in-depth, not a closed gap, and is left as a follow-up if WT-10 wants it.

## Consequences

- New table `rdp_session_grants` (migration `0013`), owned by WT-11 in its own file
  (`apps/worker-api/src/rdp/session-grants-table.ts`) rather than `db/schema.ts` directly — WT-0
  folds it in later, the same pattern `license_keys` used before consolidation
  (`docs/handoffs/wt-p2-self-onboarding.md`).
- `HeartbeatResponse.commands` (previously always `[]`) can now be non-empty; every consumer of that
  field must treat unknown command `type`s as no-ops (forward compatibility) — WT-10's Agent side is
  the only consumer today.
- `devices.device_public_key_jwk` (WT-3's enrollment output) is now read by a second cloud subsystem
  besides entitlement issuance; no schema change, purely an additional reader.
- Connect's own credential lifetime (Windows Credential Manager entry) never outlives the process
  launching `mstsc` by design — `CredDelete` runs in a `finally`, so a crash during the RDP session
  itself is the only way a session-scoped (i.e., gone at logoff anyway) entry outlives the app.

## What is unproven without a second physical Windows machine

Everything in step 3 (`CredWrite`/`CredDelete`/`mstsc` launch) runs for real on `windows-latest` CI
(`apps/cloudbox-connect.tests/Win32CredentialBrokerTests.cs`), including a genuine write/delete round
trip against that runner's own credential store. What CI cannot prove: that `mstsc` actually
authenticates silently against a **real** `TERMSRV/<address>` target using that stored credential
(CI has no second machine to RDP into), and that a real WT-10 Agent decrypts
`passwordCiphertext` and applies it correctly. See the handoff's "What is unproven" table.

## See also

- `packages/contracts/src/connect.ts` — `RdpSessionResponse`, `SetManagedUserPasswordCommand`.
- `apps/worker-api/src/rdp/session.ts` — cloud-side grant/slot logic.
- `apps/cloudbox-connect/Rdp/` — client-side broker + launcher.
- `docs/handoffs/wt-p2-agent.md` — WT-4's device key / DPAPI conventions this design reuses.
- `docs/handoffs/wt-p6-connect-client.md` — this worktree's handoff, including the exact command
  contract for WT-10.
