# Handoff Template for CloudBox Worktrees

This template is used by each worktree to document the state and transition readiness when handing off to the next stage (integration, merge, deployment).

Copy this file as `<branch>.md` (e.g., `wt-p1-auth.md`, `phase-1-identity.md`) and complete every section before marking the worktree ready.

---

## Mission

**Slices:** [list 1.1, 1.2, … as applicable]

**Success criterion:** [brief summary of what "done" means for this worktree]

---

## Current status

- Branch: `[wt/branch-name]`
- Parent: `[phase-N/integration]`
- Implementation phase: [phase number and phase name]
- Commits: [number] since fork
- `pnpm run verify`: [✓ green | ✗ failing with: ]

---

## Commits ready for merge

List commits in order, with one-line message, example:

```
abc1234 Slice 1.1 — email OTP send/verify
def5678 Slice 1.2 — staff authorization model
ghi9012 Tests: permission boundaries and rate limits
```

---

## Files and contracts changed

- **migrations:** none | migration `NNNN_name.sql`
- **API changes:**
  - POST `/api/v1/auth/login` — email OTP send
  - POST `/api/v1/auth/verify` — OTP verification and session start
  - etc.
- **Database schema:** tables added/modified:
  - `table_name` — description
- **Contracts/validation:** packages/contracts
  - `LoginRequest`, `OTPVerifyRequest`, `OTPVerifyResponse`
- **Admin-web routes:** new routes under `src/routes/`
  - `/login`, `/dashboard`, etc.
- **UI components:** any new shadcn blocks or major UI components
- **Configuration:** environment variables, Wrangler secrets needed

---

## Migrations

- **Reserved number:** [0004, 0005, etc. from spec §7 or none if none applied]
- **Filename:** `NNNN_descriptive_name.sql`
- **Applied locally:** [✓ yes | ✗ no, reason]

---

## API changes

For each new or changed endpoint:

| Method | Path | Auth | Permission | Request | Response | Audit event |
|---|---|---|---|---|---|---|
| POST | `/api/v1/auth/login` | — | — | `{ email }` | `{ otpSent: true }` | `OTP_SENT` |
| POST | `/api/v1/auth/verify` | — | — | `{ email, otp }` | `{ sessionToken, userId }` | `USER_LOGIN` |

---

## Security assumptions

- Sessions are httpOnly + Secure cookies
- OTPs are rate-limited (6 requests/hour per email)
- OTP validity window: 10 minutes
- No OTP enumeration: same response for invalid email and invalid OTP
- Server enforces all permission checks; UI hints are not sufficient

---

## Tests run and results

### Verification script (`pnpm run verify`)

```
✓ pnpm run check      (lint, format)
✓ pnpm run typecheck  (TypeScript)
✓ pnpm run test       (N tests: M passed, X skipped)
✓ pnpm run build      (dist generated)
```

### Test coverage (if applicable)

- Unit tests: [files, count]
- Integration tests: [files, count]
- Permission boundary tests: [files, count]
- Physical Windows tests: [if applicable]

### Demo path

Literal steps to verify the slice works end-to-end on staging:

```
1. Open https://staging-url/login
2. Enter email "test@example.com"
3. Check developer console for OTP (or check inbox if real email)
4. Paste OTP
5. Verify redirect to /dashboard
6. Verify session cookie is httpOnly + Secure in DevTools
```

---

## Known failures

List any known issues, regressions, or acceptance criteria not yet met:

- [✓ resolved] Issue description
- [ ] Outstanding blockers
  - Details

---

## Decisions needed

Questions for the orchestrator or owner (WT-0):

- [ ] Item 1: context and question
- [ ] Item 2

---

## Requests to another worktree

Items needed from other worktrees to unblock this one or needed by downstream:

- [ ] WT-0: [description of request]
- [ ] WT-2: [description of request]

---

## Safe next action

One-sentence description of what a downstream worktree or WT-0 should do first:

Example: *WT-1 is ready for merge; WT-0 should integrate and deploy before WT-2 starts, as WT-2 depends on auth routes being live.*

---

## Appendix: Evidence

- Screenshots: `docs/evidence/<wt>/`
- Test output: `pnpm run test 2>&1 | tee test-output.log`
- Build log: `pnpm run build 2>&1 | tee build-output.log`
- Deployed version: https://staging-url/api/version (include response)
- Demo recording: [path if any]
