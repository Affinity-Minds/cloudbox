# Runbook — server licence keys (resellers)

Server licence keys let a PC store sell CloudBox with a machine. The buyer signs up at
`https://box.affinityminds.in/start`, chooses **Have a licence key?**, and the key creates their
organisation with the key's plan attached as *pending*. The plan's term starts when their first
server is activated (ADR 0011). Keys look like `CBX-LIC-XXXXX-XXXXX-XXXXX-XXXXX`.

CloudBox stores only a hash of each key and its **last four symbols**. The full keys are shown
once, when the batch is generated. There is no way to show them again.

## Generate a batch for a store

Needs a staff role with `license.issue` (Super Admin, Admin).

1. Ops console → **Licence keys** → **Generate batch**.
2. Plan: the plan the store sells. Quantity: up to 500. Batch label: the store and order, e.g.
   `Store A — October`. Expiry: optional; after it an unredeemed key stops working.
3. **Generate**. The keys appear once. **Download CSV** (columns `key,last4,plan,batch,expires_at`)
   and send it to the store over a channel you would use for money (the keys are sellable).
   **Copy all** is the alternative.
4. Close the dialog. The batch row shows the counts: keys, unredeemed, redeemed, revoked.

API equivalent (staff session cookie):

```
POST /api/v1/license-keys/batches
Accept: text/csv            # or application/json for {batchId, keys:[{id, code, last4}], …}
{"planCode":"cloudbox-6","quantity":50,"batchLabel":"Store A — October","expiresAt":"2027-03-31T23:59:59Z"}
```

Audit: `LICENSE_KEYS_GENERATED` (batch, plan, count; never the keys).

## Look a key up (support)

Any staff role with `subscription.view` (all roles) or `license.issue`.

- A customer or store reads you the **last four symbols** of the key (or the whole key; you only
  need the end). Ops console → Licence keys → **Last four** filter. The row shows the batch, status
  (unredeemed / expired / redeemed / revoked), who redeemed it and the tenant it created.
- API: `GET /api/v1/license-keys?last4=HP48` (also `?batch=<batchId>`, `?status=redeemed`).
- Two keys can share the last four symbols; confirm with the batch label and the store.
- Buyers may type keys in lower case, with spaces or without dashes: the server re-formats them
  before checking.
- A buyer whose key "is not valid" gets the same answer for used, expired, revoked and mistyped
  keys (by design). Look it up: redeemed → by whom and when; expired → the batch expiry; revoked →
  the reason (hover the pill); not found → a typo (Crockford symbols: no I, L, O, U).

## Revoke a key

Needs `license.revoke` (Super Admin). Only unredeemed keys can be revoked.

1. Licence keys → find the key (last four, batch) → **Revoke** → type the reason (e.g. "card lost
   by the store") → **Revoke key**.
2. Anyone who tries it afterwards is told the key is not valid.

API: `POST /api/v1/license-keys/:id/revoke {"reason":"card lost by the store"}`.
Audit: `LICENSE_KEY_REVOKED` (reason, last four, batch).

A **redeemed** key is not revoked here: the organisation already exists. To stop service, change
that tenant's subscription (Subscriptions → the tenant → Edit → status `suspended` or
`cancelled`), which stops new licences; the devices' leases then lapse at their end date + grace.

## After redemption

- Tenant: status `provisioning`, the buyer is its Owner, a `pending` subscription for the key's
  plan (Subscriptions shows *pending activation*).
- The buyer runs the Setup app on the server and signs in; the app activates the machine. At that
  first activation the subscription becomes `active` (`valid_from` = now, `valid_until` = now +
  the plan's term) and the server receives its licence.
- Audit trail for one redemption: `LICENSE_KEY_REDEEMED`, `TENANT_CREATED`, `USER_INVITED` (source
  `license_redemption`), `SUBSCRIPTION_CHANGED` (source `license_key`), later
  `SUBSCRIPTION_REDEEMED` and `LICENSE_ISSUED` (source `activation`).
