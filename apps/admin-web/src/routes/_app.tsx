// Shell: WT-0 (sidebar-07 from nav.ts). Auth guard: WT-1 (`beforeLoad` → /login without a session).
// The guard only routes the browser; every API call is authorised server-side regardless.
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { pendingSetupPath, requireSession } from "@/auth/session";
import { AppSidebar } from "@/components/app-sidebar";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context, location }) => {
    const session = await requireSession(context.queryClient, location.href);
    // Staff must replace the initial password and enrol an authenticator first (ADR 0009); the
    // server refuses staff routes until then anyway (403 setup_required).
    const setup = pendingSetupPath(session);
    if (setup) throw redirect({ to: setup });
    return { session };
  },
  component: AppShell,
});

function AppShell() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <header className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
          <span className="text-xs text-muted-foreground">CloudBox control plane</span>
        </header>
        <div className="min-w-0 flex-1">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
