// Owner: WT-5. Module `entitlements`, mounted at `/api/v1/devices/:deviceId/entitlements`.
// GET / (history, never the token), POST /issue, POST /renew, POST /revoke.
import { IssueEntitlementRequest, RevokeEntitlementRequest } from "@cloudbox/contracts";
import { type Context, Hono } from "hono";
import { requirePermission } from "../../authz/permissions";
import { createDb } from "../../db/client";
import {
  EntitlementRefusal,
  issueForDevice,
  listEntitlementsForDevice,
  revokeForDevice,
} from "../../entitlement/service";
import type { AppEnv } from "../../env";
import { validate } from "./subscriptions";

const entitlements = new Hono<AppEnv>();

const deviceIdOf = (c: Context<AppEnv>) => c.req.param("deviceId") ?? "";
const actorOf = (c: Context<AppEnv>) => ({ id: c.var.user.id, correlationId: c.var.correlationId });

async function refusalAware(c: Context<AppEnv>, run: () => Promise<Response>) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof EntitlementRefusal) {
      return c.json(
        error.detail ? { error: error.code, detail: error.detail } : { error: error.code },
        error.status,
      );
    }
    throw error;
  }
}

entitlements.get("/", requirePermission("subscription.view"), async (c) =>
  c.json({ items: await listEntitlementsForDevice(createDb(c.env.DB), deviceIdOf(c)) }),
);

entitlements.post(
  "/issue",
  requirePermission("license.issue"),
  validate("json", IssueEntitlementRequest),
  (c) =>
    refusalAware(c, async () => {
      const result = await issueForDevice(c.env, createDb(c.env.DB), {
        deviceId: deviceIdOf(c),
        kind: "issue",
        validUntil: c.req.valid("json").validUntil,
        actor: actorOf(c),
      });
      return c.json(result, 201);
    }),
);

entitlements.post(
  "/renew",
  requirePermission("license.renew"),
  validate("json", IssueEntitlementRequest),
  (c) =>
    refusalAware(c, async () => {
      const result = await issueForDevice(c.env, createDb(c.env.DB), {
        deviceId: deviceIdOf(c),
        kind: "renew",
        validUntil: c.req.valid("json").validUntil,
        actor: actorOf(c),
      });
      return c.json(result, 201);
    }),
);

entitlements.post(
  "/revoke",
  requirePermission("license.revoke"),
  validate("json", RevokeEntitlementRequest),
  (c) =>
    refusalAware(c, async () => {
      const { reasonCode, reasonText } = c.req.valid("json");
      return c.json(
        await revokeForDevice(createDb(c.env.DB), {
          deviceId: deviceIdOf(c),
          reasonCode,
          reasonText,
          actor: actorOf(c),
        }),
      );
    }),
);

export default entitlements;
