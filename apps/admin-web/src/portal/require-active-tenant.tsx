// Owner: WT-15. CloudBoxes/Members/Subscription/Activate all need one tenant in context; the
// active tenant (never local component state) is that context, so switching it in the shell's
// header is visible on whichever of these pages is open. Honest empty state when there is none.
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { customerSessionQuery } from "@/api/auth";
import { EmptyState } from "@/components/page";
import { Skeleton } from "@/components/ui/skeleton";

export function useActiveTenantId(): { tenantId: string | null; isPending: boolean } {
  const session = useQuery(customerSessionQuery);
  return { tenantId: session.data?.activeTenantId ?? null, isPending: session.isPending };
}

/** Wraps a tenant-scoped page: loading skeleton, or the honest "pick/create one" empty state. */
export function RequireActiveTenant({ children }: { children: (tenantId: string) => ReactNode }) {
  const { tenantId, isPending } = useActiveTenantId();
  if (isPending) return <Skeleton className="h-24 w-full" />;
  if (!tenantId) {
    return (
      <EmptyState>
        You don't have an active organisation yet. Pick one from the switcher above, or{" "}
        <a href="/start" className="underline underline-offset-4">
          create one
        </a>
        .
      </EmptyState>
    );
  }
  return <>{children(tenantId)}</>;
}
