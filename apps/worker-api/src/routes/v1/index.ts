// Owner: WT-0. The /api/v1 route index. Each owner adds exactly one line for a new module.
// Mount prefixes nest (`/tenants` and `/tenants/:tenantId/memberships`), so a module must attach
// middleware per route, never with `use("*")`, or it would run for its neighbours too.
import { Hono } from "hono";
import { requireStaff } from "../../auth/middleware";
import type { AppEnv } from "../../env";
import agent from "./agent";
import alerts, { alertsSettings } from "./alerts";
import audit from "./audit";
import auth from "./auth";
import backups, { meBackups, tenantBackupPolicy } from "./backups";
import devices from "./devices";
import emailProviders from "./email-providers";
import enrollment from "./enrollment";
import entitlements from "./entitlements";
import me from "./me";
import meAlerts from "./me-alerts";
import memberships from "./memberships";
import portal from "./portal";
import realtime from "./realtime";
import releases from "./releases";
import screens from "./screens";
import selfService from "./self-service";
import setup from "./setup";
import staff from "./staff";
import subscriptions, { plans, tenantSubscriptions } from "./subscriptions";
import tenants from "./tenants";

const v1 = new Hono<AppEnv>();

v1.get("/", (c) => c.json({ name: "CloudBox API", version: "v1", status: "foundation" }));

// Stub guard (review M-1, WT-1 with WT-0's leave): a module that is still a stub answers only to
// staff, so a stub filled in later without its own guard cannot ship open. Exact paths, not
// wildcards; the owner deletes its line when the real, guarded router lands.
for (const stub of [
  "/audit", // WT-0
]) {
  v1.use(stub, requireStaff());
}

v1.route("/auth", auth); // WT-1
v1.route("/staff", staff); // WT-1
v1.route("/tenants", tenants); // WT-2
v1.route("/tenants/:tenantId/memberships", memberships); // WT-2
v1.route("/tenants/:tenantId/portal", portal); // WT-15
v1.route("/me", me); // WT-2
v1.route("/me", meAlerts); // WT-17: GET /me/alerts, same mount, second small router (see its file)
v1.route("/tenants/:tenantId/enrollment-tokens", enrollment); // WT-3
v1.route("/devices", devices); // WT-3
v1.route("/agent", agent); // WT-3
v1.route("/plans", plans); // WT-5
v1.route("/tenants/:tenantId/subscriptions", tenantSubscriptions); // WT-5
v1.route("/subscriptions", subscriptions); // WT-5
v1.route("/devices/:deviceId/entitlements", entitlements); // WT-5
v1.route("/settings/email-providers", emailProviders); // WT-12
v1.route("/realtime", realtime); // WT-16
v1.route("/backups", backups); // WT-19
v1.route("/tenants/:tenantId/backup-policy", tenantBackupPolicy); // WT-19
v1.route("/me/backups", meBackups); // WT-19
v1.route("/settings/alerts", alertsSettings); // WT-17
v1.route("/alerts", alerts); // WT-17
v1.route("/releases", releases); // WT-18
v1.route("/screens", screens); // WT-0 (+ one line per screen owner in screens/index.ts)
v1.route("/audit", audit); // WT-0
v1.route("/", selfService); // WT-14: /onboarding/*, /connect/*, /license-keys/*
v1.route("/onboarding/setup", setup); // WT-10: Server Setup sign-in hand-off page

export default v1;
