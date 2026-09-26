import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./env";

const CORRELATION_HEADER = "X-Correlation-Id";
const REQUEST_ID_HEADER = "X-Request-Id";
const VALID_CORRELATION_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Responses from the assets binding or a Durable Object stub have immutable headers
 * (agent-notes cloudflare-workers "immutable responses"): copy before adding headers.
 */
function setHeaders(response: Response, headers: Record<string, string>): Response {
  try {
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    return response;
  } catch {
    const copy =
      response.status === 101
        ? new Response(null, {
            status: 101,
            webSocket: response.webSocket,
            headers: new Headers(response.headers),
          })
        : new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: new Headers(response.headers),
          });
    for (const [name, value] of Object.entries(headers)) copy.headers.set(name, value);
    return copy;
  }
}

/**
 * The correlation id stored in audit rows is always minted here: a client cannot plant ids that
 * collide with real requests (review L-3). A well-formed inbound `X-Correlation-Id` is only echoed
 * back on the response for the caller's own tracing; `X-Request-Id` carries the server id.
 */
export const correlationId = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const inbound = c.req.header(CORRELATION_HEADER);
  const id = crypto.randomUUID();
  c.set("correlationId", id);
  await next();
  c.res = setHeaders(c.res, {
    [CORRELATION_HEADER]: inbound && VALID_CORRELATION_ID.test(inbound) ? inbound : id,
    [REQUEST_ID_HEADER]: id,
  });
};

/** Every `/api/v1/*` response carries `X-API-Version: v1`. */
export const apiVersion = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  await next();
  c.res = setHeaders(c.res, { "X-API-Version": "v1" });
};
