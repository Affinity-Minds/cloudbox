import { defineConfig, devices } from "@playwright/test";

/**
 * Production/staging smoke suite (docs/plans/briefs/WT-6-qa-harness.md). Not part of `pnpm test`
 * — run explicitly with `pnpm --filter @cloudbox/e2e-cloud e2e`, or via the `workflow_dispatch`
 * `e2e-smoke` CI job. Targets a already-running deployment (`wrangler dev` locally, or a real
 * `BASE_URL`); this suite never starts a server itself.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:8787",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
