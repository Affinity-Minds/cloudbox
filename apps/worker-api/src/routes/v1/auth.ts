// Owner: WT-1. Module `auth`, mounted at `/api/v1/auth` in routes/v1/index.ts.
// GET /session, POST /logout. Better Auth is mounted at /api/auth/* (customers) and /api/ops/auth/*
// (staff) in src/index.ts; each mount's sign-out is routed to the audited logout below.
import type { SessionResponse } from "@cloudbox/contracts";
import { type Context, Hono } from "hono";
import { audit } from "../../audit";
import { authFor, customerAuthFor, type Surface } from "../../auth";
import { getPrincipal, requireUser } from "../../auth/middleware";
import { createDb } from "../../db/client";
import type { AppEnv } from "../../env";
import { getActiveTenantId } from "./me";

const auth = new Hono<AppEnv>();

auth.get("/session", requireUser({ allowSetupPending: true }), async (c) => {
  const principal = await getPrincipal(c);
  if (!principal) return c.json({ error: "unauthenticated" }, 401);
  const body: SessionResponse = {
    user: principal.user,
    permissions: [...principal.permissions].sort(),
    // WT-2: settings-style per-user row, re-validated against a live membership on every read.
    activeTenantId: await getActiveTenantId(createDb(c.env.DB), principal.user.id),
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

auth.post("/logout", requireUser({ allowSetupPending: true }), logoutFor("current"));

export default auth;
