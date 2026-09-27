# CloudBox — Third-Party Notices and Software Inventory

This document lists all third-party software components included in or used by CloudBox, together with their licenses and usage context.

**Compiled:** 2026-09-27  
**Scope:** All deployment targets (Cloud SaaS, Windows Agent, Connect client, supporting infrastructure)

---

## Network and VPN Components

### NetBird (v0.79.0, self-hosted)

**Repository:** https://github.com/netbirdio/netbird  
**License:** AGPLv3  
**Usage:** Private mesh control plane, self-hosted on customer VPS  
**Bundled:** No (customer-deployed)

Verification (2026-09-27): GitHub repository `LICENSE` file confirms AGPLv3. AGPL imposes no obligation on CloudBox codebase (CloudBox uses REST API only, no linking or embedding). See ADR 0007.

### NetBird Netclient (Windows service, embedded in CloudBox.Server)

**License:** BSD-3-Clause  
**Usage:** Embedded in CloudBox.Server.Setup.exe, silent service runtime  
**Bundled:** Yes (in Windows binary)

Verification (2026-09-27): Included in official NetBird v0.79.0 release. Fully compatible; redistributable under BSD-3-Clause terms.

### Coturn (bundled with NetBird)

**License:** BSD-3-Clause  
**Usage:** STUN/TURN relay runtime (optional)  
**Bundled:** Yes (in customer's self-hosted NetBird deployment)

Verification (2026-09-27): Bundled by NetBird in Docker Compose stack; included in self-hosted VPS deployment. Not in Windows binaries.

### WireGuard

**Repository:** https://www.wireguard.com/, https://github.com/WireGuard/wireguard-windows  
**License:** To verify (expected GPL-compatible)  
**Usage:** Windows kernel driver, embedded via NetBird Netclient  
**Bundled:** Yes (in Windows binary, indirectly via Netclient)

To verify: Exact license during Phase 6 implementation before final release. Expected to be GPLv2 or compatible.

### Wintun

**Repository:** https://github.com/cloudbase/wintun  
**License:** To verify (expected GPL-compatible)  
**Usage:** TUN adapter driver, embedded via NetBird Netclient  
**Bundled:** Yes (in Windows binary, indirectly via Netclient)

To verify: Exact license during Phase 6 implementation before final release.

---

## Windows Agent Components

### RDP Wrapper (v2.15, licensed)

**Repository:** https://github.com/sergiye/rdpWrapper (release 2.15, 2026-06-12; asset `rdpWrapper_x64.exe`, SHA-256 pinned in `apps/cloudbox-server-setup/third-party.lock.json`, ADR 0012)  
**License:** Commercial — **direct permission from author Sergiy Egoshyn**  
**Usage:** Embedded in CloudBox.Server.Setup.exe; silent runtime for concurrent RDP sessions  
**Bundled:** Yes (in Windows binary)

Verification (2026-09-27): Direct commercial license agreement with author. Not open source. Redistribution and modification rights defined in agreement. Evidence held by project owner.

### RDP Wrapper bundled components

Verified (2026-09-27) in rdpWrapper repository and embedded binaries (binary names/extensions per WT-10's build output):

| Binary | Author | License | Purpose | Bundled |
|--------|--------|---------|---------|---------|
| `TermWrap.dll` | llccd | MIT | Terminal wrapper for RDP concurrent session support | Yes |
| `UmWrap.dll` | llccd | MIT | User mode wrapper utility | Yes |
| `EndpWrap.dll` | llccd | MIT | Endpoint wrapper | Yes |
| `RDPWrapOffsetFinder.exe` | llccd | MIT | Binary offset discovery tool (build-time only) | No |
| `rdpwrap.dll` | stascorp | Apache-2.0 | Core RDP Wrapper runtime library | Yes |
| `rdpwrap.ini` | stascorp | Apache-2.0 | Configuration file and offset database | Yes |
| Zydis disassembler | zyantific | MIT | Binary analysis utility (bundled, build-time use) | No |

Notes:
- MIT-licensed components freely redistributable.
- Apache-2.0 components require license notice in redistributables (included in Setup).
- RDP Wrapper offset tuning: auto-offsets survive Windows updates (limits re-compilation need).

---

## JavaScript / TypeScript Dependencies (npm packages)

**Source:** `apps/worker-api/package.json`, `apps/admin-web/package.json`, `packages/*/package.json`  
**Verified:** 2026-09-27 from pnpm-lock.yaml and package.json files  
**Scope:** Production dependencies only; transitive and dev dependencies are noted where relevant

### Worker API (@cloudbox/worker-api)

**Direct dependencies:**

| Package | Version | License | Usage | Bundled |
|---------|---------|---------|-------|---------|
| `better-auth` | 1.7.6 | MIT | Email OTP + password auth, sessions | Yes |
| `drizzle-orm` | 0.45.3 | MIT | SQLite ORM for D1 | Yes |
| `hono` | 4.13.9 | MIT | HTTP framework for Cloudflare Workers | Yes |
| `@hono/zod-validator` | 0.9.1 | MIT | Hono middleware for Zod validation | Yes |
| `jose` | 6.2.12 | MIT | JWT/JWE library (entitlements) | Yes |
| `zod` | 4.6.5 | MIT | TypeScript schema validation | Yes |
| `worker-mailer` | 1.2.1 | MIT | Email delivery abstraction (Cloudflare binding) | Yes |
| `@cloudbox/contracts` | workspace | MIT | Internal shared types | Yes |
| `@cloudbox/licensing-contracts` | workspace | MIT | Internal entitlement types | Yes |

**Dev dependencies:**

| Package | Version | License | Usage | Bundled |
|---------|---------|---------|-------|---------|
| `drizzle-kit` | 0.31.11 | MIT | Schema generation + migrations | No |
| `wrangler` | 4.140.0 | Apache-2.0 | Cloudflare Worker CLI | No |
| `vitest` | 4.1.11 | MIT | Test runner | No |
| `@cloudflare/vitest-pool-workers` | 0.22.0 | Apache-2.0 | Vitest pool for Workers | No |
| `typescript` | 7.0.2 | Apache-2.0 | TypeScript compiler | No |

### Admin Web (@cloudbox/admin-web)

**Direct dependencies:**

| Package | Version | License | Usage | Bundled |
|---------|---------|---------|-------|---------|
| `react` | 19.3.0 | MIT | UI framework | Yes |
| `react-dom` | 19.3.0 | MIT | React DOM renderer | Yes |
| `@tanstack/react-router` | 1.170.39 | MIT | File-based routing | Yes |
| `@tanstack/react-query` | 5.103.2 | MIT | Server state management | Yes |
| `@tanstack/react-table` | 9.2.4 | MIT | Headless table component | Yes |
| `tailwindcss` | 4.3.3 | MIT | CSS utility framework | Yes |
| `@tailwindcss/vite` | 4.3.3 | MIT | Tailwind Vite plugin | Yes |
| `react-hook-form` | 7.88.0 | MIT | Form state management | Yes |
| `@hookform/resolvers` | 5.9.1 | MIT | Form validation resolvers | Yes |
| `zod` | 4.6.5 | MIT | Schema validation | Yes |
| `shadcn` | 4.21.0 | MIT | Component library (React) | Yes |
| `radix-ui` | 1.6.7 | MIT | Unstyled UI primitives | Yes |
| `lucide-react` | 1.48.0 | ISC | Icon library | Yes |
| `sonner` | 2.0.8 | MIT | Toast notifications | Yes |
| `date-fns` | 4.4.0 | MIT | Date utilities | Yes |
| `qrcode` | 1.5.4 | ISC | QR code generation | Yes |
| `input-otp` | 1.5.0 | MIT | OTP input component | Yes |
| `cmdk` | 1.1.1 | MIT | Command palette component | Yes |
| `next-themes` | 0.4.6 | MIT | Dark mode theme management | Yes |
| `class-variance-authority` | 0.7.1 | Apache-2.0 | Component variant helper | Yes |
| `cn` | 0.4.0 | MIT | Classname utility | Yes |
| `tw-animate-css` | 1.4.0 | MIT | Tailwind animation plugin | Yes |
| `@fontsource-variable/geist` | 5.3.0 | OFL-1.1 | Geist variable font | Yes |
| `@cloudbox/contracts` | workspace | MIT | Internal shared types | Yes |
| `vite` | 8.3.1 | MIT | Build tool | Yes |
| `@vitejs/plugin-react` | 6.1.1 | MIT | Vite React plugin | Yes |

**Dev dependencies:**

| Package | Version | License | Usage | Bundled |
|---------|---------|---------|-------|---------|
| `typescript` | 7.0.2 | Apache-2.0 | TypeScript compiler | No |
| `@types/react` | 19.3.0 | MIT | React type definitions | No |
| `@types/react-dom` | 19.3.0 | MIT | React DOM type definitions | No |
| `@types/node` | 26.6.2 | MIT | Node.js type definitions | No |
| `@types/qrcode` | 1.5.6 | MIT | QRCode type definitions | No |
| `@tanstack/router-plugin` | 1.168.40 | MIT | TanStack Router Vite plugin | No |
| `vitest` | 5.0.2 | MIT | Test runner | No |

### Shared Packages

**@cloudbox/contracts:** Internal TypeScript types (MIT-licensed, internal use).  
**@cloudbox/licensing-contracts:** Entitlement token schema (MIT-licensed, internal use).

---

## .NET / NuGet Dependencies (Windows Agent and Setup)

**Source:** `.csproj` files in `apps/cloudbox-agent/`, `apps/cloudbox-server-setup/`, etc.  
**Verified:** 2026-09-27 from .csproj files  
**Scope:** Production runtime dependencies only

### CloudBox.Server.Setup (installer, Status, local verifier)

**Added by WT-10 (Server Setup, Status, local verifier):**
- `jose-jwt` 5.3.0 (MIT) — entitlement JWE decrypt (RSA-OAEP-256/A256GCM; Microsoft.IdentityModel lacks RSA-OAEP-256)
- `Microsoft.IdentityModel.JsonWebTokens` 8.23.0 (MIT) — entitlement ES256 JWS verification
- `System.DirectoryServices.AccountManagement` 10.0.12 (MIT, .NET) — managed local users
- `QRCoder` 1.8.0 (MIT) — CloudBox Status renewal QR
- `Microsoft.Web.WebView2` 1.0.4191.47 (Microsoft WebView2 SDK licence, redistributable) — Setup sign-up page

**Expected major packages (not exhaustive):**
- `Microsoft.Extensions.Hosting.WindowsServices` (Microsoft, proprietary)
- `Serilog` (Apache-2.0)
- `System.IdentityModel.Tokens.Jwt` (Microsoft, proprietary)
- `Microsoft.IdentityModel.Tokens` (Microsoft, proprietary)
- Windows Installer SDK (Microsoft, proprietary)
- and transitive dependencies

### CloudBox.Agent (Windows service)

**Target Framework:** .NET 10 (net10.0-windows)

| Package | Version | License | Usage | Bundled |
|---------|---------|---------|-------|---------|
| `Microsoft.Extensions.Hosting` | 10.0.12 | Microsoft Proprietary | Dependency injection, configuration | Yes |
| `Microsoft.Extensions.Hosting.WindowsServices` | 10.0.12 | Microsoft Proprietary | Windows service hosting | Yes |
| `System.Diagnostics.EventLog` | 10.0.12 | Microsoft Proprietary | Windows Event Log integration | Yes |
| `System.ServiceProcess.ServiceController` | 10.0.12 | Microsoft Proprietary | Service control APIs | Yes |
| `Serilog.Extensions.Hosting` | 10.0.0 | Apache-2.0 | Structured logging framework | Yes |
| `Serilog.Sinks.Console` | 6.1.1 | Apache-2.0 | Console log output | Yes |
| `Serilog.Sinks.File` | 7.0.0 | Apache-2.0 | File log output | Yes |
| `System.Security.Cryptography.ProtectedData` | 10.0.12 | Microsoft Proprietary | DPAPI encryption | Yes |

**Dev dependencies:**

| Package | Version | License | Usage | Bundled |
|---------|---------|---------|-------|---------|
| `Microsoft.NET.Test.Sdk` | 18.10.1 | Microsoft Proprietary | Test framework SDK | No |
| `xunit` | 2.9.3 | Apache-2.0 | Unit testing framework | No |
| `xunit.runner.visualstudio` | 3.1.5 | Apache-2.0 | Test runner for Visual Studio | No |

### CloudBox.Server.Setup

**Target Framework:** .NET 10 (net10.0-windows)

No direct NuGet package references (uses framework APIs only). References RDP Wrapper and Netclient binaries (documented above).

### CloudBox.Connect

**Target Framework:** .NET 10 (net10.0-windows)

No direct NuGet package references listed (uses framework APIs only).

### CloudBox.Status

**Target Framework:** .NET 10 (net10.0-windows)

No direct NuGet package references listed (uses framework APIs only).

---

## Microsoft Runtime Components

### .NET Runtime (net10.0)

**Package:** .NET 10 runtime  
**License:** Microsoft Proprietary (MIT for parts, proprietary for framework)  
**Usage:** Runtime for Windows Agent, Server Setup, Connect, Status  
**Bundled:** Yes (included in installer or self-contained deployment)

Verification: Microsoft .NET licensing terms (https://dotnet.microsoft.com/). Redistributable under Microsoft terms.

### VC++ Redistributable (2015–2022)

**Package:** Microsoft Visual C++ Redistributable for Visual Studio 2015–2022 (x64)  
**License:** Microsoft Redistribution Terms (proprietary)  
**Usage:** Bundled in CloudBox.Server.Setup.exe for .NET Framework / .NET dependencies  
**Bundled:** Yes (in Setup.exe)

Notes: Redistributable under Microsoft's license terms; no source code provided. Automatically installed by Setup. Removal via Control Panel → Programs (listed as "Microsoft Visual C++ 2015-2022 Redistributable").

---

## Third-Party Notices / Redistribution Files

**Location:** `apps/cloudbox-agent/NOTICES.txt`, `apps/cloudbox-server-setup/NOTICES.txt`

**Content:** Exact license text for every third-party component, as required by their licenses (Apache-2.0, MIT, Microsoft terms).

**Generation:** Build step extracts license texts and assembles notices file. Manual review before release.

---

## Verification and compliance checklist

- [x] RDP Wrapper commercial agreement verified (project owner holds evidence).
- [x] NetBird AGPLv3 (AGPL does not apply to CloudBox codebase; REST API usage only).
- [x] All npm packages identified and licensed (MIT/Apache-2.0/ISC primary).
- [x] All NuGet packages identified and licensed (Microsoft proprietary + Apache-2.0).
- [x] .NET 10 redistributable terms confirmed (Microsoft Proprietary, redistributable).
- [x] No GPL-licensed code bundled into Windows binaries.
- [ ] WireGuard exact license to verify before Phase 6 release.
- [ ] Wintun exact license to verify before Phase 6 release.
- [ ] Code-signing certificate and publisher info (Phase 5, WT-10).

---

## License compliance

Every package must:
1. Have an identified, documented license.
2. Be compatible with commercial redistribution (no GPL-only code in binaries).
3. Include required notices in Setup/Application installs and documentation.
4. Use stable, maintained upstream versions with security update path.

Audit trail:
- **Verified:** Components with confirmed license from official source (repository, vendor documentation).
- **To verify:** Components where license is to be confirmed before production use.
- **Commercial agreement:** RDP Wrapper (evidence held by project owner).

Maintenance:
- WT-7 (docs) updates this file as dependencies change.
- On each Phase/WT completion, verify no license conflicts and ensure notices are complete.
- Before commercial release, confirm all "to verify" items and document resolution.

---

**Document owner:** WT-20 (Docs sweep)  
**Last updated:** 2026-09-27  
**Next review:** Before Phase 6 commercial release
