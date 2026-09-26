import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Link, Outlet } from "@tanstack/react-router";

export type RouterContext = { queryClient: QueryClient };

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: () => (
    <div className="p-6 text-sm">
      <p className="font-medium">Page not found</p>
      <Link to="/" className="text-muted-foreground underline underline-offset-4">
        Back to overview
      </Link>
    </div>
  ),
});
