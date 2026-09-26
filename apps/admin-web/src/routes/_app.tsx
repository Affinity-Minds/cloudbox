// Shell: WT-0 (sidebar-07 from nav.ts). Auth guard: WT-1 adds `beforeLoad` redirecting to /login.
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppSidebar } from "@/components/app-sidebar";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";

export const Route = createFileRoute("/_app")({
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
