# ADR 0003 — Staff authorization: permissions as rows

**Status:** Proposed  
**Date:** 2026-09-26  
**Context:** Slice 1.2 implementation  
**Stakeholders:** WT-0, WT-1 (Auth), WT-8 (Security review)

## Problem

CloudBox staff (Super Admin, Admin, Support, Read Only) need fine-grained permission control. Requirements:
- Prevent privilege escalation
- No "UI only" authorization (server-side enforcement mandatory)
- Auditable permission grants/revokes
- Super Admin receives all permissions but as verifiable rows (not a magical bypass)
- Permission checks independent of role name

## Decision

**Implement permissions as rows in `permissions` and `role_permissions` tables.**

1. **Catalogue:** Permission keys pre-seeded in foundation:
   - `tenant.view`, `tenant.create`, `tenant.edit`, `tenant.archive`
   - `device.view`, `device.manage`, `device.enroll`, `device.revoke`
   - `subscription.view`, `subscription.create`, `subscription.edit`
   - `audit.view`, `support_access.request`, `support_access.retrieve_credential`
   - (Full list in PLAN_5AM.md §7)

2. **Grant model:** `role_permissions` table stores (role, permission_key) tuples seeded during bootstrap.

3. **Super Admin special case:** Super Admin receives every row in `role_permissions` as data, not as a logical exception. Query still evaluates row by row.

4. **Enforcement:** Every protected route uses `requirePermission('key')` middleware. Middleware queries D1:
   ```
   SELECT permission_key FROM role_permissions 
   WHERE role = ? AND permission_key = ?
   ```
   If no row, return 403.

5. **Audit:** Every permission grant/revoke logged as `PERMISSION_GRANTED` / `PERMISSION_REVOKED` with actor, key, timestamp.

## Alternatives considered

- **Better Auth admin plugin:** Built-in role-based access control (would require rewriting permission logic to match spec; introduces dependency on Better Auth internals)
- **Single Super Admin bypass:** Query logic exempts Super Admin from checks (violates auditability; permission grants not logged)
- **Runtime role mapping:** Hard-code role → permission list in code (violates "rows" requirement; impossible to audit individual grants)

## Consequences

**Positive:**
- Every permission grant is a verifiable row; audit trail is complete
- Super Admin cannot hide behind undefined magic; all access is logged
- Permission list is data-driven; easy to add/remove roles without code change
- Row-by-row evaluation prevents logical errors (single query result set = no ambiguity)

**Risks:**
- **Lookup cost:** Every permission check queries D1. Mitigation: cache permission set in session/JWT after login (refresh on logout, explicit invalidation on grant/revoke).
- **Operational complexity:** Revoking permission requires explicit row deletion. Mitigation: design clear restore/rollback procedures.

## Implementation notes

- Permissions table: `(key PK, description TEXT)`
- Role permissions table: `(role, permission_key, PRIMARY KEY(role, permission_key))`
- Middleware: `requirePermission(key)` in Hono routes
- Caching: Permission rows loaded on session create, refreshed on auth-related updates
- Audit events logged with actor, permission_key, granted_by/revoked_by
- Super Admin can delegate specific permissions (no universal bypass)

## See also

- Slice 1.2 — Staff authorization
- PLAN_5AM.md §7 foundation contract (permission catalogue)
- Spec §2 roles and permissions
