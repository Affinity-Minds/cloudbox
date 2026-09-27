// Owner: WT-10. CloudBox Server Setup sign-in hand-off (docs/slices/5.1-server-setup.md).
// Mounted with one line in routes/v1/index.ts at `/onboarding/setup` (customer-only prefix).
//
//   GET /onboarding/setup/complete   customer session   tiny page that tells the Setup app's
//                                                      WebView2 "signed in" via postMessage
//
// The Setup app renders `/start` (Turnstile + code) in an embedded WebView2. When the start-path
// verify succeeds it navigates the WebView here. This page proves the session server-side and posts
// `{type: "cloudbox.setup.signed-in", email}` to the host. The session cookie itself is HttpOnly and
// never enters page script: the app reads it from the WebView2 cookie manager and continues natively.
import { Hono } from "hono";
import { requireUser } from "../../auth/middleware";
import type { AppEnv } from "../../env";

export const SETUP_SIGNED_IN_MESSAGE = "cloudbox.setup.signed-in";

const setup = new Hono<AppEnv>();

setup.get("/complete", requireUser(), (c) => {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  // JSON inside a <script>: escape `<` so an address can never close the element.
  const message = JSON.stringify({
    type: SETUP_SIGNED_IN_MESSAGE,
    email: c.var.user.email,
  }).replaceAll("<", "\\u003c");
  c.header("Cache-Control", "no-store");
  c.header(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; frame-ancestors 'none'`,
  );
  c.header("Referrer-Policy", "no-referrer");
  return c.html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>CloudBox Setup</title></head>
<body style="font-family:Segoe UI,system-ui,sans-serif;margin:48px;color:#1f2937">
<h1 style="font-size:20px">Signed in</h1>
<p>Return to CloudBox Server Setup to choose your organisation.</p>
<script nonce="${nonce}">window.chrome && window.chrome.webview && window.chrome.webview.postMessage(${message});</script>
</body></html>`);
});

export default setup;
