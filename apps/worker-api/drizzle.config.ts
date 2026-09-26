import { defineConfig } from "drizzle-kit";

// `pnpm db:generate` diffs src/db/schema.ts against infra/cloudflare/migrations/meta and writes
// the next SQL file there. Rename it to your reserved number (see docs/handoffs/foundation.md).
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "../../infra/cloudflare/migrations",
});
