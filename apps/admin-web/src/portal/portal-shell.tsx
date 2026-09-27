// Owner: WT-15. The portal's own chrome: no sidebar, no console density (agent-notes ux-patterns
// "Two audiences, two front doors") — a tenant switcher, a handful of tabs, and the signed-in
// email. Every page under it reads the active tenant from the session, never from local state, so
// a switch here is visible everywhere immediately.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
// `Link`/`useNavigate` type-check against the *ops console's* registered router (main.tsx's
// `Register.router`), so — exactly like the pre-existing customer-surface files
// (customer-login.tsx, start-page.tsx, tenant-cards.tsx) — this file uses plain `<a href>` and
// `useRouter().history` for its own (customer-only) paths instead.
import { Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { Check, ChevronDown, LogOut } from "lucide-react";
import { toast } from "sonner";
import { customerSessionQuery, logout } from "@/api/auth";
import { describeError } from "@/api/client";
import { myTenantsQuery, setActiveTenant } from "@/api/tenants";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const TABS = [
  { to: "/portal", label: "Home" },
  { to: "/portal/cloudboxes", label: "CloudBoxes" },
  { to: "/portal/members", label: "Members" },
  { to: "/portal/subscription", label: "Subscription" },
  { to: "/portal/activate", label: "Activate a server" },
] as const;

function TenantSwitcher() {
  const session = useQuery(customerSessionQuery);
  const tenants = useQuery(myTenantsQuery);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (tenantId: string) => setActiveTenant(tenantId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: customerSessionQuery.queryKey }),
    onError: (error) =>
      toast.error("Could not switch tenant", { description: describeError(error) }),
  });

  const active = tenants.data?.find((t) => t.tenantId === session.data?.activeTenantId);
  const only = tenants.data?.length === 1 ? tenants.data[0] : undefined;
  if (!tenants.data || tenants.data.length === 0) return null;

  // A single tenant: show the name plainly, no dropdown to open.
  if (only) {
    return <span className="text-sm font-medium">{active?.displayName ?? only.displayName}</span>;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5 font-medium">
          {active?.displayName ?? "Pick an organisation"}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {tenants.data.map((tenant) => (
          <DropdownMenuItem
            key={tenant.tenantId}
            onSelect={() => {
              if (tenant.tenantId !== session.data?.activeTenantId)
                mutation.mutate(tenant.tenantId);
            }}
            className="flex items-center justify-between gap-2"
          >
            <span className="min-w-0 truncate">
              {tenant.displayName}
              <span className="ml-1.5 text-xs text-muted-foreground">{tenant.publicCode}</span>
            </span>
            {tenant.tenantId === session.data?.activeTenantId ? (
              <Check className="size-3.5 shrink-0" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function PortalShell() {
  const session = useQuery(customerSessionQuery);
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const hasActiveTenant = Boolean(session.data?.activeTenantId);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between gap-4 px-4">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold tracking-tight">CloudBox</span>
            <TenantSwitcher />
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-muted-foreground sm:inline">
              {session.data?.user.email}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                await logout("customer").catch(() => undefined);
                router.history.replace("/login");
              }}
            >
              <LogOut />
              Sign out
            </Button>
          </div>
        </div>
        <nav className="mx-auto flex max-w-3xl gap-1 overflow-x-auto px-4">
          {TABS.map((tab) => {
            const isActive =
              tab.to === "/portal" ? pathname === "/portal" : pathname.startsWith(tab.to);
            const disabled = !hasActiveTenant && tab.to !== "/portal";
            return (
              <a
                key={tab.to}
                href={tab.to}
                onClick={(event) => {
                  if (disabled) {
                    event.preventDefault();
                    return;
                  }
                  event.preventDefault();
                  router.history.push(tab.to);
                }}
                aria-disabled={disabled}
                aria-current={isActive ? "page" : undefined}
                className={`whitespace-nowrap rounded-t-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground aria-disabled:pointer-events-none aria-disabled:opacity-40 ${
                  isActive ? "border-b-2 border-foreground font-medium text-foreground" : ""
                }`}
              >
                {tab.label}
              </a>
            );
          })}
        </nav>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
