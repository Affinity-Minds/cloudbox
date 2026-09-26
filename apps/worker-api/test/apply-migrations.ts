import { applyD1Migrations, env } from "cloudflare:test";

// Every test file starts from the full migration chain in infra/cloudflare/migrations.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
