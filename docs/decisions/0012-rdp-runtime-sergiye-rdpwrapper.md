# ADR 0012 — RDP runtime: sergiye/rdpWrapper 2.15 (TermWrap), acquired by pinned hash, driven unattended

**Status:** Accepted (owner decision; WT-10, 2026-09-27). The brief named this ADR 0009; 0009 was taken by the sign-in
model, so it is 0012.

## Context
A CloudBox server is a Windows 10/11 Pro PC that must host several simultaneous Remote Desktop sessions (cloud01..NN).
Client Windows allows one. The spec (§4.7) selects the RDP Wrapper project by Sergiy Egoshyn, who gave the owner direct
permission for commercial bundling (evidence in the private legal records). Customers must never see, download or
configure it (§4.7), and the SaaS/UI must not depend on its file names (Slice 5.2).

## Decision
- **Runtime:** `https://github.com/sergiye/rdpWrapper` release **2.15** (2026-06-12), asset `rdpWrapper_x64.exe`,
  default **TermWrap** mode (automatic offsets: survives Windows updates, no reboot). It needs the VC++ 2015–2022 x64
  runtime, which Setup installs silently.
- **Acquisition, not vendoring:** `apps/cloudbox-server-setup/third-party.lock.json` pins URL, size and SHA-256
  (`bcd0286d…e048`, equal to GitHub's published asset digest and re-computed by CI on every build). CI downloads,
  refuses a mismatch and embeds the file in `CloudBox.Server.Setup.exe`. Same for `vc_redist.x64.exe` (Microsoft's
  versioned URL, whose path carries its own SHA-256). No binary is committed.
- **Driving it:** `-install -offline` / `-uninstall -offline` (`-offline` last, or it checks for updates online), with
  stray instances killed first (a second instance shows a MessageBox even in console mode), a 120 s timeout, and the
  exit code ignored (it exits 0 when its own OS check fails). Success is decided only from the registry:
  `HKLM\SYSTEM\CurrentControlSet\Services\TermService\Parameters\ServiceDll` ends with `TermWrap.dll` (installed) or
  `termsrv.dll` (removed), plus TermService running and the listener up.
- **Defender:** CloudBox adds exclusions for `C:\Program Files\RDP Wrapper` and `C:\Program Files\CloudBox\vendor`
  **before** the runtime is written or run (upstream also adds its own). A quarantined DLL is reported as
  `repair_required`, never a silent failure.
- **Ownership boundary:** upstream changes only TermService's ServiceDll and its own folder. CloudBox owns
  `fDenyTSConnections`, NLA (`UserAuthentication=1`, `SecurityLayer=2`) and the firewall (licence gate); all are
  manifest entries with prior values.
- **Adapter:** `IRdpRuntime.Probe()` normalises to `healthy | wrapper_missing | service_stopped | listener_missing |
  unsupported_runtime | repair_required` (health document `rdp`, Status app, Fleet). `Repair()` restarts TermService or
  re-runs the install from the retained package in `C:\Program Files\CloudBox\vendor`.

## Consequences
- AV vendors periodically flag RDP Wrapper binaries; exclusions reduce but do not remove that risk. Tamper Protection
  managed by an organisation (Intune) can refuse exclusions; Setup then fails the runtime step and rolls back.
- An existing legacy `rdpwrap.dll` or third-party ServiceDll is reported `unsupported_runtime`; Setup does not remove
  someone else's wrapper. A pre-existing TermWrap install is recorded as prior state and left in place on uninstall.
- The VC++ runtime is shared with other software, so uninstall retains it (reported `restored`, excluded from
  verify-clean). Everything else Setup adds is removed.
- Before commercial release: the release checklist must reference the author's permission and a separate licence
  inventory of every binary inside the runtime (TermWrap/UmWrap/EndpWrap/OffsetFinder MIT, rdpwrap Apache-2.0,
  Zydis MIT) — `THIRD_PARTY_NOTICES.md` lists them.

## Verification
CI proves hash pinning, embedding, manifest ordering and the probe state machine (fakes). Only the owner's lab PC can
prove the runtime itself: `docs/runbooks/server-setup-lab.md`.
