# CloudBox issue log

Newest first. Record only non-obvious failures or fixes with meaningful blast radius.

## 2026-09-26 — GitHub writes returned 403 after repository connection
**Symptom:** Read access worked, but branch/issue creation returned `Resource not accessible by integration`.

**Cause:** GitHub connector had not been granted effective organization write access to `Affinity-Minds/cloudbox`.

**Fix:** Re-authenticated the GitHub connector with organization/repository write access.

**Blast radius:** Repository publication only. No code or production infrastructure was affected.

**Verification:** `phase-0/bootstrap` branch creation succeeded after re-authentication.

## Template

### YYYY-MM-DD — Short symptom
**Symptom:**

**Cause:**

**Fix:**

**Blast radius:**

**Verification:**
