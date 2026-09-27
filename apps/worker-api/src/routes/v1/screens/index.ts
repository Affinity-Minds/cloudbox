// Owner: WT-0. One loader per screen, each ≤3 D1 round trips (fast-data-hydration).
// Screen owners add exactly one line here: tenants (WT-2), fleet (WT-3), subscriptions (WT-5).
import { Hono } from "hono";
import type { AppEnv } from "../../../env";
import alerts from "./alerts";
import audit from "./audit";
import backups from "./backups";
import fleet from "./fleet";
import overview from "./overview";
import plans from "./plans";
import releases from "./releases";
import subscriptions from "./subscriptions";
import tenants from "./tenants";

const screens = new Hono<AppEnv>();

screens.route("/overview", overview);
screens.route("/audit", audit);
screens.route("/fleet", fleet); // WT-3
screens.route("/tenants", tenants); // WT-2
screens.route("/subscriptions", subscriptions); // WT-5
screens.route("/plans", plans); // WT-13
screens.route("/backups", backups); // WT-19
screens.route("/alerts", alerts); // WT-17
screens.route("/releases", releases); // WT-18

export default screens;
