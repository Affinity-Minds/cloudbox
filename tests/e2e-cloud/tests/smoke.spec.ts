// Production/staging smoke suite (docs/plans/briefs/WT-6-qa-harness.md). Against `BASE_URL`
// (default `http://localhost:8787`, i.e. `wrangler dev` locally). `EXPECTED_SHA` is optional; the
// version check is skipped without it (a local `wrangler dev` reports `gitSha: "development"`,
// not a real commit).

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

const EVIDENCE_DIR = path.resolve(import.meta.dirname, "../../../docs/evidence/e2e");

test.beforeAll(async () => {
  await mkdir(EVIDENCE_DIR, { recursive: true });
});

test("GET /api/health is 200", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ status: "ok" });
});

test("GET /api/version reports gitSha (matches EXPECTED_SHA when set)", async ({ request }) => {
  const response = await request.get("/api/version");
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { gitSha: string };
  expect(typeof body.gitSha).toBe("string");
  expect(body.gitSha.length).toBeGreaterThan(0);

  const expectedSha = process.env.EXPECTED_SHA;
  if (!expectedSha) {
    test.info().annotations.push({
      type: "skip-reason",
      description: "EXPECTED_SHA not set; only checked that gitSha is present",
    });
    return;
  }
  expect(body.gitSha).toBe(expectedSha);
});

test("an anonymous visit to / is guarded: redirects to /login, chrome renders", async ({
  page,
}) => {
  // apps/admin-web/src/routes/_app.tsx now gates every app route behind a session
  // (`requireSession` → redirect to /login) — this landed after this brief was written, when the
  // check here was "the shell renders (sidebar with Overview/Tenants/Fleet)" for an anonymous
  // visit. An anonymous visitor seeing that sidebar would be a regression, not a pass; this test
  // asserts the guard instead, and the authenticated version below covers the actual sidebar.
  await page.goto("/");
  await page.waitForURL(/\/login/);
  // Confirms the SPA fallback served real markup (agent-notes cloudflare-workers #4/#15 — the
  // per-host document trap), not a blank or error document.
  await expect(page.getByText("CloudBox", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: /email/i })).toBeVisible();
  await page.screenshot({ path: path.join(EVIDENCE_DIR, "guard-redirect.png"), fullPage: true });
});

test("/login renders the email step", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("textbox", { name: /email/i })).toBeVisible();
  await page.screenshot({ path: path.join(EVIDENCE_DIR, "login.png"), fullPage: true });
});

/**
 * Reads the six-digit code `sendOtpEmail` (apps/worker-api/src/email/index.ts) logs as
 * `[otp-dev-echo] <email> <code>` when `OTP_DEV_ECHO=1` outside production — the code itself
 * never appears in any HTTP response (anti-enumeration), only the server's own console. Polls
 * because the log write and this read race.
 */
async function readEchoedOtp(logPath: string, email: string): Promise<string> {
  const escaped = email.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\[otp-dev-echo\\]\\s+${escaped}\\s+(\\d{6})`);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const log = await readFile(logPath, "utf8").catch(() => "");
    const match = pattern.exec(log);
    if (match?.[1]) return match[1];
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`no [otp-dev-echo] line for ${email} in ${logPath} after 5s`);
}

// Full sign-in → authenticated shell, only when a local `wrangler dev` log is available (its
// stdout is the only place the OTP appears — `OTP_DEV_ECHO` is refused in production, by design;
// see auth/index.ts assertOtpEchoSafe). Set E2E_OTP_LOG_PATH to run this against your own
// `wrangler dev > wrangler.log 2>&1`. Skipped otherwise, including in the CI `e2e-smoke` job,
// which has no access to the deployed Worker's console.
const otpLogPath = process.env.E2E_OTP_LOG_PATH;
test("signed-in shell renders: sidebar has Overview, Tenants, Fleet (needs E2E_OTP_LOG_PATH)", async ({
  page,
}) => {
  test.skip(!otpLogPath, "E2E_OTP_LOG_PATH not set — see comment above this test");
  const email = `e2e-smoke+${Date.now()}@example.test`;

  await page.goto("/login");
  await page.getByRole("textbox", { name: /email/i }).fill(email);
  await page.getByRole("button", { name: "Send code" }).click();

  const code = await readEchoedOtp(otpLogPath as string, email);
  await page.locator("#otp").pressSequentially(code, { delay: 30 });

  // Nav labels are fixed by apps/admin-web/src/nav.ts (owner WT-0); this test tracks that
  // file's titles, not a hand-copied list, by asserting on the rendered text itself.
  await expect(page.getByRole("link", { name: "Overview" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Tenants" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Fleet" })).toBeVisible();

  await page.screenshot({ path: path.join(EVIDENCE_DIR, "shell.png"), fullPage: true });
});
