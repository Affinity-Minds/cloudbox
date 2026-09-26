# CloudBox — Third-Party Notices and Software Inventory

This document lists all third-party software components included in or used by CloudBox, together with their licenses and usage context.

**Compiled:** 2026-09-26  
**Scope:** All deployment targets (Cloud SaaS, Windows Agent, Connect client, supporting infrastructure)

---

## Network and VPN Components

### NetBird (v0.79.0, self-hosted)

**Repository:** https://github.com/netbirdio/netbird  
**Verified:** 2026-09-26

| Component | License | Usage | Notes |
|---|---|---|---|
| NetBird server (`management/`, `signal/`, `relay/`) | AGPLv3 | Private mesh control plane, self-hosted on customer VPS | No linking or embedding of AGPL code in CloudBox codebase; CloudBox uses REST API only. AGPL imposes no obligation on CloudBox. See ADR 0007. |
| NetBird client (Windows Netclient) | BSD-3-Clause | Embedded in CloudBox.Server.Setup.exe, silent service runtime | Fully compatible; redistributable. |
| Coturn (bundled with NetBird compose) | BSD-3-Clause | STUN/TURN relay runtime | Bundled by NetBird; included in self-hosted deployment. |

### WireGuard and Wintun

**Repository:** https://www.wireguard.com/, https://github.com/cloudbase/wintun  
**License:** To verify  
**Usage:** Windows kernel driver, embedded via Netclient | Licence: to verify from the upstream repositories during Phase 6 before bundling. No claim is made here. |

---

## Windows Agent Components

### RDP Wrapper (sergiye/rdpWrapper, pinned v2.15)

**Repository:** https://github.com/stascorp/rdpwrap (archived); maintained fork: https://github.com/sergiye/rdpwrap  
**License:** Commercial — **direct permission from author Sergiy Egoshyn**  
**Evidence:** Held privately; confirmed by project owner (2026-09-26)  
**Usage:** Embedded in CloudBox.Server.Setup.exe; silent runtime for concurrent RDP sessions  
**Terms:** Commercial use permitted under direct license agreement with author. Not open source. Redistribution and modification rights defined in agreement. |

#### RDP Wrapper Bundled Components

Verified (2026-09-26) in rdpWrapper repository and embedded binaries:

| Binary | Author | License | Purpose |
|---|---|---|---|
| `TermWrap.exe` | llccd | MIT | Terminal wrapper for RDP concurrent session support |
| `UmWrap.exe` | llccd | MIT | User mode wrapper utility |
| `EndpWrap.exe` | llccd | MIT | Endpoint wrapper |
| `RDPWrapOffsetFinder.exe` | llccd | MIT | Binary offset discovery tool (build-time only) |
| `rdpwrap.dll` | stascorp | Apache-2.0 | Core RDP Wrapper runtime library |
| `rdpwrap.ini` | stascorp | Apache-2.0 | Configuration file and offset database |
| Zydis disassembler | zyantific | MIT | Binary analysis utility (bundled, build-time use) |

**Notes:**
- MIT-licensed components freely redistributable.
- Apache-2.0 components require license notice in redistributables (included in CloudBox.Server.Setup).
- RDP Wrapper offset tuning: auto-offsets survive Windows updates (documented behavior; limits re-compilation need).

---

## JavaScript / TypeScript Dependencies (npm packages)

**Source:** `package.json` files in monorepo  
**Status:** To be inventoried after foundation commit (WT-0)  
**When:** Foundation commit lands; WT-7 runs `npm ls --depth=0` and inventories all production dependencies.

**Location:** docs/THIRD_PARTY_NOTICES.md §JavaScript/TypeScript Dependencies (inventory table)

**Expected major packages (not exhaustive):**
- `better-auth` (maintained, Apache-2.0 or MIT — to verify)
- `hono` (Cloudflare framework, MIT)
- `drizzle-orm` (MIT)
- `@tanstack/react-router`, `@tanstack/react-table` (MIT)
- `react`, `react-dom` (MIT)
- `tailwindcss` (MIT)
- `shadcn/ui` (MIT, component library)
- `jose` (cryptography, MIT)
- `zod` (validation, MIT)
- `lucia` (authentication, MIT)
- and transitive dependencies (scan on WT-7 completion)

**Process:**
1. After foundation commit, WT-0 pushes to `phase-1/identity`
2. WT-7 scans `package.json` and `pnpm-lock.yaml`
3. WT-7 inventories name/version/license for all production deps
4. WT-7 updates this section with complete table
5. No unknown or unlicensed packages proceed to production

---

## .NET / NuGet Dependencies (Windows Agent and Setup)

**Source:** `.csproj` files in `apps/cloudbox-agent`, `apps/cloudbox-server-setup`  
**Status:** To be inventoried after WT-4 foundation (Windows components)  
**When:** WT-4 publishes baseline Windows build; WT-7 inventories from publish artifacts.

**Expected major packages (not exhaustive):**
- `Microsoft.Extensions.Hosting.WindowsServices` (Microsoft, proprietary)
- `Serilog` (Apache-2.0)
- `System.IdentityModel.Tokens.Jwt` (Microsoft, proprietary)
- `Microsoft.IdentityModel.Tokens` (Microsoft, proprietary)
- Windows Installer SDK (Microsoft, proprietary)
- and transitive dependencies

**Process:**
1. WT-4 builds and publishes `CloudBox.Agent.exe` CI artifact
2. WT-7 inspects `.csproj` and artifact metadata
3. WT-7 inventories license for all referenced packages
4. WT-7 updates this section with complete table
5. Build step verifies no GPL/AGPL/.NET Framework licensing conflicts

---

## Microsoft Runtime Components

### VC++ Redistributable (2015–2022)

**Package:** Microsoft Visual C++ Redistributable for Visual Studio 2015–2022 (x64)  
**License:** Microsoft Redistribution Terms (proprietary)  
**Usage:** Bundled in CloudBox.Server.Setup.exe for .NET Framework / .NET dependencies  
**Notes:** Redistributable under Microsoft's license terms; no source code provided. Automatically installed by Setup. Removal via Control Panel → Programs (listed as "Microsoft Visual C++ 2015-2022 Redistributable").

---

## Verification and Compliance

### License Compliance

Every package must:
1. Have an identified, documented license
2. Be compatible with commercial redistribution (no GPL/AGPL code in CloudBox binaries)
3. Include required notices in Setup/Application installs and documentation
4. Use stable, maintained upstream versions with security update path

### Audit trail

- **Verified:** Components with confirmed license from official source (repository, vendor documentation)
- **To verify:** Components where license is to be confirmed before production use
- **Commercial agreement:** RDP Wrapper (see evidence section)

### Evidence and provenance

- **RDP Wrapper agreement:** Evidence held privately by project owner
- **NetBird verification:** GitHub repository license tag, release notes
- **Microsoft components:** License terms from Microsoft documentation
- **npm packages:** Checked via `npm ls --long` and LICENSE file review
- **Build artifacts:** Code-signing certificate and publisher info (to be added Phase 5)

### Maintenance

WT-7 maintains this file as dependencies change. On each Phase/WT completion:
1. WT-0 (foundation) updates with npm/NuGet packages
2. WT-4 (Windows) updates with .NET runtime components
3. WT-9 (Networking) updates with NetBird/WireGuard specifics
4. WT-7 confirms no license conflicts and ensures notices are complete

---

## Third-Party Notices / Redistribution Files

**Location:** `apps/cloudbox-agent/NOTICES.txt`, `apps/cloudbox-server-setup/NOTICES.txt`

**Content:** Exact license text for every third-party component, as required by their licenses (Apache-2.0, MIT, Microsoft terms).

**Generation:** Build step extracts license texts and assembles notices file. Manual review before release.

---

## Questions and To-Verify

- [ ] WireGuard exact license and Wintun license — confirm via official repository
- [ ] `better-auth` license exact terms (Apache-2.0 or MIT)
- [ ] All npm transitive dependencies — full inventory after foundation
- [ ] All NuGet transitive dependencies — full inventory after WT-4 baseline
- [ ] Microsoft VC++ 2015–2022 Redistributable: confirm redistribution terms allow bundling in Setup (expect yes)
- [ ] Code-signing certificate provider and license (Phase 5, WT-10)

---

**Document owner:** WT-7 (Docs)  
**Last updated:** 2026-09-26 (initial inventory frame)  
**Next review:** After foundation commit (npm/NuGet packages added)
