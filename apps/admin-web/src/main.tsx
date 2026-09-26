import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ApiError } from "./api/client";
import { createCustomerRouter } from "./portal/router";
import { routeTree } from "./routeTree.gen";
import "./index.css";

const dark = window.matchMedia("(prefers-color-scheme: dark)");
const applyScheme = () => document.documentElement.classList.toggle("dark", dark.matches);
applyScheme();
dark.addEventListener("change", applyScheme);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (count, error) =>
        count < 2 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
    },
  },
});

/**
 * Two surfaces, one bundle (owner decision): the Worker marks the staff console document with
 * `<meta name="cloudbox-ops-base">` only under OPS_BASE_PATH (apps/worker-api/src/ops-shell.ts).
 * With it, the staff router (file routes in src/routes) mounts under that base; without it, the
 * customer router (src/portal/router.tsx: /login, /portal) does.
 */
const opsBase = document
  .querySelector<HTMLMetaElement>('meta[name="cloudbox-ops-base"]')
  ?.content?.trim();

const router = createRouter({
  routeTree,
  context: { queryClient },
  basepath: opsBase || "/",
  defaultPreload: "intent",
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {opsBase ? (
          <RouterProvider router={router} />
        ) : (
          <RouterProvider router={createCustomerRouter(queryClient)} />
        )}
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
