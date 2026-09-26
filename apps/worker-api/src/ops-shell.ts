// Owner: WT-1. The discreet staff console (owner decision): the SPA's staff surface lives under
// OPS_BASE_PATH. Only a document requested at a known console route under that base is marked as
// the ops shell (a meta tag the SPA reads to mount the staff router) and served with
// `X-Robots-Tag: noindex`. Everything else — including unknown paths under the base — is the
// ordinary SPA document, byte for byte, so probing cannot confirm the base. Customer surfaces
// never link to it, and no robots.txt entry advertises it.
import type { Context } from "hono";
import type { AppEnv, Bindings } from "./env";

export const DEFAULT_OPS_BASE_PATH = "/ops";
const VALID_BASE = /^\/[A-Za-z0-9_-]{1,128}$/;

/** First segments the Worker or the customer SPA already own (review W-1): never an ops base. */
const RESERVED_BASES = new Set(["/api", "/assets", "/login", "/portal", "/start"]);

/**
 * The configured base, or the default when unset, malformed (never a multi-segment path) or
 * colliding with a path the Worker or the customer surface already serves (review W-1).
 */
export function opsBasePath(env: Pick<Bindings, "OPS_BASE_PATH">): string {
  const base = env.OPS_BASE_PATH?.trim();
  return base && VALID_BASE.test(base) && !RESERVED_BASES.has(base.toLowerCase())
    ? base
    : DEFAULT_OPS_BASE_PATH;
}

/** Console routes of the staff SPA (apps/admin-web/src/routes), relative to the base. */
const OPS_ROUTES =
  /^(?:\/|\/login|\/setup-password|\/setup-authenticator|\/tenants(?:\/[^/]+)?|\/fleet(?:\/[^/]+)?|\/enrollment|\/subscriptions(?:\/[^/]+)?|\/licences|\/audit|\/settings)\/?$/;

export function isOpsDocument(pathname: string, base: string): boolean {
  if (pathname === base) return true;
  if (!pathname.startsWith(`${base}/`)) return false;
  return OPS_ROUTES.test(pathname.slice(base.length));
}

const escapeAttr = (value: string) => value.replace(/[&"<>]/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** Non-API requests: static assets and the SPA document (with the ops marker where it belongs). */
export async function serveAsset(c: Context<AppEnv>): Promise<Response> {
  const url = new URL(c.req.url);
  const base = opsBasePath(c.env);
  if (c.req.method !== "GET" || !isOpsDocument(url.pathname, base)) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  const shell = await c.env.ASSETS.fetch(new Request(new URL("/", url), c.req.raw));
  const headers = new Headers(shell.headers);
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("Cache-Control", "no-store");
  headers.delete("ETag");
  headers.delete("Content-Length");
  const marked = new Response(shell.body, { status: shell.status, headers });
  return new HTMLRewriter()
    .on("head", {
      element(head) {
        head.append(
          `<meta name="robots" content="noindex, nofollow"><meta name="cloudbox-ops-base" content="${escapeAttr(base)}">`,
          { html: true },
        );
      },
    })
    .transform(marked);
}
