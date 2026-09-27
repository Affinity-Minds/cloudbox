# Runbook — NetBird self-hosted server (ADR 0007)

Setting up the private-mesh control plane on the owner's VPS, and the exact verification steps to
run once it exists. Until this is done, `NETBIRD_API_URL` stays unset and the whole controller
(`apps/worker-api/src/network/`) is a no-op — production is unaffected either way.

## 1. Provision the VPS

- 1 CPU / 2 GB minimum, 2 CPU / 4 GB recommended, Linux (Ubuntu 22.04+ or similar), Docker installed.
- DNS: `net.affinityminds.in` → the VPS's public IP (A record).
- Firewall: TCP 80 and 443 open (Traefik + Let's Encrypt), UDP 3478 open (coturn STUN/TURN).
- SSH access for WT-9/operations.

## 2. Install NetBird

One command, from the NetBird releases page (pin the version — do not track `latest` in
production; ADR 0007 "lock NetBird version in deployment manifest"):

```bash
curl -fsSL https://github.com/netbirdio/netbird/releases/download/v0.79.0/getting-started.sh | bash
```

The script asks for the domain (`net.affinityminds.in`) and an email for Let's Encrypt, then
produces a production-ready Docker Compose stack in the current directory: Traefik, the embedded
identity provider, management, signal, relay and coturn. Bring it up:

```bash
docker compose up -d
docker compose ps   # every service healthy
```

## 3. Create a service-user API token

In the NetBird dashboard (`https://net.affinityminds.in`), sign in with the account the install
script created, then **Settings → Service Users → Add Service User** (role: Admin — the Worker
needs to create/delete groups and policies and mint setup keys). Create an API token for that
service user and copy it immediately; NetBird shows it once.

Set it as a Wrangler secret (never in `wrangler.jsonc`, never in the repo):

```bash
CLOUDFLARE_ACCOUNT_ID=<id> npx wrangler secret put NETBIRD_API_TOKEN
```

Add the management API's base URL as a var in `apps/worker-api/wrangler.jsonc` (WT-0; see
"Requests to WT-0" in the handoff — this repo's convention is that only WT-0 edits that file):

```jsonc
"vars": { "NETBIRD_API_URL": "https://net.affinityminds.in" }
```

Deploy. From that point on, every enroll, Connect network request and revoke call goes through
`apps/worker-api/src/network/controller.ts` instead of being a no-op.

## 4. Delete the Default policy — before onboarding any tenant

The install script's NetBird ships one policy named **Default**, allow-all, so a fresh install is
not isolated by tenant until this is removed. CloudBox's own controller **refuses to provision any
tenant network while it is present** (`assertDefaultPolicyAbsent`, called by
`ensureTenantNetwork`/`ensureSupportAccess` — a call to either throws with the policy's id until
this step is done), so this is a hard gate, not a suggestion.

Dashboard: **Policies → Default → Delete**. Or via the API:

```bash
curl -s -H "Authorization: Token $NETBIRD_API_TOKEN" https://net.affinityminds.in/api/policies \
  | jq '.[] | select(.name=="Default") | .id'
curl -s -X DELETE -H "Authorization: Token $NETBIRD_API_TOKEN" \
  https://net.affinityminds.in/api/policies/<id-from-above>
```

Verify: `GET /api/policies` no longer contains a policy named `Default`.

## 5. Join the gateway peer (`cbx-support`)

The VPS itself (or a small always-on box the provider controls) runs the NetBird client and joins
the `cbx-support` group, so the standing support policy (ADR 0008) has somewhere to source from.
The Worker creates the `cbx-support` group on its own (`ensureSupportAccess`, called from the first
`mintServerSetupKey`), but does not create *peers* — that is a one-time manual step here:

```bash
# on the gateway box, once cbx-support exists (check the dashboard, or GET /api/groups)
curl -s -X POST -H "Authorization: Token $NETBIRD_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"cbx-support-gateway","type":"reusable","expires_in":31536000,"auto_groups":["<cbx-support group id>"],"usage_limit":0}' \
  https://net.affinityminds.in/api/setup-keys
# then, on the gateway box itself:
netbird up --setup-key <key-from-above> --management-url https://net.affinityminds.in
netbird status --json   # confirms it joined and lists its groups
```

## 6. Verification checklist (run once the VPS exists, before announcing this to any real tenant)

This is the checklist `docs/handoffs/wt-p6-network-adapter.md` promises. Everything up to here
(steps 1–5) is a one-time setup; this section is repeatable and should be re-run after any NetBird
upgrade or restore-from-backup.

1. **Env wired correctly**: `curl https://box.affinityminds.in/api/v1/agent/enroll` behaviour is
   unaffected by NetBird being present (the route itself still requires a real enrollment token —
   this just confirms the deploy picked up the new var/secret without erroring at boot).
2. **Default policy absent**: `GET /api/policies` has no `name: "Default"` row. If a NetBird
   upgrade or a fresh restore reintroduces it, every tenant-network call starts throwing again —
   that is the intended fail-closed behaviour, not a bug.
3. **Enroll mints a real key and it works**: issue a staff enrollment token, `POST
   /api/v1/agent/enroll` with a real (or `jose`-generated test) device key. The 201 body's
   `network.setupKey` and `network.managementUrl` should be usable directly by the NetBird Windows
   client: `netbird up --setup-key <that key> --management-url <that URL>`. Confirm the machine
   shows up in `GET /api/peers` in the `cbx-server-<tenant public code>` group.
4. **Tenant isolation, for real**: enroll one server for Tenant A and one for Tenant B, join a
   NetBird client into each tenant's `cbx-client-<code>` group (via `GET
   /api/v1/connect/devices/:deviceId/network`). From A's client, `ping`/RDP to B's server must
   fail; from A's client to A's server must succeed on 3389. Capture this with `netbird status
   --json` on each peer (reachable peers list) plus a packet capture or a failed `Test-NetConnection
   -Port 3389` from PowerShell, and attach both to the ADR 0007 evidence trail (master spec §15.3
   calls this out as the hard test).
5. **Support access, for real**: from the `cbx-support` gateway peer, confirm it can reach *every*
   tenant's server group on 3389 (and the reserved management port — see the handoff's "Decisions
   needed" for that port number), without needing a per-tenant setup step. Then revoke one
   device (`POST /devices/:id/revoke`) and confirm `GET /api/peers` no longer lists it and support
   access to it is gone too (nothing to reach).
6. **Setup key hygiene**: confirm a minted one-off key cannot be reused — attempt `netbird up`
   twice with the same key; the second attempt must fail (NetBird's own one-off enforcement, not
   CloudBox's).
7. **Outage behaviour (master spec §41)**: stop the NetBird compose stack (`docker compose down`)
   while a peer that already joined keeps an active connection; confirm existing traffic keeps
   flowing (WireGuard direct paths survive control-plane loss) while new enrolls/joins fail
   gracefully — the enroll response simply omits `network` if the Worker's own calls to
   `NETBIRD_API_URL` start timing out (the client's retry/backoff in `netbird.ts` still applies;
   after that, the device is enrolled and licensed without network, same as before this slice
   existed).
8. **Backup restore**: from a nightly `/var/lib/netbird` backup, restore onto a scratch VPS and
   confirm groups/policies/peers come back intact (see the outage runbook in
   `docs/runbooks/vpn-controller-recovery.md`, WT-9's skeleton — fill it in once this is run for
   real).

## Backups

Nightly snapshot of `/var/lib/netbird` (the management store is the mesh's identity database —
losing it means every peer needs to re-enroll). A simple cron entry is enough for Alpha:

```bash
0 3 * * * tar czf /backups/netbird-$(date +%F).tar.gz -C /var/lib netbird
```

## Env / secret names (for reference)

| Name | Kind | Set where | Notes |
|---|---|---|---|
| `NETBIRD_API_URL` | var | `apps/worker-api/wrangler.jsonc` (WT-0) | e.g. `https://net.affinityminds.in`; unset ⇒ every controller call is a no-op |
| `NETBIRD_API_TOKEN` | secret | `wrangler secret put` | the service-user token from step 3; never logged, never returned by any API |
