# ADR 0001 — Monorepo and Cloudflare Worker origin

## Context
CloudBox contains a SaaS control plane, several Windows executables, shared contracts, infrastructure adapters, tests, and operating documentation. The production web origin is `box.affinityminds.in`.

## Decision
Use one monorepo. The production web app is a React/Vite SPA served as Cloudflare Worker static assets, with Hono handling `/api/*`. `box.affinityminds.in` is configured as a Worker Custom Domain. Static assets remain off the Worker execution path except for API routes.

## Alternatives considered
- Separate repositories for cloud and Windows components.
- SSR framework for the authenticated console.
- Cloudflare Pages plus a separate Worker API.

## Consequences
- One version stamp spans the cloud product.
- Static shell can load independently of D1.
- Shared contracts can be consumed by web and API packages.
- Windows releases remain separately versioned through OTA channels later.

## Verification / follow-up
- CI must build the admin SPA and Worker.
- Deployment must prove `/api/version` matches the deployed Git SHA.
- Later slices add D1, Durable Objects, R2, auth, and tenant isolation without moving the shell onto the database path.
