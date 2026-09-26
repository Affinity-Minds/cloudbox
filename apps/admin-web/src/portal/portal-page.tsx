// Owner: WT-2. Minimal tenant-side membership switch: list the caller's tenants, pick the active
// one. No sidebar shell — this is the outside-the-console surface (agent-notes ux-patterns
// "Two audiences, two front doors"): different host/screen than the staff console, same API.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { toast } from "sonner";
import { customerSessionQuery } from "@/api/auth";
import { describeError } from "@/api/client";
import { myTenantsQuery, setActiveTenant } from "@/api/tenants";
import { EmptyState, ErrorState, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

// Route (guard, prefetch) lives in portal/router.tsx: the customer surface's own router (WT-1).
export function PortalPage() {
  const queryClient = useQueryClient();
  const session = useQuery(customerSessionQuery);
  const tenants = useQuery(myTenantsQuery);

  const mutation = useMutation({
    mutationFn: (tenantId: string) => setActiveTenant(tenantId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: customerSessionQuery.queryKey });
      toast.success("Active tenant updated");
    },
    onError: (error) => {
      toast.error("Could not switch tenant", { description: describeError(error) });
    },
  });

  return (
    <main className="mx-auto max-w-lg pt-16">
      <PageHeader title="Your tenants" description="Pick which one you're working in." />
      <div className="border-x border-b">
        {tenants.isPending ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : tenants.isError ? (
          <ErrorState error={tenants.error} onRetry={() => tenants.refetch()} />
        ) : tenants.data.length === 0 ? (
          <EmptyState>
            You are not a member of any tenant yet. Ask a Tenant Owner or Admin to invite you by
            email, or CloudBox support if you're expecting access.
          </EmptyState>
        ) : (
          <ul>
            {tenants.data.map((tenant) => {
              const isActive = session.data?.activeTenantId === tenant.tenantId;
              return (
                <li
                  key={tenant.tenantId}
                  className="flex items-center justify-between gap-3 border-b px-4 py-3 last:border-b-0"
                >
                  <div>
                    <div className="font-medium">{tenant.displayName}</div>
                    <div className="text-xs text-muted-foreground">
                      {tenant.publicCode} · {tenant.standing}
                    </div>
                  </div>
                  {isActive ? (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Check className="size-3.5" /> Active
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={mutation.isPending}
                      onClick={() => mutation.mutate(tenant.tenantId)}
                    >
                      Set active
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
