// Owner: WT-1. Module `auth`, mounted at `/api/v1/auth` in routes/v1/index.ts.
// GET /session, POST /logout. Better Auth itself is mounted at /api/auth/* in src/index.ts, where
// POST /api/auth/sign-out is routed to the same audited logout below (one way out, always audited).
import type { SessionResponse } from "@cloudbox/contracts";
import { type Context, Hono } from "hono";
import { audit } from "../../audit";
import { authFor } from "../../auth";
import { getPrincipal, requireUser } from "../../auth/middleware";
import { createDb } from "../../db/client";
import type { AppEnv } from "../../env";
import { getActiveTenantId } from "./me";

const auth = new Hono<AppEnv>();

auth.get("/session", requireUser(), async (c) => {
  const principal = await getPrincipal(c);
  if (!principal) return c.json({ error: "unauthenticated" }, 401);
  const body: SessionResponse = {
    user: principal.user,
    permissions: [...principal.permissions].sort(),
    // WT-2: settings-style per-user row, re-validated against a live membership on every read.
    activeTenantId: await getActiveTenantId(createDb(c.env.DB), principal.user.id),
  };
  return c.json(body);
});

/** Revokes the session row through Better Auth, clears the cookie, audits AUTH_LOGOUT. 204. */
export async function logout(c: Context<AppEnv>) {
  const principal = await getPrincipal(c);
  if (!principal) return c.json({ error: "unauthenticated" }, 401);
  const { headers } = await authFor(c).api.signOut({
    headers: c.req.raw.headers,
    returnHeaders: true,
  });
  await audit(createDb(c.env.DB), {
    eventType: "AUTH_LOGOUT",
    entityType: "user",
    entityId: principal.user.id,
    actor: { type: "user", id: principal.user.id },
    before: { sessionId: principal.sessionId },
    after: null,
    correlationId: c.var.correlationId,
    source: "api",
  });
  const response = c.body(null, 204);
  for (const cookie of headers.getSetCookie()) response.headers.append("set-cookie", cookie);
  return response;
}

auth.post("/logout", requireUser(), logout);

export default auth;
