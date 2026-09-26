# CloudBox SaaS
## MASTER AGENT BUILD SPEC — Product Vision, Architecture, Requirements, Security, Fleet Operations, Licensing, OTA, Remote Access, Backup, and Agentic Delivery Plan

**Document status:** Authoritative implementation blueprint / agent build contract  
**Project:** CloudBox SaaS  
**Primary deployment model:** Managed Windows business application appliance + cloud SaaS control plane  
**Control plane:** Cloudflare Workers ecosystem  
**Private network:** Self-hosted Netmaker control plane + embedded Netclient/WireGuard runtime; all third-party networking components remain internal implementation details  
**Endpoint operating system:** Windows 11 Pro on physical hardware, no virtualization requirement  
**Primary local workload:** Customer Windows business applications  
**Remote access:** Private overlay network + Windows Remote Desktop  
**Authentication:** SaaS administration uses email + OTP; CloudBox Connect end users use Tenant ID + Client ID + password, with OTP available for enrollment, reset, or step-up policy  
**Licensing:** SaaS subscription entitlement with offline-capable, machine-bound cryptographic lease  
**Audience:** CloudBox engineering, product, support, operations, and autonomous coding agents expected to build the complete product from this document


---

# 0. Agent Build Contract — Read This Before Writing Code

This document is intended to be sufficient context for a capable coding agent to build the project end to end. It is not a brainstorming document. Treat it as the project contract.

When this document is loaded into an implementation agent, the agent MUST first create an execution plan from it, then build the product in the ordered slices defined later. Do not jump directly to attractive UI, network automation, OTA, or licensing enforcement before the foundation slices exist.

## 0.1 Source-of-truth hierarchy

When requirements conflict, resolve them in this order:

1. an explicit instruction from the human project owner in the current task,
2. this Master Agent Build Spec,
3. `sorensd/agent-notes`, which is authoritative engineering guidance for this project,
4. existing project architecture decisions recorded in `docs/decisions/`,
5. established upstream library/framework behavior,
6. generic engineering convention.

An agent MUST NOT silently reinterpret a requirement. If two requirements are irreconcilable, record the conflict in `docs/OPEN_QUESTIONS.md` and stop only the blocked slice, not unrelated work.

## 0.2 Mandatory context-loading order for every fresh agent

Before coding, load:

```text
THIS FILE
↓
sorensd/agent-notes/engineering/coding-agent-instructions.md
↓
sorensd/agent-notes/process/delivery-rules.md
↓
only the task-relevant agent-notes files from its routing table
↓
AGENTS.md in this repository
↓
docs/ARCHITECTURE.md
↓
docs/DECISIONS.md or docs/decisions/*
↓
docs/ISSUE_LOG.md
↓
current phase/slice state
```

For Cloudflare work also load:

- `platform/cloudflare-workers.md`
- `platform/fast-data-hydration.md`

For UI work also load:

- `design/ui-library-ecosystem.md`
- `design/generating-ui.md`
- `design/design-system.md`
- `design/ux-patterns.md`
- `design/framework-selection.md`

For auth/roles work also load:

- `engineering/roles-vs-capabilities.md`
- `engineering/api-versioning.md`
- `engineering/cross-host-impersonation.md` when applicable

For tooling/skill changes load:

- `process/skills-and-tooling.md`

## 0.3 Agent operating rules

The implementation agent MUST:

- integrate before authoring,
- search the repository before creating a new abstraction,
- use maintained packages for auth, crypto, validation, QR, update signing, database access, and UI primitives,
- keep project-specific code focused on CloudBox business logic,
- work in closed vertical slices,
- add tests in the same slice as functionality,
- add audit events in the same slice as state-changing functionality,
- maintain the issue log for expensive/non-obvious failures,
- verify real deployed behavior when an edge/platform/Windows behavior cannot be proven locally,
- never declare a visual feature complete without rendering and inspecting it,
- never mark a networking or licensing feature complete merely because an API returned 200,
- never invent facts about business application behavior, Microsoft licensing, or a third-party project that have not been verified.

## 0.4 The product in one sentence

**CloudBox is a managed SaaS appliance that turns a physical Windows PC into a centrally licensed, privately networked, remotely accessible, backed-up, self-updating business application server that employees reach through a CloudBox client without needing to understand RDP, WireGuard, or Windows administration.**

## 0.5 The three customer-facing products

Only these surfaces should be visible to customers:

```text
1. CloudBox Server
   - installed on the physical Windows host

2. CloudBox Connect
   - installed on employee/client Windows PCs

3. CloudBox Web Portal
   - tenant administration and support-facing SaaS
```

Everything else is internal plumbing:

- RDP Wrapper / TermWrap,
- Netmaker / Netclient,
- WireGuard / Wintun,
- Cloudflare infrastructure,
- update channels,
- machine license blobs,
- support-network peers,
- raw RDP target addresses.

The product may expose required third-party legal notices, but ordinary customers MUST NOT need to operate the upstream tools.

## 0.6 System boundary

The project contains four deployment zones:

```text
A. Cloud SaaS
   Cloudflare Worker + D1 + Durable Objects + R2 + web UI

B. Network control plane
   Self-hosted Netmaker CE infrastructure

C. CloudBox Server endpoint
   Physical Windows 11 Pro machine

D. CloudBox Connect endpoint
   Employee/client Windows machine
```

Each zone must be independently testable and replaceable behind stable interfaces.

## 0.7 Required repositories / packages in the monorepo

The default repository shape is:

```text
/apps
  /admin-web                 # Super Admin operational console
  /tenant-web                # Tenant portal, may share components with admin-web
  /api                       # Cloudflare Worker / Hono API
  /cloudbox-server-setup     # Windows bootstrapper
  /cloudbox-agent            # Windows LocalSystem service
  /cloudbox-status           # interactive local status UI
  /cloudbox-connect          # end-user Windows client
  /network-controller        # integration service/adapter for Netmaker desired state

/packages
  /contracts                 # API schemas, DTOs, validation contracts
  /authz                     # shared permission identifiers and helpers
  /ui                        # project-owned UI primitives/components
  /telemetry                 # event/log contracts
  /licensing-contracts       # entitlement schemas, NOT custom crypto
  /update-contracts          # release/update manifests
  /test-fixtures

/infra
  /cloudflare
  /netmaker
  /windows

/docs
  ARCHITECTURE.md
  SECURITY.md
  BACKUP_RESTORE.md
  OPERATIONS.md
  SUPPORT_BREAK_GLASS.md
  UPDATE_RUNBOOK.md
  THIRD_PARTY_NOTICES.md
  OPEN_QUESTIONS.md
  ISSUE_LOG.md
  /decisions

/tests
  /e2e-cloud
  /e2e-windows
  /integration
  /failure-drills
```

The exact framework-generated layout may differ, but these responsibility boundaries MUST remain visible.

## 0.8 Build philosophy

Each slice must end with something a human can demonstrate. The correct unit of progress is not “created tables” or “wrote service class.” It is “a user can perform the new workflow end to end and the system proves it worked.”

Every slice therefore includes:

```text
DATA → API → AUTHORIZATION → UI/AGENT → AUDIT → TEST → DEMO
```

For Windows-only slices where a cloud DB change is unnecessary, the equivalent closed loop is:

```text
DESIRED STATE → AGENT ACTION → LOCAL VERIFICATION → CLOUD REPORT → UI → TEST → DEMO
```

## 0.9 Required quality gates

A slice may merge only if all applicable gates are green:

- formatter/linter,
- typecheck/build,
- unit tests,
- integration tests,
- migration test,
- permission-boundary test,
- API contract test,
- Windows service integration test where relevant,
- screenshot verification for UI changes,
- live deployment verification where Cloudflare/edge behavior matters,
- physical Windows verification where RDP, TPM, firewall, service recovery, WOL, or update behavior matters.

## 0.10 No hidden global admin shortcuts

Provider/Super Admin access must remain explicit and auditable. The provider may have a support peer present in every tenant private network, but that network path is not equivalent to Windows administrative access.

Emergency Windows access requires the break-glass workflow defined in this document.

## 0.11 Security invariants that must never regress

The following are testable invariants and MUST have regression coverage:

- no public Internet exposure of TCP 3389 is required,
- one tenant cannot discover or route to another tenant,
- one tenant user cannot list another tenant's devices,
- a copied offline entitlement does not validate on another device,
- a normal Connect user cannot obtain Super Admin/provider network access,
- a disabled/expired client cannot establish a new managed session,
- local customer application data is never destroyed as a licensing action,
- break-glass access expires automatically,
- OTA packages fail closed on signature/hash mismatch,
- secrets never live in D1 as plaintext configuration,
- third-party network and RDP tooling are not exposed as the normal customer interface.

## 0.12 First commercial milestone

The first commercially credible build is not “the dashboard works.” It is this physical workflow:

```text
Create tenant
→ enroll one real Windows CloudBox
→ issue machine-bound entitlement
→ reboot it
→ disconnect Internet and prove valid offline operation
→ install CloudBox Connect on second PC
→ authenticate as tenant client
→ connect privately
→ start two simultaneous independent RDP sessions
→ run the managed business application from both
→ complete backup
→ restore the backup to a controlled test location
→ renew entitlement
→ deploy one Pilot OTA update
→ exercise and auto-expire a break-glass support session
```

Until that works, the project is still a prototype.

## 0.13 Implementation state tracking

Create and maintain `docs/BUILD_STATE.md` with:

```markdown
# Current phase
Phase N

# Current slice
N.M — Name

# Status
not_started | in_progress | blocked | done

# Demo path
...

# Evidence
- test output
- screenshot paths
- deployed URL/version
- Windows logs where relevant

# Blockers
...
```

An agent starting a new session MUST read this file before choosing work.

## 0.14 Decision records

Any decision that affects product shape, security, data model, licensing, networking, dependency choice, or deployment must be recorded in `docs/decisions/NNNN-title.md` with:

```text
Context
Decision
Alternatives considered
Consequences
Verification / follow-up
```

Do not bury architectural decisions in chat or commit messages.

## 0.15 Third-party component policy

Third-party components MUST be wrapped behind CloudBox-owned adapters and interfaces. Upstream CLIs/config files are implementation details, not the product API.

For each bundled component record:

- project and version,
- source URL/repository,
- license/permission basis,
- hashes of shipped artifacts,
- whether modified,
- update strategy,
- required notices,
- security advisories relevant to the shipped version.

The direct commercial-use permission received from Sergiy Egoshyn for the selected RDP Wrapper project must be retained in private legal/project evidence. Separate bundled dependencies still require their own license inventory.

## 0.16 Agent stop conditions

An agent MUST stop and ask for a human decision only when one of these occurs:

- a commercial/legal licensing ambiguity would materially affect redistribution,
- a destructive migration would remove customer data,
- a security design needs a new trust assumption not already authorized here,
- a payment/billing provider must be selected,
- an irreversible infrastructure action affects production,
- two authoritative requirements conflict.

Normal package selection, schema naming, UI details, test structure, refactors, and implementation choices should be handled autonomously within this spec and `agent-notes`.

---

# 1. Governing Engineering Authority

This project MUST treat the `sorensd/agent-notes` repository as the authoritative engineering and product-delivery guidance unless an explicit product requirement in this document overrides it.

Before implementing any slice, an agent or engineer MUST read the relevant notes from `sorensd/agent-notes` rather than relying on generic defaults.

At minimum, the following notes are binding:

- `engineering/coding-agent-instructions.md`
- `process/delivery-rules.md`
- `engineering/api-versioning.md`
- `engineering/roles-vs-capabilities.md`
- `platform/cloudflare-workers.md`
- `platform/fast-data-hydration.md`
- `design/ui-library-ecosystem.md`
- `design/generating-ui.md`
- `design/design-system.md`
- `design/ux-patterns.md`
- `design/framework-selection.md`
- `process/skills-and-tooling.md`

The following project rules are therefore non-negotiable:

1. **Integrate before authoring.** Do not build a VPN orchestrator, crypto format, authentication system, table library, updater, QR generator, or other commodity subsystem from scratch when a maintained implementation exists.
2. **Never invent cryptography, authentication, token signing, password hashing, or session formats.** Use established platform/library primitives.
3. **Every implementation increment is a closed vertical slice:** database → API → UI → audit → tests → deploy verification.
4. **Version the API from day one** under `/api/v1/*`.
5. **Every state-changing administrative action is audited.**
6. **Authorization is enforced server-side on every request.** Hiding a UI control is not authorization.
7. **The Super Admin UI is an operational console.** It MUST optimize for dense repeated work, not marketing-page aesthetics.
8. **Do not poll fleet state aggressively.** Prefer push/realtime state and batched screen loaders.
9. **A passing build is not proof.** Production-relevant behavior must be tested against real deployed components and real Windows endpoints.
10. **Do not install skills, hooks, or coding extensions unsighted.** Follow the skills/tooling review guidance.

---

# 2. Product Vision

CloudBox is a managed SaaS product that converts a customer-owned or provider-supplied Windows PC into a centrally managed remote-work appliance.

A CloudBox should feel like an appliance rather than a manually maintained Windows computer.

The customer experience should become:

```text
Purchase / activate subscription
        ↓
Install CloudBox Setup
        ↓
Sign in or enter one-time enrollment code
        ↓
Device enrolls into tenant
        ↓
Agent + private network + remote access + backups configure automatically
        ↓
Users sign in through CloudBox Connect using Tenant ID + Client ID + password
        ↓
Authorized CloudBox appears
        ↓
Connect
```

The CloudBox provider operations experience should become:

```text
Super Admin
   ↓
Tenants
Fleet
Licenses / subscriptions
Users
Sessions
Backups
Updates
Maintenance
Network
Break-glass support
Audit
```

The product MUST remain useful during temporary Internet loss. Cloud connectivity improves manageability, but an Internet outage must not immediately stop an otherwise valid licensed CloudBox.

---

# 3. Core Product Principles

## 3.1 SaaS account, not reusable product keys

A traditional reusable product key MUST NOT be the primary source of licensing authority.

CloudBox is a SaaS product. Commercial entitlement lives in the cloud account and is represented locally by a device-bound offline lease.

Users and administrators authenticate to the SaaS using **email + OTP**.

A string that looks like a product key may exist only as one of the following:

- a single-use device enrollment code,
- a short-lived recovery code,
- a human-friendly reference to a subscription,
- an offline rescue entitlement generated by Super Admin for one specific machine.

No reusable universal key may independently unlock CloudBox on arbitrary machines.

## 3.2 Device-bound licensing

A valid subscription for Device A MUST NOT be usable on Device B by copying:

- license files,
- registry values,
- installation folders,
- configuration directories,
- encrypted state,
- a human-readable license string.

The local entitlement MUST be cryptographically bound to a device key whose private material is non-exportable where supported.

## 3.3 Offline-first validation

A CloudBox with a valid local lease MUST be able to start and validate its licensed state without reaching CloudBox Cloud.

Temporary loss of Internet or Cloudflare MUST NOT immediately interrupt valid remote work.

## 3.4 Fail safely, not destructively

Expiration, tamper suspicion, revocation, or agent failure MUST NEVER:

- delete business application data,
- encrypt customer data as leverage,
- delete Windows users,
- damage business application installation,
- intentionally corrupt backups.

License enforcement may disable the CloudBox managed remote-access service while preserving local console access and customer data.

## 3.5 Supportability over cleverness

Every automated action needs:

- clear state,
- logs,
- health result,
- audit trail where appropriate,
- rollback/recovery path,
- a support-visible reason when blocked.

---

# 4. Major System Components

The solution consists of six major surfaces.

## 4.1 CloudBox Cloud SaaS

Hosted primarily on Cloudflare.

Responsibilities:

- authentication,
- tenant management,
- subscriptions and entitlements,
- device enrollment,
- license issuance,
- fleet state,
- command queue,
- audit logs,
- update channel management,
- backup metadata,
- alerts,
- support workflows,
- break-glass authorization,
- Netmaker/WireGuard control integration.

## 4.2 CloudBox Setup

`CloudBox.Setup.exe`

One-time/bootstrap configuration application.

Responsibilities:

- prerequisite detection,
- CloudBox Agent installation,
- CloudBox Status application installation,
- RDP prerequisites,
- managed-user setup,
- application data/backup folders,
- NTFS permissions,
- private-network client installation,
- enrollment,
- first health check,
- service recovery configuration,
- uninstall/repair entry point.

The Setup application MUST become smaller over time. Long-lived management belongs to Agent.

## 4.3 CloudBox Agent

`CloudBox.Agent.exe`

Installed as a Windows service under LocalSystem unless a narrower service identity proves sufficient.

Responsibilities:

- device identity,
- local license verification,
- expiry enforcement,
- tamper checks,
- managed-user reconciliation,
- session visibility,
- RDP service health,
- private-network health,
- backup orchestration,
- update installation,
- reboot scheduling,
- diagnostics,
- command execution,
- health reporting,
- cloud connection,
- local API/named-pipe service for Status application.

## 4.4 CloudBox Status

`CloudBox.Status.exe`

Interactive per-machine UI launched at Windows sign-in for the parent/console account.

Responsibilities:

- appliance status,
- license status,
- user-slot status,
- active RDP sessions,
- network status,
- backup status,
- reboot/update status,
- renewal warning,
- QR renewal link,
- support code,
- local diagnostics display.

It MUST NOT contain privileged enforcement logic.

## 4.5 CloudBox Connect

Windows client application for end users.

Responsibilities:

- parent-tenant login using Tenant ID + Client ID + password,
- optional OTP step-up for new-device enrollment, password reset, or tenant policy,
- tenant resolution and authorization,
- authorized-device discovery,
- private-network enrollment/session,
- connection health,
- launch RDP to an authorized CloudBox,
- display clear errors for expired tenant/device/user access.

The target experience is one button:

```text
CloudBox CONNECT

CloudBox Main CloudBox
● Online
3 / 6 sessions active

[ CONNECT ]
```

The user should not need to understand WireGuard, RDP addresses, VPN configs, or device IPs.

## 4.6 Private Network Control Plane

Use an established open-source WireGuard orchestration solution rather than creating a new one.

Selected baseline: self-hosted Netmaker Community Edition + Netclient. Netmaker is infrastructure plumbing only and MUST NOT be exposed as the customer-facing product.

Responsibilities:

- WireGuard peer provisioning,
- peer discovery,
- peer endpoint discovery and UDP hole punching,
- remote-access/gateway fallback where required,
- peer addressing,
- access policies,
- network revocation,
- API integration.

The SaaS remains the product authority; the VPN controller is infrastructure plumbing.


## 4.7 Product Packaging and Hidden Infrastructure Components

The commercial product has exactly two customer-facing Windows installers:

```text
CloudBox.Server.Setup.exe
CloudBox.Connect.Setup.exe
```

Customers MUST NOT be required to separately download, configure, open, or understand RDP Wrapper, TermWrap, Netmaker, Netclient, WireGuard, Wintun, enrollment tokens, network ACLs, or RDP listener configuration.

### Server installer

`CloudBox.Server.Setup.exe` installs and manages, as one product:

- CloudBox Agent Windows service,
- CloudBox Status application,
- RDP Wrapper/TermWrap remote-session runtime,
- Netclient/WireGuard private-network runtime,
- CloudBox backup worker,
- OTA/update worker,
- health and recovery tasks,
- firewall policy,
- managed Windows accounts,
- device identity and license state.

The Setup application MUST perform all third-party installation/configuration silently or through CloudBox-owned UI. No upstream configuration UI is part of the normal customer path.

### Client installer

`CloudBox.Connect.Setup.exe` installs:

- CloudBox Connect UI,
- a CloudBox-managed background network component using Netclient/WireGuard,
- secure local credential/session storage,
- updater,
- diagnostics required by support.

The end user sees only CloudBox Connect. Netclient/WireGuard are implementation details.

### Third-party attribution

Invisible implementation does not mean invisible licensing obligations. The installers MUST ship an accessible **Third-Party Notices** document containing all notices required by the bundled dependencies. Upstream names MUST NOT be used to imply endorsement of CloudBox.

The project has received direct permission from **Sergiy Egoshyn**, creator of the selected RDP Wrapper project, for commercial use in this project. Evidence of that permission MUST be retained in the private project legal records and referenced from the release checklist. Before commercial release, engineering MUST separately inventory licenses/permissions for every third-party binary bundled by or alongside RDP Wrapper, including TermWrap and its dependencies; creator permission for one project MUST NOT be assumed to automatically relicense unrelated upstream components.

## 4.8 Selected Private Network Stack: Netmaker CE

NetBird is not the selected baseline because its current repository mixes BSD-3-Clause code with AGPL-licensed management, signal, relay, and combined server components. This does not make NetBird unusable, but it adds licensing obligations that are unnecessary for this product when a permissively licensed alternative fits the requirement.

The selected baseline is:

```text
Netmaker Community Edition control plane
        +
Netclient on Windows
        +
WireGuard/Wintun data plane
        +
CloudBox SaaS as the only customer-facing control plane
```

Netmaker's open-source code outside its `pro/` area is Apache-2.0 and the separate Netclient repository is Apache-2.0. The project MUST NOT depend on Netmaker Enterprise/MSP-only multi-tenancy features. Instead, CloudBox SaaS owns tenancy and maps each CloudBox tenant to isolated Netmaker network resources.

### Tenant network model

Default topology:

```text
Tenant A
  └─ network: tbx-tenant-a
      ├─ CloudBox Server A1
      ├─ authorized Connect clients
      └─ CloudBox Provider Support peer

Tenant B
  └─ network: tbx-tenant-b
      ├─ CloudBox Server B1
      ├─ authorized Connect clients
      └─ CloudBox Provider Support peer
```

Customer peers MUST NOT be able to route to another tenant's network.

A CloudBox provider-support identity/node MUST be provisionable in every tenant network so the provider can reach the appliance when support is required. Persistent network reachability does **not** automatically grant Windows administrator access: privileged RDP uses the separate audited break-glass workflow defined later in this document.

Netmaker administrative credentials, enrollment keys, WireGuard private keys, and network names are never shown to tenants or Connect users.

### Network control ownership

Cloudflare Workers/D1 remain the business source of truth for:

- tenant ownership,
- client identities,
- device authorization,
- subscription state,
- licensed slots,
- break-glass permission,
- desired network membership.

A dedicated network-controller integration service translates this desired state into Netmaker API operations. Netmaker is not authoritative for commercial identity or billing.


---

# 5. Cloud Architecture

## 5.1 Recommended stack

| Capability | Baseline |
|---|---|
| Frontend | React + Vite |
| UI foundation | shadcn/ui + Radix |
| Styling | Tailwind + CSS variables |
| Icons | Lucide only |
| Tables | TanStack Table |
| Data fetching | TanStack Query |
| Forms | React Hook Form + Zod |
| API | Cloudflare Worker + Hono |
| Database | Cloudflare D1 |
| ORM | Drizzle |
| Realtime fleet state | Durable Objects + WebSockets |
| File/object storage | R2 |
| Administration authentication | Better Auth or equivalent maintained library supporting email OTP |
| CloudBox Connect authentication | Tenant ID + Client ID + password; optional OTP step-up |
| Email | provider adapter, e.g. transactional mail provider selected at implementation time |
| VPN orchestration | self-hosted Netmaker CE + embedded Netclient/WireGuard runtime |
| Windows components | .NET |

The exact packages MUST be revalidated for active maintenance before implementation.

## 5.2 API namespace

Versioned APIs:

```text
/api/v1/*
```

Unversioned infrastructure endpoints:

```text
/api/health
/api/version
```

All API responses SHOULD carry:

```text
X-API-Version: v1
```

## 5.3 Realtime model

Fleet dashboards MUST NOT rely on aggressive polling.

Preferred flow:

```text
Agent
  ↕ authenticated WebSocket
Device Durable Object
  ↕ realtime updates
Super Admin / Tenant Portal
```

D1 stores durable business state and meaningful events.

Durable Objects maintain ephemeral/presence state such as:

- online/offline,
- active sessions,
- update progress,
- command acknowledgement,
- current health summary.

## 5.4 Database query discipline

Each operational screen SHOULD load through one screen-level endpoint rather than many independent panel endpoints.

Screen loaders SHOULD have an enforced query-roundtrip ceiling.

Never perform N+1 queries for fleet rows.

---

# 6. SaaS Authentication

## 6.1 Login method

Initial authentication method:

**Email + one-time password (OTP).**

No customer password is required in V1.

Flow:

```text
Enter email
   ↓
Send OTP
   ↓
Enter/paste OTP
   ↓
Verify
   ↓
Create normal SaaS session
```

Requirements:

- OTP tokens are single-use.
- OTPs expire quickly.
- OTP send is rate-limited per email, IP, account and device risk context.
- OTP UI supports paste/autofill.
- Resend invalidates or logically supersedes prior OTPs as defined by the chosen auth library.
- OTP delivery state is instrumented separately from API response success.
- Do not expose whether an arbitrary email account exists.
- Auth cookies remain host-only unless a specifically designed cross-host flow requires otherwise.

## 6.2 Super Admin step-up

High-consequence actions require a fresh OTP challenge even when a Super Admin already has a valid session.

Examples:

- break-glass RDP,
- license revocation,
- tenant deletion/archive,
- device ownership transfer,
- emergency license issuance,
- OTA release promotion to all devices,
- disabling security controls.

## 6.3 SaaS memberships

A person may belong to one or more tenants.

Membership records are separate from identity.

Example:

```text
user@example.com
  ├── Tenant A: Admin
  └── Tenant B: User
```

Authorization MUST resolve the active tenant and membership on every protected request.

---

# 7. Roles and Authorization

Internal staff roles should remain few and fixed.

Initial roles:

- Super Admin
- Admin
- Support
- Read Only

Customer-side membership levels:

- Tenant Owner
- Tenant Admin
- User

Permissions remain server-enforced capabilities/permission keys.

Representative permissions:

```text
tenant.view
tenant.manage
subscription.view
subscription.manage
device.view
device.manage
device.command
device.break_glass
license.issue
license.renew
license.revoke
network.view
network.manage
backup.view
backup.restore
update.view
update.release
update.deploy
audit.view
```

Super Admin SHOULD NOT be implemented as “bypass all authorization checks.” It should possess explicit permissions through the same authorization layer so missing permission data cannot create a silent second security model.

---

# 8. Tenant Model

A tenant represents one customer organization.

Required tenant properties:

- tenant ID,
- legal/display name,
- status,
- primary contact,
- support contacts,
- billing contact,
- timezone,
- maintenance window,
- default renewal warning days,
- default backup policy,
- subscription plan,
- notes,
- created/updated timestamps.

Tenant status:

```text
trial / provisioning / active / past_due / suspended / cancelled / archived
```

A tenant MAY have multiple CloudBoxes.

---

# 9. Subscription and Entitlement Model

## 9.1 Subscription is the commercial source of truth

The cloud subscription determines commercial rights.

Example:

```text
Plan: CloudBox 6
Devices: 1
Managed remote users: 6
Backup: Enabled
Fleet management: Enabled
Support: Standard
Valid through: 2027-09-23
```

## 9.2 No universal reusable product key

Never issue a key that can be copied to a second machine and unlock the product independently.

Use single-use enrollment tokens for initial device binding.

Example:

```text
TBX-ENROLL-4W7K-29HF
```

Properties:

- random,
- short-lived,
- one-time,
- tenant-bound,
- optionally pre-bound to an order/device record,
- stored server-side as a hash where practical,
- invalidated after successful enrollment.

## 9.3 Machine-bound offline license lease

After enrollment, Cloud issues an encrypted and signed offline entitlement specifically for that device.

Conceptual claims:

```json
{
  "license_id": "lic_...",
  "tenant_id": "ten_...",
  "device_id": "dev_...",
  "device_key_thumbprint": "...",
  "max_managed_users": 6,
  "valid_from": "...",
  "valid_until": "...",
  "renewal_warning_days": 30,
  "offline_grace_days": 7,
  "generation": 12,
  "features": ["remote_access", "managed_backup", "fleet"]
}
```

The human-readable license blob must reveal none of these fields directly.

## 9.4 Cryptographic model

Do NOT design proprietary crypto.

Use established JOSE / platform primitives.

Preferred conceptual construction:

```text
entitlement claims
   ↓
server signature
   ↓
signed token
   ↓
encrypt to device public key
   ↓
opaque device license
```

The server signing private key MUST be held as a protected secret and rotated through an explicit key-rotation procedure.

The device private key SHOULD be generated as non-exportable in the TPM using Windows CNG / Microsoft Platform Crypto Provider where available.

The cloud stores only the corresponding public key and metadata.

## 9.5 TPM requirement

Production-grade CloudBox SHOULD require TPM 2.0 for strongest machine binding.

If TPM is unavailable, the system MAY support a degraded device-bound key protected by Windows cryptographic storage/DPAPI, but the Super Admin UI MUST visibly mark the device:

```text
Hardware key protection: DEGRADED
```

CloudBox may choose to disallow degraded enrollment for commercial deployments.

## 9.6 Copy protection

Copying the following to another PC MUST not create a valid license:

- license file,
- ProgramData folder,
- registry keys,
- executable directory,
- cloned OS disk where TPM binding changes,
- user-visible license identifier.

The target machine cannot decrypt/use a lease encrypted to the original device key.

## 9.7 Device replacement

Hardware replacement requires an explicit cloud-side device transfer workflow.

Flow:

```text
Super Admin / authorized Tenant Admin
       ↓
select Replace Device
       ↓
re-auth with OTP
       ↓
new enrollment token
       ↓
new device identity registered
       ↓
old device revoked
       ↓
new device receives fresh entitlement
```

The old license must not magically become portable.

---

# 10. Offline License Validation

## 10.1 Boot-time gate

Remote access is unavailable until Agent has validated the local entitlement.

Conceptual startup:

```text
Windows boot
   ↓
CloudBox Agent starts
   ↓
validate local encrypted lease
   ↓
validate device binding
   ↓
validate local trusted time
   ↓
validate managed-user count
   ↓
VALID → allow managed remote access
INVALID → keep managed remote access blocked
```

## 10.2 No-Internet behavior

If Cloud cannot be reached but the cached lease is still valid:

```text
License: Valid (offline)
Cloud: Offline
Remote access: Allowed
```

The Status UI must clearly show that validation is using cached entitlement.

## 10.3 Expired offline behavior

When the trusted local time passes the valid entitlement period and the configured grace policy:

```text
License: Expired
Remote access: Blocked
Local Windows console: Available
business application data: Untouched
Backups: Preserved
```

## 10.4 Offline grace

Offline grace is a policy value set from Super Admin.

Example:

```text
valid_until: 2027-09-23
normal offline grace: 7 days
```

The exact grace behavior may differ by plan.

Grace is intended for transient connectivity failures, not permanent offline operation after subscription expiry.

---

# 11. Clock and Rollback Tamper Protection

Offline expiry enforcement is meaningless if the local clock can simply be moved backwards.

The Agent MUST maintain a protected trusted-time state.

Inputs:

- last cryptographically authenticated server time,
- highest previously observed local wall clock,
- monotonic runtime clock while Agent is running,
- boot/session timing information,
- entitlement issuance and generation metadata.

The Agent maintains a high-water mark such as:

```text
highest_trusted_time = 2027-09-28T14:37:00Z
```

If the next boot reports a materially earlier time:

```text
2027-08-01
```

Agent enters a tamper state.

Required states:

```text
HEALTHY
CLOCK_ROLLBACK_SUSPECTED
LICENSE_STATE_ROLLBACK_SUSPECTED
DEVICE_BINDING_FAILED
LICENSE_SIGNATURE_FAILED
LICENSE_EXPIRED
```

Tamper behavior:

- block managed remote access,
- keep data intact,
- show clear local status,
- record local event,
- sync tamper event to cloud when connectivity returns,
- require online revalidation or authorized recovery entitlement.

No implementation should claim perfect resistance against an adversary with full local administrator control. The product goal is robust tamper resistance, not impossible guarantees.

---

# 12. Local Secure State

Default root:

```text
C:\ProgramData\CloudBox\CloudBox\
```

Sensitive state SHOULD be protected with:

- machine DPAPI where appropriate,
- TPM-backed device identity,
- SYSTEM/Administrators ACLs,
- integrity signatures/MACs provided by established crypto libraries,
- generation counters,
- redundant consistency markers where justified.

Do not store plaintext fields such as:

```text
expiry=2027-09-23
max_users=6
```

as the authority for enforcement.

Human-readable diagnostics may display derived values, but changing them must not alter entitlement.

---

# 13. CloudBox Status Window

The Status application launches for the local parent/console account.

Primary screen:

```text
CloudBox CLOUDBOX                            ● ONLINE
------------------------------------------------------
CLOUDBOX-00017
Tenant: CloudBox

License
Active
287 days remaining

Users
Configured: 6 / 6
Active sessions: 3

Private Network
Connected
10.x.x.x

Remote Access
Healthy

Backup
Last successful: 42 min ago
Next scheduled: 10:00 PM

Agent
v1.8.2 • Current

[ View Users ] [ Diagnostics ] [ Support ]
```

When near expiry:

```text
License expires in 21 days

[ QR CODE ]
Scan to renew
```

Displayed renewal warning threshold comes from entitlement/cloud policy.

Status UI MUST distinguish:

- licensed/configured user slots,
- active Windows sessions,
- SaaS members.

These are not the same concepts.

---

# 14. Managed User Model

A CloudBox may have a purchased limit such as six managed remote Windows users.

Example:

```text
cloud01
cloud02
cloud03
cloud04
cloud05
cloud06
```

Agent tracks authorized managed Windows accounts.

An extra unmanaged/local account does not automatically become a licensed remote account.

If configured managed users exceed entitlement:

- do not delete users,
- mark excess managed users suspended for CloudBox remote access,
- identify the reason in local and cloud UI.

## 14.1 Parent user

The parent/console user remains the local maintenance/admin account and is not counted as a normal managed remote-user slot.

It exists for:

- setup,
- local repair,
- emergency console access,
- updates,
- diagnostics,
- recovery.

Normal customer work should occur under managed remote accounts.


## 14.2 End-user identity is not a raw Windows account

Daily Connect authentication uses:

```text
Tenant ID + Client ID + Password
```

Example:

```text
Tenant ID: PCI-00481
Client ID: accounts03
Password: ************
```

The SaaS resolves the parent tenant first, then validates the client identity inside that tenant. A valid Client ID in Tenant A has no authority in Tenant B.

The SaaS identity maps to one or more authorized CloudBoxes and to a managed Windows/RDP identity. The user MUST NOT need to know the Windows machine name, local account name, WireGuard address, Netmaker network name, or RDP endpoint.

RDP credentials SHOULD be brokered internally by CloudBox Connect/Agent rather than exposed as the user's SaaS password. The detailed credential-broker design MUST use Windows-supported credential APIs and encrypted device-bound storage; credentials MUST NOT be placed in URLs, logs, plaintext config files, or process command lines.


---

# 15. Private Network

## 15.1 Principle

RDP MUST not be exposed directly to the public Internet.

No default public 3389 port-forwarding.

Remote access traverses a private WireGuard-based overlay.

## 15.2 Control architecture

Use self-hosted Netmaker Community Edition as the selected WireGuard orchestration layer.

CloudBox SaaS maps its own concepts to VPN infrastructure:

```text
Tenant
Device
User
Policy
```

Do not expose raw Netmaker administration, network names, enrollment keys, WireGuard keys, or Netclient controls to customers.

## 15.3 Isolation and provider-support reachability

A tenant's normal users may reach only devices they are authorized to use.

Customer A must not route to Customer B.

Each tenant network MUST include or permit an infrastructure-level CloudBox provider-support peer/group. This ensures the provider can reach every managed network for diagnostics and recovery. Network reachability alone is not sufficient to enter a privileged Windows session. Emergency administrator RDP remains disabled/gated until the break-glass workflow grants it, and every activation is time-bounded and audited.

## 15.4 Client login

CloudBox Connect authenticates the human to a parent tenant using Tenant ID + Client ID + password. After authorization, the SaaS grants short-lived network/device access and the client launches RDP without exposing the underlying network or RDP plumbing.

Users should never manually exchange permanent WireGuard configuration files.

---

# 16. Fleet Management

Super Admin Fleet view is the central operational console.

Each device row should include:

- tenant,
- device name,
- online/offline,
- last seen,
- private-network IP,
- Windows version/build,
- Agent version,
- remote-access health,
- configured users / licensed slots,
- active sessions,
- license state,
- license days remaining,
- backup state,
- last successful backup,
- disk health/free space,
- pending update,
- pending reboot,
- security/tamper state.

Fleet filters:

- offline,
- expiring soon,
- backup failed,
- update pending,
- reboot pending,
- tamper warning,
- degraded device-key protection,
- active sessions,
- tenant,
- Agent version,
- Windows build.

Fleet bulk actions must be carefully capability-gated.

Examples:

- schedule Agent update,
- schedule reboot,
- run health check,
- request backup,
- refresh entitlement.

Destructive or broad actions require explicit confirmation and may require OTP step-up.

---

# 17. Device Detail Screen

Tabs or sections:

```text
Overview
Users
Sessions
Network
License
Backups
Updates
Maintenance
Diagnostics
Events
Break Glass
```

## 17.1 Overview

Current appliance health summary.

## 17.2 Users

Configured managed remote users, slot allocation, status, last sign-in.

## 17.3 Sessions

Current/known Windows RDP sessions with:

- username,
- session ID,
- state,
- idle time,
- start time.

Permitted actions:

- disconnect session,
- log off session only with explicit confirmation.

## 17.4 Network

Overlay status, private address, controller reachability, peer state.

## 17.5 License

Subscription/lease status, expiry, generation, last cloud refresh, device-binding health.

## 17.6 Backups

Backup history, retention, verification, restore points.

## 17.7 Updates

Agent/app versions, available release, channel, rollout status, rollback state.

## 17.8 Maintenance

Reboot window, maintenance mode, wake capabilities.

## 17.9 Diagnostics

Curated logs and support bundles, not arbitrary remote shell by default.

---

# 18. OTA / Automatic Updates

## 18.1 Components subject to OTA

At minimum:

- CloudBox Agent,
- CloudBox Status,
- CloudBox Connect,
- CloudBox Setup repair components where appropriate,
- support scripts/configurations,
- private-network client when managed by CloudBox,
- remote-session compatibility components only through separately validated release procedures.

the managed business application itself should only be updated through an explicit application-specific update policy. Do not silently update accounting software merely because the Agent can.

## 18.2 Release channels

Support:

```text
Development
Pilot
Stable
Pinned
```

Example rollout:

```text
Internal lab
   ↓
Pilot 5 devices
   ↓
Pilot 5% fleet
   ↓
25%
   ↓
100% stable
```

## 18.3 Package security

Every OTA package MUST have:

- code signature where platform permits,
- cryptographic hash,
- signed release manifest,
- version,
- minimum compatible Agent version,
- rollback metadata.

Agent verifies package integrity before execution.

## 18.4 Update flow

```text
Cloud assigns release
        ↓
Agent downloads into staging
        ↓
verify signature/hash
        ↓
check maintenance conditions
        ↓
install
        ↓
restart component / reboot if required
        ↓
post-update health verification
        ↓
mark success OR rollback
```

## 18.5 Update safety

Never update during active accounting work if the update requires service interruption unless an authorized emergency override exists.

Agent checks:

- active RDP sessions,
- backup activity,
- reboot requirements,
- maintenance window.

## 18.6 Rollback

The previous known-good Agent package must remain available until the new version has passed post-update health checks.

A failed update MUST produce:

- local log,
- cloud event,
- rollback attempt,
- fleet alert.

## 18.7 Forced updates

Forced security updates are allowed only through a dedicated capability and reason.

Even a forced update should use a short warning period where technically possible.

---

# 19. Scheduled Reboots and Maintenance Windows

Each tenant/device can define a maintenance window.

Example:

```text
Sunday 02:00–04:00 local tenant time
```

Reboot policy fields:

- automatic_reboot_enabled,
- preferred_day,
- preferred_time,
- max_deferral_days,
- active_session_behavior,
- warning_minutes.

Normal flow:

```text
Reboot required
   ↓
wait for maintenance window
   ↓
check active sessions
   ↓
notify users
   ↓
if idle / approved → reboot
   ↓
Agent starts
   ↓
license validation
   ↓
network validation
   ↓
RDP health validation
   ↓
backup-path validation
   ↓
cloud marks device healthy
```

Default active-session behavior should be **defer**, not force-logoff.

Super Admin may choose an emergency forced reboot after OTP step-up and explicit reason.

All remotely requested reboots are audited.

---

# 20. Wake-on-LAN and Remote Power

Wake-on-LAN is conditional.

A powered-off CloudBox cannot receive a cloud command through its own Agent.

Therefore remote wake requires at least one of:

1. another always-on CloudBox Site Relay on the same LAN,
2. supported router/firewall integration capable of sending a local magic packet,
3. hardware out-of-band management such as Intel AMT where explicitly supported,
4. BIOS/UEFI RTC scheduled wake for deterministic schedules.

## 20.1 WOL capability detection

Agent should report:

```text
Wake-on-LAN capable: Yes/No/Unknown
NIC configured: Yes/No
Site Relay available: Yes/No
Remote wake: Available/Unavailable
```

Do not show a clickable Wake button if no path exists to deliver a packet on the local network.

## 20.2 Site Relay

Optional CloudBox Site Relay can be a lightweight service installed on another always-on Windows/Linux device at that customer site.

It may receive an authenticated cloud command and send a LAN-only magic packet to the CloudBox.

The relay must not become a general-purpose remote shell.

---

# 21. Super Admin Emergency RDP / Break-Glass Access

CloudBox requires emergency support access, but permanent invisible vendor access is unacceptable.

Break-glass access MUST be explicit, temporary, visible, and audited.

## 21.1 Default state

Provider support access is **disabled by default**.

There is no permanent universal RDP credential shared across the fleet.

## 21.2 Break-glass request

Super Admin selects:

```text
Device → Break Glass → Request Emergency Access
```

Required inputs:

- support reason,
- ticket/reference,
- requested duration,
- optional note.

Super Admin must complete a fresh email OTP step-up.

## 21.3 Temporary support identity

Preferred approach:

- Agent creates/enables a dedicated temporary support Windows identity or activates a pre-created disabled support account,
- generates a strong random temporary credential or uses a certificate/passwordless flow where feasible,
- grants Remote Desktop Users membership only for the duration,
- network policy temporarily allows the authorized Super Admin support device to reach the CloudBox,
- expiry is enforced locally by Agent even if cloud connectivity later disappears.

Maximum default window:

```text
30–60 minutes
```

Configurable by Super Admin policy within a bounded range.

## 21.4 Visibility

When break-glass access is active, Status application MUST show:

```text
CLOUDBOX SUPPORT ACCESS ACTIVE
Expires in 34 minutes
Reason: Ticket #...
```

Tenant portal SHOULD also show active support access.

## 21.5 Automatic teardown

At expiry Agent MUST:

- terminate/disable temporary support access,
- remove temporary Remote Desktop membership where applicable,
- close temporary network policy,
- invalidate temporary credential,
- record completion.

## 21.6 Audit

Audit at least:

```text
BREAK_GLASS_REQUESTED
BREAK_GLASS_APPROVED
BREAK_GLASS_NETWORK_OPENED
BREAK_GLASS_SESSION_STARTED
BREAK_GLASS_SESSION_ENDED
BREAK_GLASS_EXPIRED
BREAK_GLASS_REVOKED
```

## 21.7 Offline emergency recovery

If the device has lost Internet but remains locally reachable by authorized staff, Super Admin may generate a short-lived **offline rescue entitlement**.

It must be:

- machine-bound,
- signed,
- non-reusable on other devices,
- limited in duration,
- limited in capability,
- auditable when later synchronized.

Example:

```text
Device: CLOUDBOX-00017
Purpose: support remote-access recovery
Valid: 2 hours
Nonce: unique
```

This is not a universal master key.

---

# 22. Command and Remote-Action Model

The Agent MUST NOT expose an unrestricted arbitrary shell through the SaaS in the initial product.

Cloud commands are an allow-listed schema.

Examples:

```text
RUN_HEALTH_CHECK
REFRESH_LICENSE
RUN_BACKUP
VERIFY_BACKUP
SCHEDULE_REBOOT
RESTART_TERM_SERVICE
RESTART_NETWORK_AGENT
DISCONNECT_SESSION
LOGOFF_SESSION
INSTALL_RELEASE
COLLECT_DIAGNOSTICS
ENABLE_BREAK_GLASS
DISABLE_BREAK_GLASS
```

Every command contains:

- command ID,
- device ID,
- type,
- structured parameters,
- requested by,
- created time,
- expiry,
- authorization context,
- integrity/authentication metadata.

Agent validates command type and parameters locally.

Commands are idempotent where possible.

---

# 23. business application Backup Strategy

Backups are a first-class product feature, not an afterthought.

## 23.1 Backup goals

The backup system must protect against:

- user deletion,
- accidental overwrite,
- business application data corruption,
- local disk failure,
- ransomware on the primary disk,
- failed Windows update,
- machine loss/theft,
- operator error.

## 23.2 Do not rely on live folder synchronization

The live business application data directory MUST NOT be treated as safely backed up merely because it is synchronized to Google Drive, OneDrive, Dropbox, or another file-sync client.

A live application data folder can contain changing/open files.

Backups should use a application-supported/application-consistent backup mechanism wherever available.

Where a filesystem-level snapshot/copy is required, it must occur through a documented application-consistent procedure or maintenance/quiesce process.

## 23.3 3-2-1 baseline

Minimum target:

```text
1. Live business application data on primary local storage
2. Local backup on separate physical storage where available
3. Encrypted offsite backup
```

The local backup destination should not be the same physical disk as live data if avoidable.

## 23.4 Recommended paths

Example:

```text
Live:
D:\CloudBoxData

Local backup:
E:\CloudBoxBackup
```

Fallback to system disk is permitted for bench/testing but should be flagged as degraded production protection.

## 23.5 Backup layers

### Layer A: frequent local recovery points

Purpose: fast restore from accidental changes or recent corruption.

Suggested policy baseline:

- frequent scheduled backup during business hours where application-consistent operation is supported,
- backup after important administrative operations,
- backup before business application upgrades,
- backup before major Windows/Agent maintenance if risk warrants it.

### Layer B: nightly protected local backup

Nightly complete logical/application backup to separate local storage.

### Layer C: encrypted offsite copy

Upload completed backup artifacts to cloud object storage only **after** local backup completion and integrity verification.

Never stream the live business application data directory directly as the offsite backup.

## 23.6 Offsite storage

R2 can store encrypted backup objects and manifests.

Each backup artifact MUST have:

- tenant ID,
- device ID,
- backup ID,
- source dataset/company identifiers where permitted,
- created timestamp,
- agent version,
- business application version if discoverable,
- size,
- cryptographic hash,
- encryption metadata,
- verification status,
- upload status.

Sensitive backup payloads SHOULD be encrypted client-side before upload using established encryption libraries/platform cryptography.

Encryption keys require explicit lifecycle design and recovery procedures; do not create bespoke crypto.

## 23.7 Retention policy

Default policy should be configurable by plan/tenant.

A reasonable initial template:

```text
Recent restore points: 24–48 hours as appropriate
Daily: 30 days
Weekly: 12 weeks
Monthly: 12 months
Yearly: optional
```

Exact cadence must be validated against storage costs and business application backup size.

Retention deletion is a controlled server-side operation and must be audited.

## 23.8 Backup success is not upload success

Track separate states:

```text
Backup created
Backup verified locally
Cloud upload started
Cloud upload completed
Cloud object verified
Retention applied
```

Do not mark a backup “healthy” merely because a ZIP/file exists.

## 23.9 Restore testing

A backup that has never been restored is unproven.

Requirements:

- support operator-driven restore verification,
- periodic restore drills on non-production/test environment where feasible,
- store `last_restore_test_at`,
- flag fleets/tenants with no recent verification.

## 23.10 Restore workflow

Restore is high consequence.

Required flow:

```text
Select restore point
   ↓
show exact backup metadata
   ↓
warn about current data replacement
   ↓
fresh OTP step-up for privileged operator
   ↓
create safety backup of current state first
   ↓
perform restore
   ↓
validate data path / business application visibility
   ↓
audit before/after
```

Never overwrite live data without first preserving the current state unless storage failure makes that impossible.

## 23.11 Backup alerts

Alert when:

- no successful backup within expected window,
- local backup disk missing,
- local backup disk low on space,
- cloud upload repeatedly fails,
- hash verification fails,
- restore verification overdue,
- backup job duration changes abnormally.

---

# 24. Storage and Disk Health

Agent reports:

- total/free bytes,
- backup-disk availability,
- live-data path availability,
- disk health where reliably obtainable,
- SMART warning where supported,
- growth trend.

Default alerts:

- warning below 20% free,
- critical below 10% free,
- configurable absolute minimum.

The Agent MUST avoid filling the OS disk with unbounded logs or backup staging files.

---

# 25. Alerts and Notifications

Initial channels:

- Super Admin console,
- tenant console,
- email.

Later optional channels may include SMS/WhatsApp integrations if commercially justified.

Alert categories:

```text
Device Offline
License Expiring
License Expired
Clock Tamper
Device Binding Failure
Backup Failed
Backup Overdue
Disk Low
Agent Outdated
Update Failed
Reboot Required
Private Network Failed
RDP Unhealthy
Break Glass Active
```

Alerts need deduplication and stateful recovery events.

Do not email every heartbeat failure independently.

---

# 26. Super Admin Console Information Architecture

This is an operational console with high information density.

Primary navigation:

```text
Overview
Tenants
Fleet
Subscriptions
Licenses
Users
Backups
Updates
Network
Alerts
Support
Audit
Settings
```

## 26.1 Overview

Real metrics only:

- active tenants,
- total managed devices,
- online/offline devices,
- expiring subscriptions,
- backup health,
- update compliance,
- current alerts,
- current break-glass sessions.

Never invent vanity metrics.

## 26.2 Tenants

Dense searchable table, filters, status, plan, device count, next expiry, health.

## 26.3 Fleet

Operational table, not card grid.

## 26.4 Subscriptions / Licenses

Plan, device entitlement, users, dates, generations, status, renew/revoke actions.

## 26.5 Backups

Cross-fleet backup exceptions first.

## 26.6 Updates

Release channels, rollout percentages, failures, rollback.

## 26.7 Network

Overlay controller health and device peer state.

## 26.8 Support

Current tickets/reasons, diagnostics, break-glass access.

## 26.9 Audit

Append-only administrative history.

---

# 27. Tenant Portal

Tenant users authenticate with the same email OTP system.

Tenant portal should expose only tenant-scoped data.

Suggested navigation:

```text
Home
CloudBoxes
Users
Sessions
Backups
Subscription
Maintenance
Support
Audit
```

Tenant Admin capabilities may include:

- invite/revoke users,
- view devices,
- view sessions,
- request backup,
- request reboot within policy,
- manage maintenance window,
- view subscription,
- initiate renewal,
- request support.

Break-glass provider access should be visible in tenant history even when tenant approval is not required by the commercial support policy.

---

# 28. CloudBox Connect Requirements

## 28.1 Authentication

Tenant ID + Client ID + password. Email/OTP MAY be required for first-device enrollment, password reset, high-risk sign-in, or a tenant-configured second factor.

The Connect identity is a SaaS identity and MUST NOT be implemented as a direct Windows account credential. It maps to an authorized managed Windows/RDP identity through the CloudBox control plane.

## 28.2 Device list

Only show devices user is authorized to reach.

Each device card/row:

- name,
- online/offline,
- tenant,
- active/maximum slots if policy permits,
- connection state.

## 28.3 Connect

Connect performs:

```text
verify SaaS session
   ↓
verify membership
   ↓
verify subscription/device entitlement
   ↓
verify network permission
   ↓
ensure local private-network client is connected
   ↓
launch mstsc to private CloudBox address
```

No customer should need to type a Netmaker/WireGuard IP, network name, enrollment key, or RDP address in normal operation.

## 28.4 Local credentials

Windows/CloudBox user credential strategy must be separately defined.

Long-term preferred options should minimize shared/static passwords.

Do not place RDP passwords in URLs, command-line arguments visible to other processes, or logs.

---

# 29. Agent Health Model

Agent emits one normalized health document.

Example:

```json
{
  "device": "dev_...",
  "agent": {"version": "1.8.2", "healthy": true},
  "license": {"state": "active", "days_remaining": 287},
  "network": {"state": "connected"},
  "rdp": {"state": "healthy", "listener": true},
  "users": {"configured": 6, "limit": 6, "active_sessions": 3},
  "backup": {"state": "healthy", "last_success": "..."},
  "storage": {"free_bytes": 123},
  "updates": {"state": "current", "reboot_required": false},
  "security": {"device_key": "tpm", "tamper": "none"}
}
```

Only meaningful changes should become durable events.

---

# 30. Agent Resilience

Windows Service recovery:

- first failure: restart,
- second failure: restart,
- subsequent failure: restart with backoff,
- record repeated crash loop.

Agent local state must survive reboot.

Cloud downtime must not crash Agent.

The service must distinguish:

```text
Cloud unavailable
Network unavailable
VPN controller unavailable
License invalid
Local Windows service fault
```

instead of collapsing everything into “offline.”

---

# 31. License Enforcement and RDP Gate

Remote access should be fail-closed relative to license validation.

A CloudBox-owned Windows Firewall enforcement rule can be used as the final gate for managed RDP access.

Conceptual states:

```text
VALID        → managed RDP allowed on private overlay
OFFLINE_VALID→ managed RDP allowed on private overlay
GRACE        → managed RDP allowed with warning
EXPIRED      → managed RDP blocked
TAMPER       → managed RDP blocked
REVOKED      → managed RDP blocked after revocation reaches device
```

Firewall policy should scope RDP to the private network wherever technically reliable.

Do not delete the underlying remote-session configuration to enforce a temporary subscription state.

---

# 32. Revocation Semantics

Cloud revocation propagates to online devices immediately.

For an offline device, the maximum time until revocation takes effect is bounded by the local lease/grace policy.

Highly sensitive customers may choose shorter offline lease periods.

A revoked device must not receive a fresh lease.

---

# 33. License Renewal

## 33.1 Renewal warning

Warning days is centrally configurable.

Examples:

```text
60 / 30 / 15 / 7 / 1
```

Can be defaulted globally and overridden per plan/license.

## 33.2 QR code

The local Status app displays a QR pointing to a SaaS renewal flow.

QR must contain only a public/non-secret reference or short-lived challenge.

Never encode the actual offline entitlement or reusable credential in the QR.

## 33.3 Renewal result

After successful renewal:

- cloud entitlement updates,
- generation increases,
- online Agent refreshes immediately,
- offline device may import a device-bound renewal package if required,
- old stale generation cannot supersede newer state.

---

# 34. SaaS Billing Boundary

The SaaS data model should support subscriptions from day one even if payment automation is deferred.

Keep payment provider integration behind a provider adapter.

Initial states may be manually managed by Super Admin.

Do not bake Stripe/Razorpay-specific identifiers into core entitlement logic.

---

# 35. Audit Requirements

Every consequential state change writes an append-only audit event containing:

```text
event_type
entity_type
entity_id
actor_user_id
actor_tenant_id if applicable
before snapshot
after snapshot
request/correlation ID
timestamp
source
```

Representative events:

```text
TENANT_CREATED
TENANT_UPDATED
TENANT_ARCHIVED
DEVICE_ENROLLED
DEVICE_REVOKED
DEVICE_TRANSFERRED
SUBSCRIPTION_CHANGED
LICENSE_ISSUED
LICENSE_RENEWED
LICENSE_REVOKED
USER_INVITED
USER_REMOVED
USER_SLOT_CHANGED
BACKUP_REQUESTED
RESTORE_STARTED
RESTORE_COMPLETED
UPDATE_RELEASED
UPDATE_DEPLOYED
REBOOT_REQUESTED
BREAK_GLASS_REQUESTED
BREAK_GLASS_STARTED
BREAK_GLASS_ENDED
```

---

# 36. Diagnostics and Support Bundles

Agent can collect a structured support bundle.

Include only relevant technical data:

- Agent logs,
- health snapshot,
- Windows build,
- service status,
- private-network status,
- RDP status,
- backup history metadata,
- update status,
- disk information,
- recent Agent events.

Do not automatically upload:

- business application company data,
- arbitrary user documents,
- browser history,
- stored credentials.

Support bundle upload must be visible/auditable.

---

# 37. Privacy and Tenant Isolation

Every D1 row containing tenant data must have explicit tenant ownership where appropriate.

Every API request resolves tenant authorization server-side.

No tenant ID supplied by a client is trusted merely because it is syntactically valid.

VPN policy must mirror SaaS tenant isolation.

Cross-tenant Super Admin access is permitted only through staff permissions and remains audited.

---

# 38. Security of Secrets

Cloud secrets belong in Cloudflare secret storage, not plaintext config or D1.

Examples:

- auth secrets,
- email provider secret,
- license signing private key or protected key handle,
- Netmaker API credential,
- backup key-encryption secrets,
- update-signing integration secrets.

Windows device private identity key must not be uploaded to Cloud.

---

# 39. Operational Logging

Logs must have levels:

```text
DEBUG
INFO
WARN
ERROR
SECURITY
```

Sensitive values are redacted.

Never log:

- OTP codes,
- private keys,
- full offline license plaintext,
- RDP passwords,
- recovery credentials,
- auth cookies,
- email provider secrets.

Correlation IDs link:

```text
Cloud request → command → Agent execution → result
```

---

# 40. Cloud Outage Behavior

Cloudflare outage:

- existing valid offline licenses continue,
- current private-network sessions should continue if the VPN control plane is not required for already-established tunnels,
- Agent queues non-critical telemetry locally,
- backups continue locally,
- offsite upload retries,
- new OTP logins may be unavailable,
- new device enrollment unavailable,
- new break-glass cloud requests unavailable.

The architecture should avoid turning a Worker outage into an accounting outage for already-authorized users wherever technically feasible.

---

# 41. VPN Controller Outage Behavior

Existing established peer connectivity should survive control-plane loss where supported by the chosen VPN platform.

Agent distinguishes controller outage from local tunnel failure.

The system should test this behavior explicitly before production adoption.

---

# 42. Parent Console and Recovery

The parent local Windows account is preserved for local administrative recovery.

It is not a normal licensed customer RDP slot.

Recovery tasks:

- Agent repair,
- network repair,
- offline entitlement import,
- business application repair,
- restore operation,
- update rollback,
- Windows maintenance.

Customer-facing documentation should explain that normal remote work uses managed accounts rather than the parent administrator.

---

# 43. Super Admin Settings

Global policy settings include:

- default renewal warning days,
- default offline grace,
- maximum break-glass duration,
- maintenance-window defaults,
- reboot warning duration,
- backup retention templates,
- allowed Agent release channels,
- minimum Agent version,
- minimum supported Windows build,
- whether TPM is mandatory,
- tenant capability defaults.

Every policy change is audited.

---

# 44. Alerts Dashboard

Alerts are stateful records, not transient toast messages.

Fields:

- alert ID,
- tenant/device,
- severity,
- category,
- opened time,
- latest evidence,
- current status,
- acknowledged by,
- resolved time.

Severity baseline:

```text
Info
Warning
Critical
```

Critical examples:

- license signature failure,
- clock tamper,
- no backup beyond hard SLA,
- device-binding failure,
- repeated Agent crash loop,
- backup integrity failure.

---

# 45. Update Dashboard

Release record:

- version,
- component,
- release channel,
- release notes,
- package hash,
- signature status,
- created by,
- rollout policy,
- target devices,
- success/failure counts,
- rollback status.

Never infer successful rollout only from “downloaded.”

Required terminal states:

```text
Installed + healthy
Installed + unhealthy
Rolled back
Failed download
Failed validation
Deferred active users
Deferred maintenance window
```

---

# 46. Backup Dashboard

Focus on exceptions.

Global cards/summary may include only factual metrics:

- devices protected,
- devices overdue,
- failed jobs last 24h,
- restore verification overdue.

Primary table:

```text
Tenant | Device | Last local backup | Last cloud backup | Verify | Retention | State
```

Clicking a row opens backup history and restore options.

---

# 47. Maintenance Mode

Support a device maintenance state.

When enabled:

- normal user connection can be denied or warned depending on policy,
- backup/update operations may proceed,
- Super Admin support access may remain possible,
- Status UI clearly shows Maintenance Mode,
- cloud records who enabled it and why.

Maintenance mode must have an optional automatic expiry to prevent forgotten lockout.

---

# 48. Emergency Local Recovery Entitlement

Super Admin can create a machine-bound offline recovery package for a device that cannot contact Cloud.

Use cases:

- expired but paid subscription awaiting connectivity repair,
- corrupt local entitlement,
- clock-tamper false positive requiring field recovery,
- network migration.

Properties:

- bound to device public key,
- signed by CloudBox,
- short duration,
- one purpose/capability set,
- unique nonce,
- generation greater than or compatible with local state rules,
- cannot renew another machine.

Import occurs through Setup/Status recovery UI.

---

# 49. Testing Strategy

Tests focus on integration and project-specific behavior rather than re-testing libraries.

## 49.1 Cloud tests

- tenant authorization boundary,
- role/capability boundary,
- OTP flows,
- license issuance,
- device enrollment,
- subscription transitions,
- audit creation,
- API version headers,
- screen-loader query ceilings.

## 49.2 Windows Agent tests

- valid offline startup,
- expired offline startup,
- copied license to different device,
- device-key mismatch,
- clock rollback,
- stale generation rollback,
- service crash/restart,
- no Internet,
- Worker unavailable,
- VPN unavailable,
- backup disk unavailable,
- low disk,
- update success,
- update rollback,
- active-user reboot deferral.

## 49.3 End-to-end physical tests

At least one real CloudBox must test:

- two+ simultaneous remote sessions,
- Internet disconnect/reconnect,
- reboot with offline valid license,
- expiry/tamper block,
- backup + restore,
- Agent OTA,
- scheduled reboot,
- break-glass support access,
- private-network access revocation.

Physical acceptance criteria cannot be replaced by unit tests.

---

# 50. Deployment Environments

Cloud environments:

```text
local
development
staging
production
```

Windows release channels map separately:

```text
Development
Pilot
Stable
```

Staging must not use production signing keys or production tenant data.

---

# 51. Repository / Monorepo Shape

Suggested shape:

```text
/apps
  /admin-web
  /tenant-web
  /worker-api
  /connect-windows
  /cloudbox-setup
  /cloudbox-agent
  /cloudbox-status

/packages
  /contracts
  /schemas
  /ui
  /auth
  /audit
  /license-contracts
  /update-manifest

/infra
  /cloudflare
  /network

/docs
  /architecture
  /operations
  /support
  /security
  /runbooks
  /issues
```

Avoid abstracting every component behind custom frameworks. Use small adapters around established libraries.

---

# 52. Required Documentation

The product repo must include:

- architecture overview,
- device enrollment runbook,
- licensing and key-rotation runbook,
- backup/restore runbook,
- Agent update/rollback runbook,
- break-glass support runbook,
- tenant offboarding runbook,
- VPN controller recovery runbook,
- Windows disaster recovery runbook,
- incident log using `symptom → cause → fix → blast radius → verification`,
- customer-facing admin guide,
- support troubleshooting guide.

---

# 53. Tenant Offboarding

Offboarding must be deliberate.

Flow:

- cancel/suspend subscription per policy,
- disable new SaaS sessions,
- revoke remote network access,
- preserve customer data locally,
- provide backup export where contracted,
- revoke device entitlements after contractual period,
- archive cloud metadata per retention policy,
- audit completion.

Do not delete accounting data as an offboarding shortcut.

---

# 54. Metrics and Observability

Track operational metrics that answer real support questions:

- fleet online rate,
- Agent version distribution,
- update failure rate,
- backup success rate,
- average backup age,
- restore verification coverage,
- licenses expiring by window,
- devices in tamper state,
- break-glass usage,
- command success/failure,
- VPN connectivity failure rate.

Avoid vanity analytics.

---

# 55. SaaS User Journeys

## 55.1 Tenant owner onboarding

```text
Invite email
   ↓
email OTP
   ↓
organization setup
   ↓
subscription visible
   ↓
first CloudBox enrollment
   ↓
invite users
```

## 55.2 End user

```text
Install CloudBox Connect
   ↓
email OTP
   ↓
choose organization
   ↓
choose CloudBox
   ↓
Connect
```

## 55.3 Super Admin support

```text
Open tenant/device
   ↓
review health
   ↓
collect diagnostics
   ↓
if required request break-glass
   ↓
fresh OTP
   ↓
temporary support access
   ↓
fix
   ↓
automatic revocation
```

---

# 56. Agentic Generation and Delivery Plan

This section is the default build order for an autonomous coding agent. A phase is a product milestone. A **slice** is the unit that may be implemented, tested, demonstrated, and merged independently.

Do not begin a later phase merely because one file from an earlier phase exists. The exit criteria for the prior phase must be met.

---

## Phase 0 — Repository, engineering contract, and deployable skeleton

### Slice 0.1 — Bootstrap the monorepo

**Goal:** establish the repository boundaries and repeatable local development workflow.

Deliver:

- monorepo/workspace,
- apps/packages/infra/docs structure,
- shared TypeScript configuration,
- .NET solution for Windows components,
- lint/format/typecheck scripts,
- environment example files with no secrets,
- `AGENTS.md` pointing agents back to this master spec and `sorensd/agent-notes`,
- `docs/BUILD_STATE.md`, `docs/ISSUE_LOG.md`, and ADR folder.

Acceptance:

- a fresh clone can install dependencies and run the baseline checks from documented commands,
- CI can execute the same checks.

### Slice 0.2 — Deployable Cloudflare shell

Deliver:

- React + Vite operational-console shell,
- Hono Worker,
- `/api/health`, `/api/version`, `/api/v1/*` mount,
- D1 binding and first migration,
- R2 and Durable Object bindings reserved/configured,
- staging deployment,
- build/version stamp visible in UI and API.

Acceptance:

```text
Open staging URL
→ static shell renders without D1 on the page-load path
→ /api/health is healthy
→ /api/version equals deployed build stamp
```

### Slice 0.3 — Audit infrastructure

Deliver:

- append-only audit table,
- typed audit service,
- server-enforced actor/entity/action model,
- audit viewer placeholder with real records,
- first audited administrative state change using a harmless settings record.

Acceptance:

- change setting,
- verify before/after row stored,
- verify unauthorized user cannot create the change,
- audit screen shows it.

**Phase 0 exit:** staging is deployable, versioned, testable, and every later slice has a place to live.

---

## Phase 1 — Human identity, OTP, roles, and tenant boundary

### Slice 1.1 — Email OTP authentication

Deliver:

- maintained auth library integration,
- email OTP send/verify,
- anti-enumeration behavior,
- resend/rate-limit behavior,
- host-only session cookie,
- login/logout screens,
- audit of security-relevant auth events where appropriate.

Acceptance:

```text
enter email
→ receive OTP
→ paste OTP
→ authenticated session
→ logout invalidates session
```

Test expired, reused, invalid and rate-limited OTPs.

### Slice 1.2 — Staff authorization model

Deliver:

- Super Admin, Admin, Support, Read Only,
- permission catalogue,
- server-side permission middleware,
- no “UI only” permission enforcement,
- permission-boundary tests.

### Slice 1.3 — Tenant CRUD

Deliver end to end:

- tenant schema/migration,
- create/edit/archive APIs,
- operational tenant table,
- tenant detail drawer/page,
- audited state changes,
- archive refusal rules for invalid states where applicable.

### Slice 1.4 — Memberships

Deliver:

- user ↔ tenant membership,
- Tenant Owner/Admin/User standing,
- active-tenant selection,
- tenant-scoped server authorization.

Acceptance:

- same identity may belong to two tenants,
- selecting Tenant A never leaks Tenant B data.

**Phase 1 exit:** humans can authenticate and operate inside a correctly enforced tenant boundary.

---

## Phase 2 — Device identity and physical CloudBox enrollment

### Slice 2.1 — Windows Agent service skeleton

Deliver:

- `CloudBox.CloudBox.Agent` .NET Windows service,
- LocalSystem installation,
- Automatic Delayed Start,
- service recovery policy,
- structured logs,
- local health endpoint/named pipe,
- deterministic uninstall/repair path.

Acceptance on a real Windows test machine:

- install,
- reboot,
- service returns healthy,
- terminate service process and verify recovery.

### Slice 2.2 — Device cryptographic identity

Deliver:

- TPM/CNG-backed key generation when TPM is available,
- non-exportable private key where supported,
- software fallback policy explicitly marked lower assurance,
- public-key registration payload,
- stable device ID separate from hostname.

Do not invent cryptography.

### Slice 2.3 — One-time enrollment

Deliver:

- Super Admin creates enrollment token/code,
- token hash stored server-side,
- short TTL + single use,
- Setup/Agent redeems token,
- tenant/device binding,
- initial device record,
- Fleet table shows the new device.

Acceptance:

- token cannot be redeemed twice,
- expired token fails,
- device appears under exactly one tenant.

### Slice 2.4 — CloudBox local status application

Deliver initial Status UI showing:

- device ID/name,
- enrollment state,
- agent health,
- cloud reachability,
- license placeholder state,
- network placeholder state,
- backup placeholder state.

It communicates with Agent over a protected local IPC boundary.

**Phase 2 exit:** a real physical Windows device can securely enroll and appear in the SaaS fleet.

---

## Phase 3 — Subscription and machine-bound offline entitlement

### Slice 3.1 — Subscription and entitlement data model

Deliver:

- plans/subscriptions,
- max user slots,
- valid-from/until,
- warning days,
- offline grace policy,
- feature flags,
- entitlement generation/version counter.

### Slice 3.2 — Standard signed/encrypted entitlement format

Use established JOSE/platform cryptography or another vetted standard library. Do not create a proprietary cipher.

Deliver:

- signed entitlement claims,
- encryption to enrolled device public key where design requires confidentiality,
- key IDs/versioning,
- local verifier,
- explicit unsupported-version behavior.

### Slice 3.3 — Offline cache and startup validation

Deliver Agent logic:

```text
boot
→ load cached entitlement
→ verify issuer/signature
→ verify machine binding
→ verify generation/state
→ verify validity using trusted-time subsystem
→ calculate slot allowance
→ publish normalized license state
```

### Slice 3.4 — Copy protection test

This is a hard acceptance test:

```text
issue entitlement to Device A
→ copy all obvious license/config files to Device B
→ Device B MUST reject entitlement
```

Capture evidence in test fixtures/runbook.

### Slice 3.5 — License UI and renewal warning

Status window + portals display:

- Active / Expiring / Expired / Tamper Suspected,
- X days remaining,
- configured slots / active sessions,
- QR renewal link when within configurable warning threshold.

**Phase 3 exit:** one physical device remains licensed offline and the lease cannot simply be copied to another machine.

---

## Phase 4 — Trusted time, rollback detection, and local tamper resistance

### Slice 4.1 — Trusted server-time anchor

Deliver:

- signed/validated cloud time sample as part of authenticated Agent communication,
- stored high-water mark,
- source metadata.

### Slice 4.2 — Clock rollback detection

Use a combination of:

- last trusted server time,
- highest observed local time,
- monotonic process uptime during runtime,
- sealed local state.

Acceptance:

- move system clock meaningfully backward after establishing high-water mark,
- state becomes `clock_tamper_suspected`,
- managed remote access follows policy,
- customer data is untouched.

### Slice 4.3 — State integrity / rollback detection

Deliver:

- DPAPI-machine protected local state,
- ACL restricted to SYSTEM/administrators as appropriate,
- integrity/version metadata,
- detection of older copied state over newer state.

### Slice 4.4 — Offline rescue entitlement

Deliver:

- Super Admin creates a machine-specific short-lived rescue entitlement,
- no universal rescue key,
- audit and reason mandatory,
- local import path,
- automatic expiry.

**Phase 4 exit:** common offline bypasses such as clock rollback, state-file rollback and copied entitlements fail safely.

---

## Phase 5 — Server installer, embedded RDP runtime, and managed Windows users

### Slice 5.1 — Consolidate Server Setup

Deliver one customer-facing installer:

`CloudBox.Server.Setup.exe`

It provisions:

- Agent,
- Status,
- RDP Wrapper/TermWrap runtime,
- managed local group/users,
- business application data/backup directories,
- ACLs,
- standard RDP/NLA prerequisites,
- firewall baseline,
- private-network runtime placeholder until Phase 6.

No upstream configuration UI belongs in the normal customer path.

### Slice 5.2 — RDP Wrapper health adapter

Create a CloudBox-owned adapter around the permitted upstream runtime.

The Agent reports normalized states such as:

```text
healthy
wrapper_missing
service_stopped
listener_missing
unsupported_runtime
repair_required
```

Do not make SaaS/UI depend directly on upstream file names or UI concepts.

### Slice 5.3 — Parent console account policy

Ensure the parent account remains the local maintenance/recovery account and is not counted as an ordinary managed remote-work slot.

### Slice 5.4 — Managed user reconciliation

Deliver desired-state management for `cloud01...` or generated managed identities:

- create,
- enable/disable,
- Remote Desktop Users membership,
- CloudBoxUsers group membership,
- slot cap,
- no destructive account deletion for simple license loss.

### Slice 5.5 — RDP gate controlled by Agent

Deliver CloudBox-owned firewall policy that allows/blocks managed RDP according to normalized license/device state.

Hard tests:

- valid → permitted,
- expired → new managed remote connection blocked,
- tamper → policy applied,
- Agent crash → fail-safe behavior,
- local console remains usable,
- no customer data deletion.

**Phase 5 exit:** the Server installer can turn a clean supported Windows machine into a locally licensed CloudBox with managed remote users and hidden RDP plumbing.

---

## Phase 6 — Private mesh network and CloudBox Connect

### Slice 6.1 — Netmaker infrastructure adapter

Deliver:

- pinned Netmaker CE version,
- infrastructure deployment docs,
- CloudBox-owned API adapter,
- desired-state model in SaaS,
- no business authority stored solely in Netmaker.

### Slice 6.2 — One isolated network per tenant

Deliver:

```text
tbx-<tenant-id>
```

with:

- CloudBox server peers,
- authorized Connect peers,
- CloudBox provider-support peer/group,
- explicit tenant isolation.

Hard test: cross-tenant packets fail.

### Slice 6.3 — Embed Netclient/WireGuard in Server Setup

Server installer silently provisions/configures the network runtime and Agent reports normalized network health.

Customers do not handle enrollment keys or WireGuard configuration.

### Slice 6.4 — Connect client authentication model

Build `CloudBox.CloudBox.Connect` login:

```text
Tenant ID
Client ID
Password
```

Requirements:

- client user is scoped to a parent tenant,
- password hashing uses maintained library/platform primitives,
- lockout/rate limits,
- password reset with email OTP or tenant-admin flow,
- optional step-up OTP for new devices/policy.

### Slice 6.5 — Connect network enrollment

After authentication:

- retrieve authorized device assignments,
- obtain short-lived network enrollment authorization,
- bring up hidden private-network runtime,
- never expose raw long-lived enrollment secrets to ordinary UI.

### Slice 6.6 — One-click business application connection

Connect UI displays only authorized CloudBoxes and starts the RDP session automatically.

Acceptance:

```text
login as Tenant A client
→ see only assigned Tenant A CloudBox
→ click Connect
→ private path established
→ RDP opens
```

### Slice 6.7 — Multi-session physical acceptance

On a real CloudBox:

- Client 1 logs in and connects,
- Client 2 logs in and connects simultaneously,
- both independent RDP sessions remain active,
- business application can be opened by both within the supported application model,
- `quser`/Agent session telemetry agrees with SaaS.

**Phase 6 exit:** customer users connect through the CloudBox product without seeing VPN/RDP internals.

---

## Phase 7 — Realtime fleet management

### Slice 7.1 — Agent WebSocket channel

Deliver authenticated long-lived Agent connection using Durable Objects/WebSockets as designed.

### Slice 7.2 — Device presence

Normalize:

- online,
- offline,
- degraded,
- maintenance,
- updating,
- license-blocked.

### Slice 7.3 — Fleet operational table

Build dense Super Admin Fleet view with:

- tenant,
- device,
- online state,
- network state,
- RDP state,
- active sessions,
- slots,
- backup state,
- disk state,
- agent version,
- pending reboot/update,
- license days remaining.

Avoid decorative KPI/card sprawl.

### Slice 7.4 — Device detail

Implement tabs/sections already defined in this spec:

- Overview,
- Users,
- Sessions,
- Network,
- License,
- Backups,
- Updates,
- Maintenance,
- Diagnostics.

### Slice 7.5 — Realtime session events

Agent emits start/end/reconnect events and UI updates without high-frequency polling.

**Phase 7 exit:** Super Admin can operate the installed fleet from one trustworthy live console.

---

## Phase 8 — Command plane and safe remote actions

### Slice 8.1 — Command queue contract

Deliver:

- unique command IDs,
- actor,
- device,
- command type,
- arguments validated against allow-listed schema,
- issued/acknowledged/running/succeeded/failed/expired states,
- idempotency semantics.

### Slice 8.2 — Initial safe commands

Implement only allow-listed actions such as:

- run health check,
- refresh entitlement,
- run backup,
- restart approved CloudBox service,
- collect support bundle,
- schedule reboot.

No arbitrary shell in V1.

### Slice 8.3 — Command UI and audit

Every command must show:

- who sent it,
- when,
- why where required,
- result,
- output summary,
- audit event.

**Phase 8 exit:** remote operations are structured, bounded and auditable rather than becoming a hidden RMM shell.

---

## Phase 9 — business application backup and restore

### Slice 9.1 — Local application-consistent backup adapter

Implement the verified business application backup method selected for the supported business application version. Do not assume copying live files is safe.

Record:

- source dataset,
- start/end,
- application backup result,
- resulting artifact(s),
- byte size,
- hash,
- destination.

### Slice 9.2 — Separate local backup target

Prefer a physically separate disk when present. Detect when only same-disk storage exists and mark durability lower.

### Slice 9.3 — Offsite encrypted replication

Upload completed backup artifacts only after local completion.

Requirements:

- transport encryption,
- encryption at rest,
- tenant/device namespacing,
- checksum after upload where supported,
- resumable/retry behavior,
- no live business application data folder synchronization.

### Slice 9.4 — Retention engine

Implement configurable baseline retention, for example:

- recent frequent restore points,
- daily,
- weekly,
- monthly.

Retention configuration belongs to policy/data, not hardcoded branching.

### Slice 9.5 — Backup dashboard and alerts

Show:

- last successful application backup,
- last successful offsite copy,
- last verified restore,
- size trend,
- failures,
- target disk health.

### Slice 9.6 — Guided restore

Deliver restore workflow that:

- selects a known backup,
- validates artifact/hash,
- restores first to a controlled location or approved destination,
- does not blindly overwrite live data without explicit confirmation,
- audits the action.

### Slice 9.7 — Restore drill

A backup feature is not accepted until a restore of representative test data has been successfully opened/validated with the supported business application workflow.

**Phase 9 exit:** CloudBox can prove recovery, not merely prove that files were uploaded.

---

## Phase 10 — OTA / self-update system

### Slice 10.1 — Release manifest

Define signed manifest for:

- Agent,
- Status,
- Server Setup/repair payloads,
- Connect client,
- network runtime versions where CloudBox controls them.

### Slice 10.2 — Package signing and verification

Every package must verify:

- expected product,
- version,
- publisher/code signature where applicable,
- cryptographic hash,
- signed release manifest.

### Slice 10.3 — Update channels

Support:

```text
Development
Pilot
Stable
Pinned
```

No “release to everyone” as the only mechanism.

### Slice 10.4 — Pilot rollout

Deploy to a small selected cohort, wait for health gate, then permit promotion.

### Slice 10.5 — Transactional local updater

Update flow:

```text
download
→ verify
→ stage
→ ensure recovery package exists
→ stop affected component safely
→ install
→ restart
→ health check
→ commit success
```

### Slice 10.6 — Rollback

If post-update health fails, revert to last known-good package and report rollback reason.

### Slice 10.7 — Connect client auto-update

Same principles, but user-friendly restart/defer behavior.

**Phase 10 exit:** a bad Pilot update cannot casually brick the whole fleet.

---

## Phase 11 — Maintenance windows, scheduled reboot, and Wake-on-LAN

### Slice 11.1 — Maintenance policy

Per tenant/device settings:

- timezone,
- maintenance days,
- window start/end,
- maximum reboot deferral,
- whether active sessions may postpone reboot,
- user notification lead time.

### Slice 11.2 — Scheduled reboot

Before reboot:

- verify command/policy,
- inspect active sessions,
- warn users,
- defer when policy allows,
- run pre-reboot health/backup conditions if configured,
- reboot,
- verify Agent/network/RDP/backup scheduler after startup.

### Slice 11.3 — Pending reboot fleet state

Show why reboot is pending and next planned window.

### Slice 11.4 — WOL capability detection

Detect/report:

- NIC capability,
- BIOS/UEFI unknown/likely state where discoverable,
- MAC addresses,
- network conditions relevant to WOL.

### Slice 11.5 — Site Relay

Because cloud infrastructure cannot magically emit LAN broadcasts into an offline customer LAN, implement optional Site Relay using another always-on authorized CloudBox-managed node when WOL is required.

The relay accepts signed/authorized WOL command and sends magic packet locally.

**Phase 11 exit:** routine maintenance can happen predictably without surprising active accountants.

---

## Phase 12 — Provider support and break-glass emergency access

### Slice 12.1 — Permanent provider network reachability

Ensure the provider-support peer/group can be represented in every tenant mesh without granting routine Windows login authority.

### Slice 12.2 — Break-glass request

Require:

- authorized staff permission,
- fresh OTP step-up,
- support reason/ticket,
- target device,
- requested duration,
- audit event.

### Slice 12.3 — Temporary Windows support identity

Agent creates or enables a temporary support identity/credential only for the approved window.

Requirements:

- random credential or short-lived credential flow,
- not shared between tenants,
- not a permanent known password,
- Remote Desktop authorization only as required,
- expiry timer local to device as well as cloud.

### Slice 12.4 — Visible customer indication

Status UI shows that provider emergency access is active, including expiry time where appropriate.

### Slice 12.5 — Automatic teardown

At expiry:

- disable/remove temporary access,
- close temporary firewall/access grants,
- report result,
- audit teardown.

### Slice 12.6 — Offline emergency path

Design a machine-bound rescue workflow that can work when Cloudflare is unavailable without creating a universal master password.

**Phase 12 exit:** provider can recover/support a customer device in an emergency with strong evidence and automatic cleanup.

---

## Phase 13 — Tenant portal and end-user administration

### Slice 13.1 — Tenant overview

Expose only tenant-owned information:

- CloudBoxes,
- online state,
- subscription/license summary,
- configured users,
- backup health,
- maintenance notices.

### Slice 13.2 — Client user management

Tenant admin can:

- create client identity,
- suspend,
- reset password through approved flow,
- assign CloudBox access,
- inspect last login/device status,
- never grant Super Admin/provider capabilities.

### Slice 13.3 — User slot management

UI clearly distinguishes:

```text
licensed slots
configured managed users
currently active sessions
```

### Slice 13.4 — Renewal experience

Implement renewal QR/link destination and clear subscription state without exposing machine license internals.

**Phase 13 exit:** customers can perform ordinary administration without CloudBox touching every account.

---

## Phase 14 — Alerts, support bundles, and observability

### Slice 14.1 — Normalized event model

Implement meaningful events for:

- device offline,
- RDP unhealthy,
- VPN unhealthy,
- entitlement expiring,
- clock tamper,
- backup missed,
- restore overdue,
- disk low/SMART warning where available,
- update failed/rolled back,
- Agent recovery,
- break-glass active.

### Slice 14.2 — Alert routing

Support configurable channels available to the chosen provider, with deduplication and cooldowns.

### Slice 14.3 — Diagnostics bundle

Generate support ZIP with safe diagnostics only:

- version info,
- service states,
- relevant event logs,
- normalized network health,
- license state without secret private material,
- backup metadata,
- recent Agent logs with secret redaction.

### Slice 14.4 — Fleet observability

Operational dashboards should answer:

- what is broken,
- who is affected,
- since when,
- what changed,
- what action is safe next.

**Phase 14 exit:** support can diagnose most incidents without asking customers to run PowerShell manually.

---

## Phase 15 — Production security and failure hardening

Run deliberate drills against a real or production-equivalent physical lab.

Mandatory drills:

1. Cloudflare API unavailable.
2. D1 degraded/unavailable.
3. Netmaker controller unavailable.
4. Internet unavailable.
5. Device stays offline beyond entitlement expiry.
6. Clock moved backward.
7. Clock moved forward then backward.
8. Entitlement copied to another machine.
9. Local entitlement/state file restored from older disk image.
10. TPM/device identity unavailable or hardware replaced.
11. Agent service killed repeatedly.
12. RDP wrapper/service unhealthy after Windows update.
13. Private network runtime removed/stopped.
14. Client credential disabled while client was previously authorized.
15. Backup disk removed/full.
16. Offsite upload fails for 24+ hours.
17. Restore artifact corrupt/hash mismatch.
18. OTA package corrupted.
19. OTA health check fails and rollback executes.
20. Reboot scheduled while sessions are active.
21. Machine is powered off and WOL attempted with/without Site Relay.
22. Break-glass expires while support is connected.
23. Provider support peer attempts cross-tenant movement outside policy.
24. Tenant A user attempts Tenant B API/device/network access.
25. Setup/Agent uninstall/repair performed on partially configured machine.

Each drill must produce:

- expected behavior,
- actual evidence,
- logs/audit entry where relevant,
- remediation if behavior differs.

**Phase 15 exit:** the system has survived the failures most likely to hurt a paying accounting customer.

---

## Phase 16 — Commercial release readiness

### Slice 16.1 — Third-party inventory

Finalize:

- RDP Wrapper permission evidence,
- TermWrap/dependency inventory,
- Netmaker/Netclient/WireGuard/Wintun notices,
- all npm/NuGet/etc. license inventory,
- shipped notices.

### Slice 16.2 — Signed installers

Ship code-signed:

- Server Setup,
- Agent,
- Status,
- Connect.

### Slice 16.3 — Support runbooks

Complete:

- enroll,
- replace device,
- recover license,
- restore backup,
- rollback update,
- break-glass,
- VPN repair,
- RDP repair,
- offboard tenant.

### Slice 16.4 — Golden-device acceptance

Build a clean Windows machine from scratch using the commercial installer and execute the full first-commercial-milestone workflow from Section 0.12.

**Phase 16 exit:** release candidate is installable and supportable without developer intervention.

---

# 57. Slice Execution Template for Coding Agents

For every slice, the agent MUST create or update a short implementation note containing:

```markdown
# Slice N.M — Name

## Goal
What usable outcome exists when this slice is done?

## Existing capabilities reused
- existing project code
- framework primitives
- maintained packages
- upstream service/API

## Data changes
- migrations
- indexes
- retention implications

## API/contracts
- endpoints/events/messages
- validation schemas
- backward compatibility

## Authorization
- required permissions
- tenant boundary
- negative tests

## UI/Agent behavior
- user workflow
- loading/empty/error/degraded states

## Audit/events
- event names
- before/after data

## Tests
- happy path
- permission boundary
- integration
- failure path
- physical Windows test if applicable

## Demo path
Literal clicks/commands to prove the slice.

## Rollback
How to undo safely.

## Evidence
Links/paths to screenshots, logs, test output, live version.
```

This note can live in the PR/issue system or under `docs/slices/`.

---

# 58. Definition of Done for Every Feature

A feature is not done until the same delivery contains all applicable items:

1. data/migration if needed,
2. validated versioned API/contract,
3. server-side authorization,
4. tenant isolation,
5. reachable UI or Agent behavior,
6. loading/empty/error/degraded states,
7. audit event for consequential writes,
8. happy-path tests,
9. permission-boundary tests,
10. integration/failure tests,
11. literal demo path,
12. deployed verification where platform behavior matters,
13. real Windows verification where endpoint behavior matters,
14. docs/runbook update,
15. BUILD_STATE update,
16. issue-log entry when a non-obvious problem consumed significant debugging time.

A build passing locally is necessary and insufficient.

---

# 59. UI Generation Contract

The Super Admin and Tenant applications are **operational consoles**. Before generating UI, the agent must name the page type and load the UI guidance from `sorensd/agent-notes`.

Super Admin expectations:

- highest information density,
- tables over decorative card grids,
- saved filters/views where useful,
- keyboard-accessible interactions,
- detail drawers or focused pages,
- clear health/status semantics,
- no invented metrics,
- almost no decorative motion,
- excellent loading/empty/error/partial-permission states.

CloudBox Connect expectations:

- extremely simple,
- login → authorized device → Connect,
- clear offline/expired/network errors,
- network/RDP implementation details hidden.

CloudBox Status expectations:

- appliance-like,
- trust and diagnosability over decoration,
- visible license/network/backup/update/support state,
- no privileged actions that bypass Agent authorization.

Visual work is not accepted without actual render/screenshot inspection.

---

# 60. Explicit Non-Goals for Initial Release

Do not build these in V1 unless the human owner explicitly changes scope:

- a custom WireGuard protocol/control plane,
- arbitrary remote shell/RMM scripting,
- custom cryptographic algorithms,
- custom password hashing,
- a general-purpose RMM replacement,
- custom payment processor,
- AI-generated fleet recommendations,
- generic Windows desktop administration for unrelated workloads,
- destructive license enforcement,
- public Internet RDP exposure,
- end-user visibility of RDP Wrapper/Netmaker/WireGuard configuration,
- virtualization as a requirement.

The product is a **managed business application appliance SaaS**, not a generic remote-desktop product or Windows management suite.

---

# 61. Product Acceptance Criteria

The first commercially credible release is accepted only when all of the following are demonstrated:

- a new SaaS administrator signs in with email OTP,
- a tenant can be created and membership enforced,
- a new physical Windows CloudBox enrolls with a one-time token,
- device identity is cryptographically bound,
- a copied local entitlement does not work on another machine,
- the device operates with a valid entitlement while temporarily offline,
- an expired/tampered offline CloudBox blocks managed remote access without damaging local data,
- the parent console/recovery account remains available according to policy,
- authorized Connect users authenticate with Tenant ID + Client ID + password,
- Connect reveals only their authorized parent-tenant devices,
- Connect establishes the hidden private mesh and launches RDP,
- at least two simultaneous independent RDP sessions are proven on the lab CloudBox,
- Super Admin sees accurate fleet and session state,
- Provider Support has network reachability without routine Windows admin authority,
- backups run locally and offsite,
- a representative backup has been successfully restored and verified,
- Pilot OTA deploys and rollback is proven,
- maintenance-window reboot respects active-session policy,
- WOL capability is correctly reported and Site Relay is used where required,
- break-glass support requires step-up/reason, is visible, expires automatically, and is fully audited,
- no public 3389 exposure is required,
- temporary cloud outage does not instantly stop already-valid offline appliances,
- cross-tenant API and network tests fail closed,
- third-party notices and redistribution evidence are complete.

---

# 62. Agent Verification Matrix

Before calling the project complete, maintain a matrix with at least these dimensions:

| Area | Unit | Integration | Cloud staging | Physical Windows | Failure drill |
|---|---:|---:|---:|---:|---:|
| OTP/Auth | ✓ | ✓ | ✓ | N/A | ✓ |
| Tenant isolation | ✓ | ✓ | ✓ | N/A | ✓ |
| Device enrollment | ✓ | ✓ | ✓ | ✓ | ✓ |
| Offline licensing | ✓ | ✓ | N/A | ✓ | ✓ |
| Clock tamper | ✓ | ✓ | N/A | ✓ | ✓ |
| RDP health/gate | ✓ | ✓ | telemetry | ✓ | ✓ |
| Private mesh | ✓ | ✓ | controller | ✓ | ✓ |
| Connect client | ✓ | ✓ | auth/API | ✓ | ✓ |
| Backups | ✓ | ✓ | metadata | ✓ | ✓ |
| Restore | ✓ | ✓ | audit | ✓ | ✓ |
| OTA | ✓ | ✓ | release API | ✓ | ✓ |
| Reboot/WOL | ✓ | ✓ | command API | ✓ | ✓ |
| Break-glass | ✓ | ✓ | ✓ | ✓ | ✓ |

The table must link to evidence, not merely contain checkmarks.

---

# 63. Required Documentation Outputs

The codebase is incomplete without these maintained documents:

- `README.md` — developer/bootstrap instructions,
- `AGENTS.md` — how agents must load this spec and agent-notes,
- `docs/ARCHITECTURE.md` — current diagrams and responsibilities,
- `docs/SECURITY.md` — trust boundaries, secrets, license and break-glass model,
- `docs/BACKUP_RESTORE.md` — exact supported backup/restore procedure,
- `docs/OPERATIONS.md` — routine fleet operations,
- `docs/SUPPORT_BREAK_GLASS.md` — emergency support runbook,
- `docs/UPDATE_RUNBOOK.md` — Pilot/Stable/rollback procedure,
- `docs/THIRD_PARTY_NOTICES.md`,
- `docs/ISSUE_LOG.md`,
- `docs/OPEN_QUESTIONS.md`,
- `docs/BUILD_STATE.md`,
- ADRs under `docs/decisions/`,
- API documentation generated from the validation/contracts layer where practical.

---

# 64. First Tasks for an Agent Starting From an Empty Repository

If no implementation exists yet, perform these actions in order:

1. Read this entire file.
2. Read `sorensd/agent-notes/README.md` and its always-load files.
3. Re-read only the relevant Cloudflare/UI/auth notes for Phase 0.
4. Inspect the repository for existing code before scaffolding anything.
5. Create `AGENTS.md` that points back to this file and the authoritative agent-notes.
6. Create `docs/BUILD_STATE.md`, mark Phase 0 / Slice 0.1 in progress.
7. Create the monorepo skeleton and baseline checks.
8. Commit nothing until human author identity is known if commits are requested.
9. Complete Slice 0.1 and its demo/evidence before beginning 0.2.
10. Continue slice by slice. Do not parallelize slices that mutate the same migrations/auth/bootstrap files unless a coordinator explicitly reserves those conflicts.

When an existing repository is present, step 4 is dominant: **integrate with what exists rather than replacing it with the shape imagined by this spec.**

---

# 65. Final Architectural Position

The commercial authority is the SaaS subscription and tenant/account state, **not a reusable product key**.

The CloudBox Server receives a cryptographically verified, machine-bound offline entitlement that can survive temporary Internet loss but cannot simply be copied to another machine.

Human administrative identity uses email + OTP. Daily CloudBox Connect users belong to a parent tenant and authenticate with Tenant ID + Client ID + password, with OTP available for reset, enrollment, or step-up policy.

TPM/CNG-backed device identity authenticates appliances where available.

The CloudBox Agent owns local desired-state enforcement, RDP gating, health, backups, updates, maintenance, and cloud reporting.

RDP Wrapper/TermWrap is absorbed into the CloudBox Server installer and hidden behind a normalized internal adapter. The project owner has direct commercial-use permission from Sergiy Egoshyn for the selected RDP Wrapper project; all separately bundled dependencies still require inventory and notices.

Netmaker CE + Netclient + WireGuard/Wintun provides the private mesh behind CloudBox-branded Server and Connect products. SaaS tenancy remains authoritative; Netmaker is infrastructure, not the customer identity or billing system.

Cloudflare Workers + D1 + Durable Objects + R2 provide the SaaS control plane, realtime fleet channel, object storage and web applications.

The design intentionally separates:

```text
Human identity
Tenant membership
Subscription entitlement
Device identity
Offline license lease
Network authorization
Managed Windows users
Licensed user slots
Active RDP sessions
Backup state
Update state
Provider break-glass state
```

because collapsing these responsibilities into one product key, one VPN identity, or one Windows account would make the platform insecure and difficult to operate.

The customer should experience one coherent CloudBox product. Internally, every responsibility must remain isolated enough to be testable, auditable, replaceable and recoverable.