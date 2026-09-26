// Owner: WT-1. Module `auth`, mounted at `/api/v1/auth` in routes/v1/index.ts.
// GET /session, POST /logout. Better Auth is mounted at /api/auth/* (customers) and /api/ops/auth/*
// (staff) in src/index.ts; each mount's sign-out is routed to the audited logout below.
import type { SessionResponse } from "@cloudbox/contracts";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { audit } from "../../audit";
import { authFor, customerAuthFor, type Surface } from "../../auth";
import {
  type Audience,
  getCustomerPrincipal,
  getPrincipal,
  getStaffPrincipal,
  guardFor,
} from "../../auth/middleware";
import { createDb } from "../../db/client";
import type { AppEnv } from "../../env";
import { getActiveTenantId } from "./me";

const auth = new Hono<AppEnv>();

/** `?as=staff` / `?as=customer` pins the identity system; without it, whichever is present. */
function audienceOf(c: Context<AppEnv>): Audience {
  const as = c.req.query("as");
  return as === "staff" || as === "customer" ? as : "either";
}

function sessionAudience(): MiddlewareHandler<AppEnv> {
  return (c, next) => guardFor(audienceOf(c), () => true, { allowSetupPending: true })(c, next);
}

auth.get("/session", sessionAudience(), async (c) => {
  const audience = audienceOf(c);
  const principal =
    audience === "staff"
      ? await getStaffPrincipal(c)
      : audience === "customer"
        ? await getCustomerPrincipal(c)
        : await getPrincipal(c);
  if (!principal) return c.json({ error: "unauthenticated" }, 401);
  const body: SessionResponse = {
    user: principal.user,
    permissions: [...principal.permissions].sort(),
    // WT-2: settings-style per-user row, re-validated against a live membership on every read.
    // Memberships belong to customer identities only.
    activeTenantId:
      principal.surface === "customer"
        ? await getActiveTenantId(createDb(c.env.DB), principal.user.id)
        : null,
    setup: principal.setup,
    surface: principal.surface,
  };
  return c.json(body);
});

/**
 * Revokes the session of one surface through its Better Auth instance, clears its cookie, audits
 * AUTH_LOGOUT. 204; 401 when the request has no session on that surface.
 */
export function logoutFor(surface: Surface | "current") {
  return async (c: Context<AppEnv>) => {
    const principal = await getPrincipal(c);
    const which = surface === "current" ? principal?.surface : surface;
    if (!principal || !which) return c.json({ error: "unauthenticated" }, 401);
    const instance = which === "staff" ? authFor(c) : customerAuthFor(c);
    const session = await instance.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "unauthenticated" }, 401);
    const { headers } = await instance.api.signOut({
      headers: c.req.raw.headers,
      returnHeaders: true,
    });
    await audit(createDb(c.env.DB), {
      eventType: "AUTH_LOGOUT",
      entityType: "user",
      entityId: session.user.id,
      actor: { type: "user", id: session.user.id },
      before: { sessionId: session.session.id, surface: which },
      after: null,
      correlationId: c.var.correlationId,
      source: "api",
    });
    const response = c.body(null, 204);
    for (const cookie of headers.getSetCookie()) response.headers.append("set-cookie", cookie);
    return response;
  };
}

auth.post("/logout", sessionAudience(), (c) => {
  const audience = audienceOf(c);
  return logoutFor(audience === "either" ? "current" : audience)(c);
});

export default auth;
