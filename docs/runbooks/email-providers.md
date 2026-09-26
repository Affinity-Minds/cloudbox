# Runbook: Email Providers

**Owner:** WT-12 (Phase 1, Slice 1.5)
**Status:** Implemented

## Purpose

Configure, order and test the email providers CloudBox uses to send mail (OTP codes today; any
`purpose` later). Console path: **Settings → Email providers**.

## What is stored where

| Data | Location | Notes |
|---|---|---|
| Provider list, priority, enabled, kind, `from` address | D1 table `email_providers` | Non-secret. |
| SMTP host/port/secure/username | `email_providers.config_json` | Non-secret. |
| SMTP password | `email_providers.secret_ciphertext` / `secret_iv` | AES-256-GCM, random 12-byte IV per value. The API never echoes it back — `GET` returns `hasSecret: true/false` only. |
| Encryption key | Wrangler secret `PROVIDER_SECRETS_KEY` (32 raw bytes, base64) | One key for every provider's secret. Created once by the deploy workflow (`openssl rand -base64 32`), never rotated automatically — rotating it would strand every existing ciphertext (decryption would fail with the new key). |

If `PROVIDER_SECRETS_KEY` is unset, saving a provider with a secret (i.e. any `smtp` provider)
fails `503 provider_secrets_key_missing`. Providers that need no secret (`cloudflare_binding`,
`log`) are unaffected.

## How sending works

`sendEmail(env, message, {purpose})` (`apps/worker-api/src/email/send.ts`) loads every **enabled**
row ordered by `priority` (ascending — lower is tried first), and tries each in turn until one
succeeds. Every attempt is audited (`EMAIL_SENT` or `EMAIL_FAILED`, with the provider's id, kind
and either the message id or an error code — never the message body or the secret). If **no rows
exist**, it falls back to the Cloudflare Email Service `EMAIL` binding directly, so a CloudBox
install with no providers configured keeps working exactly as before this slice.

The provider list is cached in memory for 60 seconds per isolate; creating, updating or deleting a
provider invalidates that isolate's cache immediately, so a change is visible on the very next
request from the same isolate (other isolates catch up within the TTL).

## Add an SMTP provider

1. Settings → Email providers → **Add provider**.
2. Kind: **SMTP**. Fill in:
   - **Host** — e.g. `smtp.mx.cloudflare.net` (Cloudflare's own SMTP submission service) or any
     relay you control (SendGrid, Postmark, Mailgun, your own Postfix, …).
   - **Port** — `587` (STARTTLS) is the common choice; `465` (implicit TLS) also works. Port `25`
     cannot be used — Cloudflare Workers refuse outbound connections on it.
   - **TLS (secure)** — check this only for implicit TLS (usually port 465). Leave it unchecked
     for STARTTLS (usually port 587); the provider upgrades the connection itself.
   - **Username** / **Password** — your relay's SMTP credentials. The password is write-only:
     once saved you cannot read it back, only replace it.
3. **From address** must be a mailbox the relay is authorised to send as, or delivery fails at the
   relay (visible as an `EMAIL_FAILED` audit row with the relay's error).
4. Set **Priority** (lower tries first) and leave **Enabled** checked.
5. Save, then click **Send test email** on the row — it sends to your own signed-in address and
   shows the outcome (`sent` or the error code) inline.

## Reordering and fallback

Use the up/down arrows in the **Order** column to change priority (each click swaps priority with
the neighbour). With two or more enabled providers, a failure at the top of the list falls through
to the next one automatically — no manual failover step. You cannot delete or disable the only
currently-enabled provider (`409 last_enabled_provider`); add or enable a second one first if you
need to retire the last one.

## The `log` provider

Writes the message to `console` (visible in `wrangler tail` / local dev) instead of sending it.
For local development only — the API refuses to create or enable one when `ENVIRONMENT ===
"production"` (`400 log_provider_disabled_in_production`).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `503 provider_secrets_key_missing` on save | `PROVIDER_SECRETS_KEY` secret not set in this environment | Run the deploy workflow (creates it once), or `wrangler secret put PROVIDER_SECRETS_KEY` locally in `.dev.vars` for `wrangler dev`. |
| Test send fails with an SMTP error code | Relay rejected the credentials, host, or `from` address | Check the relay's own logs/dashboard; the error code in the audit log (`EMAIL_PROVIDER_TESTED`) is whatever the relay returned, never the password. |
| OTP emails silently keep working after this slice with zero rows configured | Expected — the `EMAIL` binding fallback is intentional (see "How sending works"). | Configure a provider only if you want ordering, SMTP, or the log provider. |
| `409 last_enabled_provider` deleting or disabling a row | It is the only enabled provider | Enable another provider first. |

## References

- ADR `docs/decisions/0010-email-provider-registry.md`
- Slice `docs/slices/1.5-email-providers.md`
- Spec §25 (alert channels include email), §38 (secrets — provider credentials not in plaintext)
