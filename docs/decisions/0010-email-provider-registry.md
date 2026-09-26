# ADR 0010 — Configurable email provider registry with SMTP fallback

**Status:** Accepted (WT-12, Phase 1, Slice 1.5).

## Context

Sending email (OTP codes today, other purposes later) went through exactly one path: the
Cloudflare Email Service `send_email` binding (`env.EMAIL`), hardcoded in `sendOtpEmail`
(`apps/worker-api/src/email/index.ts`, WT-1). That binding requires the sender domain to be
onboarded to Cloudflare Email Service and offers no failover — a delivery problem there is a
delivery problem for every tenant, with no operator-facing way to add a second path or switch to
SMTP without a code change and redeploy. The spec (§38) requires provider secrets to live outside
plaintext config/D1; §25 lists email as an alert channel that must not depend on a single point of
failure long-term.

## Decision

- **Provider registry, not code.** A D1 table `email_providers` (migration `0008`) holds N
  provider rows (`cloudflare_binding`, `smtp`, `log`), each with a priority, an enabled flag, a
  `from` address and non-secret config. `sendEmail()` tries enabled rows in priority order and
  audits every attempt (`EMAIL_SENT`/`EMAIL_FAILED`), stopping at the first success.
- **SMTP via `worker-mailer`, not custom sockets or MIME.** `worker-mailer` 1.2.x wraps
  `cloudflare:sockets` with STARTTLS/TLS and SASL auth already; writing that by hand would be
  exactly the "never invent auth/crypto/token formats" mistake the delivery rules warn against.
  The provider assigns its own message id since `WorkerMailer.send()` resolves `void`.
- **Secrets: an encrypted D1 column, not N Wrangler secrets.** Per agent-notes
  `platform/cloudflare-workers.md` ("Provider credentials need not be Wrangler secrets"), the SMTP
  password is AES-256-GCM ciphertext in `email_providers.secret_ciphertext`/`secret_iv` (random
  12-byte IV per value), decrypted only at send time with **one** Wrangler secret,
  `PROVIDER_SECRETS_KEY`. This lets an operator add or rotate a provider from the console without
  a deploy, while still keeping the actual key material (the one thing that must never leak) out
  of D1 and out of the repo. The API is write-only for the secret: `POST`/`PATCH` accept it,
  `GET` never returns it (`hasSecret: true/false` only).
- **Backward-compatible fallback.** Zero rows in `email_providers` (every install before this
  slice, and any fresh install that never configures one) falls back to the `EMAIL` binding
  directly — the exact behaviour `sendOtpEmail` had before. `sendOtpEmail` itself now delegates to
  `sendEmail(env, message, {purpose: "otp"})` in a single-line change to preserve WT-1's own
  `AUTH_OTP_SENT` audit event and `OTP_DEV_ECHO` behaviour untouched.
- **`log` provider is dev-only, enforced server-side.** It writes to `console` instead of sending;
  the API refuses to create or enable one when `ENVIRONMENT === "production"`, and `sendEmail`
  repeats that check itself as a second line of defence (a row could predate a later switch to
  production).

## Consequences

- An operator can add a second (or third) provider, reorder them, or switch from the Cloudflare
  binding to SMTP entirely from the console, without a deploy.
- Rotating `PROVIDER_SECRETS_KEY` would make every stored secret undecryptable; the deploy
  workflow creates it once and never rotates it automatically, the same pattern already used for
  `BETTER_AUTH_SECRET`.
- The provider list is cached in memory per isolate for 60 seconds (invalidated immediately on
  write) to keep the common case — sending with an already-known-good configuration — to zero
  extra D1 round trips most of the time, per agent-notes' two-tier caching guidance; this Worker
  serves one hostname, so the cache is keyed by D1 binding identity rather than an origin string
  that nothing here has to hand.
- `email_providers`'s Drizzle table lives in `apps/worker-api/src/email/providers/schema.ts`
  rather than the shared `db/schema.ts` (WT-0's file), the same way WT-1's `rateLimit` table did
  for migration `0004`. WT-0 should move it into `db/schema.ts` verbatim and regenerate the
  Drizzle meta snapshot.

## Alternatives considered

- **Keep one hardcoded binding.** Rejected — no failover, no way to use SMTP, and any delivery
  problem with Cloudflare Email Service has no workaround short of a code change.
- **N Wrangler secrets (one per provider).** Rejected per the agent-notes guidance: it would
  require a deploy to add or rotate a provider, and Wrangler secrets are not designed to be
  listed/edited from an admin UI the way D1 rows are.
- **Custom SMTP client.** Rejected — reinvents STARTTLS/TLS and SASL auth, exactly the kind of
  "never invent crypto/auth" mistake the delivery rules forbid; `worker-mailer` already does this
  correctly on `cloudflare:sockets`.
