// Owner: WT-18. Mounted at /api/v1/releases (routes/v1/index.ts). Middleware is per-route, never
// `use("*")` on this file's own prefix, because two very different callers share it: staff routes
// (upload/promote/withdraw/assignments, `requirePermission`) and the device-facing manifest routes
// (`GET /assigned`, `POST /:id/result`, `GET /:id/download`), gated by WT-3's `requireDevice()`.
import {
  CreateAssignmentRequest,
  PromoteReleaseRequest,
  ReleaseComponent,
  ReportReleaseResultRequest,
  UploadReleaseFields,
  WithdrawReleaseRequest,
} from "@cloudbox/contracts";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { requirePermission } from "../../authz/permissions";
import { createDb } from "../../db/client";
import { releases as releasesTable } from "../../db/schema";
import { requireDevice } from "../../devices/require-device";
import type { AppEnv } from "../../env";
import {
  AssignmentRefusal,
  createAssignment,
  deleteAssignment,
  listAssignments,
} from "../../releases/assignments";
import { signDownloadToken, verifyDownloadToken } from "../../releases/download-token";
import { resolveAssignedRelease } from "../../releases/resolve";
import { recordResult } from "../../releases/results";
import {
  createRelease,
  promoteRelease,
  ReleaseRefusal,
  withdrawRelease,
} from "../../releases/service";
import { MAX_PACKAGE_BYTES } from "../../releases/upload";
import { validate } from "./subscriptions";

const releases = new Hono<AppEnv>();

type Refusal = ReleaseRefusal | AssignmentRefusal;

async function refusalAware(c: Context<AppEnv>, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ReleaseRefusal || error instanceof AssignmentRefusal) {
      const refusal = error as Refusal;
      return c.json(
        refusal.detail ? { error: refusal.code, detail: refusal.detail } : { error: refusal.code },
        refusal.status,
      );
    }
    throw error;
  }
}

const actorOf = (c: Context<AppEnv>) => ({ id: c.var.user.id, correlationId: c.var.correlationId });

// ─── staff: upload ────────────────────────────────────────────────────────────────────────────

releases.post("/", requirePermission("update.release"), (c) =>
  refusalAware(c, async () => {
    // Cheap, pre-parse cap: the platform still has to materialise the multipart body to hand back
    // a `File` (agent-notes cloudflare-workers #18 — Workers has no incremental multipart parser),
    // so this only saves the parse cost for an obviously oversized request; `createRelease` checks
    // the parsed file's actual size again regardless.
    const contentLength = Number(c.req.header("content-length") ?? "");
    if (Number.isFinite(contentLength) && contentLength > MAX_PACKAGE_BYTES) {
      return c.json(
        { error: "package_too_large", detail: `cap is ${MAX_PACKAGE_BYTES} bytes` },
        413,
      );
    }

    let body: Record<string, string | File>;
    try {
      body = await c.req.parseBody();
    } catch {
      return c.json({ error: "invalid_request", detail: "not a valid multipart body" }, 400);
    }
    const { file, ...fields } = body;
    if (!(file instanceof File)) {
      return c.json({ error: "invalid_request", detail: "file is required" }, 400);
    }
    const parsedFields = UploadReleaseFields.safeParse(fields);
    if (!parsedFields.success) {
      return c.json(
        {
          error: "invalid_request",
          detail: parsedFields.error.issues.map((i) => ({ path: i.path, message: i.message })),
        },
        400,
      );
    }

    const { release } = await createRelease(c.env, createDb(c.env.DB), {
      fields: parsedFields.data,
      file,
      actor: actorOf(c),
    });
    return c.json({ release }, 201);
  }),
);

releases.post(
  "/:id/promote",
  requirePermission("update.release"),
  validate("json", PromoteReleaseRequest),
  (c) =>
    refusalAware(c, async () => {
      const release = await promoteRelease(createDb(c.env.DB), {
        id: c.req.param("id"),
        channel: c.req.valid("json").channel,
        actor: actorOf(c),
      });
      return c.json({ release });
    }),
);

releases.post(
  "/:id/withdraw",
  requirePermission("update.release"),
  validate("json", WithdrawReleaseRequest),
  (c) =>
    refusalAware(c, async () => {
      const release = await withdrawRelease(createDb(c.env.DB), {
        id: c.req.param("id"),
        reason: c.req.valid("json").reason,
        actor: actorOf(c),
      });
      return c.json({ release });
    }),
);

// ─── staff: assignments (update.deploy) ──────────────────────────────────────────────────────

releases.get("/:id/assignments", requirePermission("update.deploy"), (c) =>
  refusalAware(c, async () =>
    c.json({ items: await listAssignments(createDb(c.env.DB), c.req.param("id")) }),
  ),
);

releases.post(
  "/:id/assignments",
  requirePermission("update.deploy"),
  validate("json", CreateAssignmentRequest),
  (c) =>
    refusalAware(c, async () => {
      const body = c.req.valid("json");
      const assignment = await createAssignment(createDb(c.env.DB), {
        releaseId: c.req.param("id"),
        scope: body.scope,
        deviceId: body.deviceId,
        tenantId: body.tenantId,
        percent: body.percent,
        actor: actorOf(c),
      });
      return c.json({ assignment }, 201);
    }),
);

releases.delete("/:id/assignments/:assignmentId", requirePermission("update.deploy"), (c) =>
  refusalAware(c, async () => {
    await deleteAssignment(createDb(c.env.DB), {
      releaseId: c.req.param("id"),
      assignmentId: c.req.param("assignmentId"),
      actor: actorOf(c),
    });
    return c.body(null, 204);
  }),
);

// ─── device-facing (Bearer device token, WT-3 requireDevice()) ──────────────────────────────

const AssignedQuery = z.object({ component: ReleaseComponent });

releases.get("/assigned", requireDevice(), validate("query", AssignedQuery), (c) =>
  refusalAware(c, async () => {
    const db = createDb(c.env.DB);
    const release = await resolveAssignedRelease(db, {
      deviceId: c.var.device.id,
      tenantId: c.var.device.tenantId,
      component: c.req.valid("query").component,
    });
    if (!release) return c.json({ error: "not_found" }, 404);

    const { token, exp } = await signDownloadToken(c.env, {
      releaseId: release.id,
      deviceId: c.var.device.id,
    });
    const downloadUrl = `/api/v1/releases/${release.id}/download?exp=${exp}&token=${token}`;

    const response = c.json({
      releaseId: release.id,
      manifest: JSON.parse(release.manifestJson),
      manifestJws: release.manifestJws,
      downloadUrl,
      downloadExpiresAt: new Date(exp * 1000).toISOString(),
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  }),
);

releases.get("/:id/download", requireDevice(), (c) =>
  refusalAware(c, async () => {
    const exp = Number(c.req.query("exp") ?? "");
    const token = c.req.query("token") ?? "";
    const ok = await verifyDownloadToken(c.env, {
      releaseId: c.req.param("id"),
      deviceId: c.var.device.id,
      exp,
      token,
    });
    if (!ok) return c.json({ error: "unauthenticated" }, 401);

    const db = createDb(c.env.DB);
    const [release] = await db
      .select({ r2Key: releasesTable.packageR2Key, status: releasesTable.status })
      .from(releasesTable)
      .where(eq(releasesTable.id, c.req.param("id")));
    if (!release || release.status === "withdrawn") return c.json({ error: "not_found" }, 404);

    const object = await c.env.ARTIFACTS.get(release.r2Key);
    if (!object) return c.json({ error: "not_found" }, 404);
    return new Response(object.body, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(object.size),
        "cache-control": "no-store",
      },
    });
  }),
);

releases.post("/:id/result", requireDevice(), validate("json", ReportReleaseResultRequest), (c) =>
  refusalAware(c, async () => {
    const body = c.req.valid("json");
    const result = await recordResult(createDb(c.env.DB), {
      releaseId: c.req.param("id"),
      deviceId: c.var.device.id,
      state: body.state,
      detail: body.detail,
    });
    return c.json(result, 201);
  }),
);

export default releases;
