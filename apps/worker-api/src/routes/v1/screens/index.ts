// Owner: WT-0. One loader per screen, each ≤3 D1 round trips (fast-data-hydration).
// Screen owners add exactly one line here: tenants (WT-2), fleet (WT-3), subscriptions (WT-5).
import { Hono } from "hono";
import type { AppEnv } from "../../../env";
import audit from "./audit";
import overview from "./overview";

const screens = new Hono<AppEnv>();

screens.route("/overview", overview);
screens.route("/audit", audit);

export default screens;
