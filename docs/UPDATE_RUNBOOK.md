# CloudBox Update and Rollback Runbook

This document provides links to update procedures. **The cloud side (this file's Pilot → Stable →
rollback procedure) is implemented (WT-18, Phase 10, Slices 10.1–10.4). The local Windows updater
that a device runs is a later slice** — everything below the "Cloud procedure" section describes
what the cloud already does today and what the device side still needs to do once it exists.

## Quick Links

- **Full runbook:** [docs/runbooks/update-rollback.md](runbooks/update-rollback.md)
- **Release-signing key runbook:** [docs/runbooks/release-key-rotation.md](runbooks/release-key-rotation.md)
- **As-built slice doc:** [docs/slices/10.1-10.4-releases.md](slices/10.1-10.4-releases.md)
- **Format decision:** [ADR 0012](decisions/0012-release-manifest-format.md)
- **OTA System Specification:** master spec §18, §45, §50

## Update Channels

CloudBox supports four update channels:

1. **Development** — freshest build; visible only through an explicit device assignment (the "Internal lab" stage). A release starts here (`status='draft'`) until promoted.
2. **Pilot** — live, but only to whichever devices/tenants/fleet-percentage an operator has explicitly assigned. Requires no gate to reach.
3. **Stable** — the broadcast default for the component: every device with no explicit assignment gets the newest `channel='stable'`, `status='stable'` release. Reaching it from Pilot requires the health gate below.
4. **Pinned** — a `stable` release taken out of the broadcast default so it can still be handed to specific devices/tenants via an explicit assignment (e.g. holding a customer back during an active rollback).

## Cloud procedure (as built)

### 1. Upload

Updates → **Upload release**: pick the component (Agent/Status/Setup/Connect), a semantic version, a target channel, optionally a minimum Agent version and notes, and the package file (cap 200 MB). The Worker streams the file into R2 (`releases/<component>/<version>/<file>`), computes its SHA-256 while it writes, and signs a manifest (ES256, its own key — never the entitlement key) before the release row is created. Every new release starts as **draft**, whatever target channel was chosen.

### 2. Promote to Pilot

Detail sheet → **Promote to pilot**. No gate. Add assignments (device / tenant / fleet-percentage) so only the intended cohort sees it — an unassigned Pilot release is invisible to every device (it does not become anyone's default).

### 3. Monitor, then promote to Stable

As assigned devices apply the release, they report a terminal state (§45's ten states) back to the cloud. **Promote to stable** is refused (`409 health_gate_failed`) unless at least one device has reported `installed_healthy` **and** none has reported `installed_unhealthy` or `rolled_back`. Once it passes, the release becomes the channel default for the component — every device with no explicit assignment converges on it on its own schedule.

### 4. Rollback

If Stable turns out bad: **Withdraw** (typed reason, required) removes it from every resolution path immediately — no device will be handed it again, even one that already had an explicit assignment to it. Existing assignments stay recorded for audit. To actually move affected devices backward, either wait for them to pick up the previous `stable` release once it is promoted again, or **Pin** an older known-good release and assign it explicitly to the affected devices/tenants.

### 5. Manual per-device check

There is no per-device "check now" button in this slice — that is the device's own polling loop (`GET /api/v1/releases/assigned`), owned by the updater, not the cloud console.

## References

- Spec §18: OTA / automatic updates
- Spec §18.2: update channels; §18.3: package security; §18.6: rollback; §18.7: forced updates (not yet implemented — see "Decisions needed" in the slice doc)
- Spec §45: Update Dashboard, the ten terminal states
- `docs/slices/10.1-10.4-releases.md` for the exact API, resolution order and audit events
