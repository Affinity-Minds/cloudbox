import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrationsDir = fileURLToPath(new URL("../../infra/cloudflare/migrations", import.meta.url));

export default defineConfig(async () => {
  const migrations = await readD1Migrations(migrationsDir);

  return {
    plugins: [
      cloudflareTest({
        main: "./src/index.ts",
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // The pool's workerd is older than wrangler's; pin a date it supports (agent-notes #15).
          compatibilityDate: "2026-08-01",
          d1Databases: ["DB", "UPGRADE_DB"],
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      exclude: ["**/node_modules/**", "**/.claude/**", "**/.worktrees/**", "**/dist/**"],
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
