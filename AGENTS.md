# CloudBox agent instructions

Before changing code, read `CLOUDBOX_MASTER_AGENT_BUILD_SPEC.md` and treat it as the product contract.

Then read the authoritative engineering guidance in `sorensd/agent-notes` in the order required by the master spec. Always load:

- `engineering/coding-agent-instructions.md`
- `process/delivery-rules.md`

Load only task-relevant additional notes from the routing table. For Cloudflare work, load `platform/cloudflare-workers.md` and `platform/fast-data-hydration.md`. For UI work, load the UI/design notes. For auth and permissions, load the API versioning and roles/capabilities notes.

## Delivery rules

- Integrate before authoring.
- Work in closed vertical slices.
- Version APIs under `/api/v1/*`; keep `/api/health` and `/api/version` unversioned.
- Authorize server-side on every protected route.
- Audit every consequential state change.
- Never invent cryptography, auth, token signing, password hashing, VPN orchestration, or session formats.
- Do not mark UI complete without rendered evidence.
- Do not mark Cloudflare/Windows/network behavior complete without live or physical verification where required.
- Update `docs/BUILD_STATE.md` as work proceeds.
- Record non-obvious failures in `docs/ISSUE_LOG.md` using symptom → cause → fix → blast radius → verification.
- Record architectural/security/data/dependency decisions as ADRs.

## Human gates

Stop only for the hard gates listed in the master spec: credentials, destructive production changes, unresolved legal redistribution questions, new trust assumptions, payment-provider selection, or conflicting authoritative requirements.