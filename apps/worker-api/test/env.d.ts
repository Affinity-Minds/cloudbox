import type { D1Migration } from "cloudflare:test";
import type { Bindings } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends Bindings {
      TEST_MIGRATIONS: D1Migration[];
      /** Empty D1 used by upgrade tests to start from a previous release's schema. */
      UPGRADE_DB: D1Database;
    }
  }
}
