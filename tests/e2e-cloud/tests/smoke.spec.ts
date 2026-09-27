// Production/staging smoke suite (docs/plans/briefs/WT-6-qa-harness.md). Against `BASE_URL`
// (default `http://localhost:8787`, i.e. `wrangler dev` locally). `EXPECTED_SHA` is optional; the
// version check is skipped without it (a local `wrangler dev` reports `gitSha: "development"`,
// not a real commit).

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

const EVIDENCE_DIR = path.resolve(import.meta.dirname, "../../../docs/evidence/e2e");

/** The staff console base (`OPS_BASE_PATH` var on the Worker; default `/ops`). */
const OPS_BASE_PATH = process.env.OPS_BASE_PATH ?? "/ops";

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

test("an anonymous visit to / lands on the customer sign-in (email step), chrome renders", async ({
  page,
}) => {
  // Two separate surfaces (WT-1, owner decision): the customer surface is /login and /portal; the
  // staff console lives under OPS_BASE_PATH and nothing on the customer surface links to it.
  await page.goto("/");
  await page.waitForURL(/\/login/);
  // Confirms the SPA fallback served real markup (agent-notes cloudflare-workers #4/#15 — the
  // per-host document trap), not a blank or error document.
  await expect(page.getByText("CloudBox", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: /email/i })).toBeVisible();
  await expect(page.getByLabel(/password/i)).toHaveCount(0);
  await page.screenshot({ path: path.join(EVIDENCE_DIR, "guard-redirect.png"), fullPage: true });
});

test("/login renders the customer email step (no password field, no link to the console)", async ({
  page,
}) => {
  await page.goto("/login");
  await expect(page.getByRole("textbox", { name: /email/i })).toBeVisible();
  await expect(page.getByLabel(/password/i)).toHaveCount(0);
  const hrefs = await page
    .locator("a[href]")
    .evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  expect(hrefs.some((h) => h?.includes(OPS_BASE_PATH))).toBe(false);
  await page.screenshot({ path: path.join(EVIDENCE_DIR, "login.png"), fullPage: true });
});

test(`${OPS_BASE_PATH}/login renders the staff form (email + password), noindex`, async ({
  page,
}) => {
  const response = await page.goto(`${OPS_BASE_PATH}/login`);
  expect(response?.headers()["x-robots-tag"]).toContain("noindex");
  await expect(page.getByRole("textbox", { name: /email/i })).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await page.screenshot({ path: path.join(EVIDENCE_DIR, "ops-login.png"), fullPage: true });
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

// Full customer sign-in → portal, only when a local `wrangler dev` log is available (its stdout is
// the only place the OTP appears — `OTP_DEV_ECHO` is refused in production, by design) and an
// existing customer identity is named (sign-in never creates one: E2E_CUSTOMER_EMAIL, e.g. a
// member invited through the console). Skipped otherwise, including in the CI `e2e-smoke` job.
const otpLogPath = process.env.E2E_OTP_LOG_PATH;
const customerEmail = process.env.E2E_CUSTOMER_EMAIL;
test("customer signs in with an emailed code and lands on the portal (needs E2E_OTP_LOG_PATH, E2E_CUSTOMER_EMAIL)", async ({
  page,
}) => {
  test.skip(!otpLogPath || !customerEmail, "E2E_OTP_LOG_PATH / E2E_CUSTOMER_EMAIL not set");
  const email = customerEmail as string;

  await page.goto("/login");
  await page.getByRole("textbox", { name: /email/i }).fill(email);
  await page.getByRole("button", { name: "Continue" }).click();

  const code = await readEchoedOtp(otpLogPath as string, email);
  await page.locator("#otp").pressSequentially(code, { delay: 30 });

  await page.waitForURL(/\/portal/);
  await expect(page.getByText("Your tenants")).toBeVisible();
  await page.screenshot({ path: path.join(EVIDENCE_DIR, "portal.png"), fullPage: true });
});
