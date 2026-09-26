# Security baseline

The master build spec is authoritative. Phase 0 establishes these invariants:

- no secrets in repository configuration;
- production secrets live in GitHub/Cloudflare secret stores;
- `/api/v1/*` is the versioned application contract;
- production version must be verifiable against the Git commit SHA;
- tenant and permission checks will be server-side in later slices;
- no public RDP exposure is part of the architecture;
- no custom cryptography or authentication formats are permitted.
