// Owner: WT-0. sidebar-07 shell driven by nav.ts; build stamp from /api/version in the footer.
// Signed-in user menu with logout (WT-1, src/auth/user-menu.tsx) sits above the build stamp.
import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { Box } from "lucide-react";
import type * as React from "react";
import { versionQuery } from "@/api/system";
import { UserMenu } from "@/auth/user-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { shortSha } from "@/lib/time";
import { NAV_GROUPS, type NavItem } from "@/nav";

function isActive(pathname: string, item: NavItem) {
  return item.to === "/"
    ? pathname === "/"
    : pathname === item.to || pathname.startsWith(`${item.to}/`);
}

function BuildStamp() {
  const version = useQuery(versionQuery);
  const label = version.isError
    ? "build unknown"
    : version.data
      ? `${shortSha(version.data.gitSha)} · ${version.data.environment}`
      : "loading build…";
  return (
    <div
      className="truncate px-2 font-mono text-[11px] text-muted-foreground group-data-[collapsible=icon]:hidden"
      title={version.data ? `${version.data.gitSha} built ${version.data.builtAt}` : undefined}
    >
      {label}
    </div>
  );
}

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/">
                <div className="flex aspect-square size-8 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
                  <Box className="size-4" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">CloudBox</span>
                  <span className="truncate text-xs text-muted-foreground">Control plane</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarMenu>
              {group.items.map((item) => (
                <SidebarMenuItem key={item.key}>
                  <SidebarMenuButton
                    asChild
                    isActive={isActive(pathname, item)}
                    tooltip={item.title}
                  >
                    <Link to={item.to}>
                      <item.icon />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <UserMenu />
        <BuildStamp />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
