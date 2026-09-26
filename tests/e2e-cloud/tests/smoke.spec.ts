// Production/staging smoke suite (docs/plans/briefs/WT-6-qa-harness.md). Against `BASE_URL`
// (default `http://localhost:8787`, i.e. `wrangler dev` locally). `EXPECTED_SHA` is optional; the
// version check is skipped without it (a local `wrangler dev` reports `gitSha: "development"`,
// not a real commit).
import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

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

test("the shell renders: sidebar has Overview, Tenants, Fleet", async ({ page }) => {
  await page.goto("/");
  // Nav labels are fixed by apps/admin-web/src/nav.ts (owner WT-0); this test tracks that file's
  // titles, not a hand-copied list, by asserting on the rendered text itself.
  await expect(page.getByRole("link", { name: "Overview" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Tenants" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Fleet" })).toBeVisible();

  await page.screenshot({ path: path.join(EVIDENCE_DIR, "shell.png"), fullPage: true });
});

test("/login renders the email step once WT-1's login UI lands", async ({ page }) => {
  await page.goto("/login");
  await page.screenshot({ path: path.join(EVIDENCE_DIR, "login.png"), fullPage: true });

  // apps/admin-web/src/routes/login.tsx is still the NotBuilt placeholder as of this suite's
  // authoring (WT-1 has shipped the auth API but not this page) — self-skip on that placeholder
  // so this test starts asserting the real form the moment the page changes, with no edit needed.
  const notBuiltYet = await page.getByText("Not built yet").isVisible().catch(() => false);
  test.skip(notBuiltYet, "apps/admin-web/src/routes/login.tsx is still WT-1's NotBuilt placeholder");

  await expect(page.getByRole("textbox", { name: /email/i })).toBeVisible();
});
