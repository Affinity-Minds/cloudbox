// Owner: WT-1 (login/start/shell), WT-15 (portal's own tabs). The customer surface's own router
// (owner decision: staff and customer surfaces are completely separate). Routes: /login (email →
// code), /start (WT-14 self-service onboarding), /portal/* (WT-15: Home, CloudBoxes, Members,
// Subscription, Activate a server — a layout route with its own shell, not the staff console's
// file-based routes), / → /portal.
// The staff console is a different router, mounted only on documents the Worker marks as the ops
// shell (apps/worker-api/src/ops-shell.ts); nothing here links to it.
//
// WT-15 deviation from the brief's "TanStack file routes routes/portal/*": the customer surface is
// a second, code-based `createRouter` instance (not the file-based generator that produces
// routeTree.gen.ts for the ops console), because the two surfaces must never share a route tree —
// see ops-shell.ts and main.tsx's "two surfaces, one bundle" comment. Putting files under
// src/routes/portal/* would feed them into the *ops console's* generated tree instead. The portal's
// own page components still live in their own files (src/portal/*-page.tsx), just registered here
// with `createRoute`, exactly as WT-1 already did for /login, /start and /portal.
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { myTenantsQuery } from "@/api/tenants";
import { requireCustomerSession } from "@/auth/session";
import { ActivatePage } from "./activate-page";
import { CloudBoxesPage } from "./cloudboxes-page";
import { CustomerLoginPage } from "./customer-login";
import { HomePage } from "./home-page";
import { MembersPage } from "./members-page";
import { PortalShell } from "./portal-shell";
import { StartPage } from "./start-page";
import { SubscriptionPage } from "./subscription-page";

function NotFound() {
  return (
    <div className="p-6 text-sm">
      <p className="font-medium">Page not found</p>
      <a href="/" className="text-muted-foreground underline underline-offset-4">
        Back to CloudBox
      </a>
    </div>
  );
}

const root = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Outlet,
  notFoundComponent: NotFound,
});

const index = createRoute({
  getParentRoute: () => root,
  path: "/",
  beforeLoad: () => {
    throw redirect({ href: "/portal" });
  },
});

const login = createRoute({
  getParentRoute: () => root,
  path: "/login",
  component: CustomerLoginPage,
});

// WT-14 (ADR 0011): self-service onboarding. Public; the page itself asks for email + code.
const start = createRoute({
  getParentRoute: () => root,
  path: "/start",
  component: StartPage,
});

const portal = createRoute({
  getParentRoute: () => root,
  path: "/portal",
  beforeLoad: async ({ context }) => ({
    session: await requireCustomerSession(context.queryClient),
  }),
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(myTenantsQuery);
  },
  component: PortalShell,
});

const portalHome = createRoute({ getParentRoute: () => portal, path: "/", component: HomePage });
const portalCloudBoxes = createRoute({
  getParentRoute: () => portal,
  path: "/cloudboxes",
  component: CloudBoxesPage,
});
const portalMembers = createRoute({
  getParentRoute: () => portal,
  path: "/members",
  component: MembersPage,
});
const portalSubscription = createRoute({
  getParentRoute: () => portal,
  path: "/subscription",
  component: SubscriptionPage,
});
const portalActivate = createRoute({
  getParentRoute: () => portal,
  path: "/activate",
  component: ActivatePage,
});

export function createCustomerRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree: root.addChildren([
      index,
      login,
      start,
      portal.addChildren([
        portalHome,
        portalCloudBoxes,
        portalMembers,
        portalSubscription,
        portalActivate,
      ]),
    ]),
    context: { queryClient },
    defaultPreload: "intent",
    scrollRestoration: true,
  });
}
