// Owner: WT-15. Portal Subscription: plan, validity, effective users (incl. add-ons), price.
// Read-only for every standing — there is no customer-facing self-service billing yet, only the
// staff-managed subscription this reads. Reuses WT-5/WT-13's pills and money formatting.
import { useQuery } from "@tanstack/react-query";
import { portalSubscriptionQuery } from "@/api/portal";
import { EmptyState, ErrorState, PageHeader } from "@/components/page";
import { formatMoney } from "@/components/plan-bits";
import { ExpiryPill, KeyValue, SubscriptionStatusPill } from "@/components/subscription-bits";
import { Skeleton } from "@/components/ui/skeleton";
import { RequireActiveTenant } from "./require-active-tenant";

function SubscriptionDetail({ tenantId }: { tenantId: string }) {
  const query = useQuery(portalSubscriptionQuery(tenantId));

  if (query.isPending) return <Skeleton className="h-48 w-full" />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;

  const { subscription } = query.data;
  if (!subscription) {
    return (
      <EmptyState>
        No plan has ever been assigned to this organisation. Contact the CloudBox admin.
      </EmptyState>
    );
  }

  return (
    <div className="rounded-lg border">
      <KeyValue
        rows={[
          ["Plan", subscription.planName ?? subscription.planCode],
          ["Status", <SubscriptionStatusPill key="status" status={subscription.status} />],
          [
            "Validity",
            subscription.validFrom && subscription.validUntil ? (
              <span key="validity" className="flex items-center gap-2">
                <ExpiryPill
                  expiry={subscription.expiry}
                  daysRemaining={subscription.daysRemaining}
                />
                <span className="text-xs text-muted-foreground">
                  {subscription.validFrom.slice(0, 10)} → {subscription.validUntil.slice(0, 10)}
                </span>
              </span>
            ) : (
              <span key="validity" className="text-muted-foreground">
                Starts when your first server is activated
              </span>
            ),
          ],
          [
            "Managed users",
            `${subscription.effectiveMaxManagedUsers} (${subscription.maxManagedUsers} base + ${subscription.addonUsers} add-on)`,
          ],
          ["Price", `${formatMoney(subscription.totalPriceAmount, subscription.currency)} / term`],
        ]}
      />
    </div>
  );
}

export function SubscriptionPage() {
  return (
    <>
      <PageHeader
        title="Subscription"
        description="Read-only — contact the CloudBox admin for changes."
      />
      <div className="pt-4">
        <RequireActiveTenant>
          {(tenantId) => <SubscriptionDetail tenantId={tenantId} />}
        </RequireActiveTenant>
      </div>
    </>
  );
}
