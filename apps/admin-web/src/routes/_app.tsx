// Shell: WT-0 (sidebar-07 from nav.ts). Auth guard: WT-1 (`beforeLoad` → /login without a session).
// The guard only routes the browser; every API call is authorised server-side regardless.
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { requireSession } from "@/auth/session";
import { AppSidebar } from "@/components/app-sidebar";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context, location }) => ({
    session: await requireSession(context.queryClient, location.href),
  }),
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
