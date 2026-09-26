// Owner: WT-1. The customer surface's own router (owner decision: staff and customer surfaces are
// completely separate). Routes: /login (email → code), /portal (WT-2's tenant switch), / → /portal.
// The staff console is a different router, mounted only on documents the Worker marks as the ops
// shell (apps/worker-api/src/ops-shell.ts); nothing here links to it.
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
import { CustomerLoginPage } from "./customer-login";
import { PortalPage } from "./portal-page";

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

const portal = createRoute({
  getParentRoute: () => root,
  path: "/portal",
  beforeLoad: async ({ context }) => ({
    session: await requireCustomerSession(context.queryClient),
  }),
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(myTenantsQuery);
  },
  component: PortalPage,
});

export function createCustomerRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree: root.addChildren([index, login, portal]),
    context: { queryClient },
    defaultPreload: "intent",
    scrollRestoration: true,
  });
}
